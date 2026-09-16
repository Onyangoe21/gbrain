/**
 * secret-scan.ts — pattern-based secret detection for USER workspaces
 * (agent-bootstrap plan: ENG-9 as amended by CX2-15, S3#2, D6).
 *
 * Consumers: `gbrain sources push` (block-before-commit gate), bootstrap
 * verify, and the transcript-corpus writer (redact-in-place via
 * `redactFindings`).
 *
 * TWO SCAN POLICIES EXIST DELIBERATELY [CX2-15]: `.gitleaks.toml` is CI
 * fixture policy for THIS public repo (test/, skills/ are allowlisted there
 * because they hold synthetic fixtures). Importing that allowlist here would
 * blind the runtime scanner to real secrets under a user's personal-repo
 * `skills/` tree. This module therefore ships an EMPTY default allowlist
 * plus a per-workspace override file (`<ws>/.gbrain-scan-allow`, one
 * glob-or-fingerprint per line, `#` comments).
 *
 * Every surface prints the one canonical token `<REDACTED:pattern>` [ENG-9]:
 * finding previews render through `redactSecretsInText`, the corpus writer
 * (`redactFindings`) splices the same token over each claimed span — neither
 * ever contains the secret value, and this module never returns raw matched
 * values.
 *
 * The generic high-entropy assignment heuristic is OFF by default (opt-in
 * via `ScanOpts.highEntropy`) — named-prefix patterns are precise; the
 * entropy heuristic trades false positives for recall and is a caller
 * decision, not a default.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { isAbsolute, join, relative, sep } from 'path';
import { createHash } from 'crypto';
import { redactSecretsInText } from './minions/handlers/shell-redact.ts';

// ── Types ───────────────────────────────────────────────────────────────────

export interface SecretFinding {
  /** Pattern name, e.g. 'openai', 'github_token', 'private_key_pem'. */
  pattern: string;
  /** 1-based line number within the scanned text/file. */
  line: number;
  /** Line excerpt with the secret replaced by `<REDACTED:pattern>` — NEVER the value. */
  redactedPreview: string;
  /**
   * `sha256:<first-16-hex>` of the matched value. The allowlist key: paste
   * this line into `<ws>/.gbrain-scan-allow` to accept a specific finding.
   */
  fingerprint: string;
  /** Set by scanFiles: the path the finding came from (as given by the caller). */
  file?: string;
}

export interface ScanOpts {
  /**
   * Allowlist entries (globs or `sha256:<hex-prefix>` fingerprints). Default
   * EMPTY [CX2-15] — callers merge in `loadWorkspaceAllowlist(root)`.
   */
  allowlist?: string[];
  /** Workspace root: allowlist path-globs match paths relative to this. */
  workspaceRoot?: string;
  /** Opt-in generic high-entropy assignment heuristic. Default false. */
  highEntropy?: boolean;
}

/** Name of the per-workspace allowlist override file. */
export const SCAN_ALLOW_FILENAME = '.gbrain-scan-allow';

// ── Patterns ────────────────────────────────────────────────────────────────
//
// Each core pattern is compiled with a left boundary group `(^|[^A-Za-z0-9_])`
// so prefixes embedded inside longer identifiers ("risk-assessment…",
// "task-…") never fire. Order matters: 'anthropic' precedes 'openai' and the
// per-line claimed-span set prevents a `sk-ant-…` key from double-reporting
// as a generic `sk-` match.
//
// FORMAT-BASED, not prefix-only. Credentials without a vendor prefix (a JWT,
// an account SID, a connection string carrying its password) are matched on
// their WIRE SHAPE. Fixed-length shapes carry a trailing negative lookahead so
// a longer alphanumeric run (a digest, an identifier) is not cut into a
// false "key". The two CATCH-ALLS (`bearer`, `db_url_credentials`) are
// appended LAST on purpose: the per-line claimed-span dedupe is first-wins,
// so `Bearer <vendor key>` keeps its vendor attribution and a JWT used as a
// URL password attributes once.

interface CompiledPattern {
  name: string;
  re: RegExp; // 'g' flags; group 1 = boundary, group 2 = the secret value
  /** When true, a match must also pass the Shannon-entropy gate. */
  entropyGated?: boolean;
  /** See CorePattern.precheck. */
  precheck?: (line: string) => boolean;
}

interface CorePattern {
  name: string;
  source: string;
  /**
   * When true, `source` already carries the two-group layout (group 1 =
   * boundary/anchor, group 2 = value) and is compiled as-is instead of being
   * wrapped in the default left-boundary group. Used when the anchor is a
   * literal keyword (e.g. `Bearer `) that must NOT be part of the value.
   */
  prebuilt?: boolean;
  /**
   * Cheap substring gate run BEFORE the regex on every line: when it returns
   * false the line cannot contain a match and the regex is skipped. Used by
   * the catch-alls, whose alternation + negated classes are the costliest
   * shapes here and whose anchor (`earer`, `@`) is a one-call `includes`.
   */
  precheck?: (line: string) => boolean;
}

const CORE_PATTERNS: ReadonlyArray<CorePattern> = [
  { name: 'anthropic', source: 'sk-ant-[A-Za-z0-9_-]{16,}' },
  // Prefixed OpenAI forms (sk-proj-/sk-svcacct-/sk-None-) allow `_`/`-` in the
  // body, which the bare sk- pattern below deliberately does not. Ordered
  // before it so the claimed-span dedupe attributes the whole key here.
  { name: 'openai', source: 'sk-(?:proj|svcacct|None)-[A-Za-z0-9_-]{20,}' },
  { name: 'openai', source: 'sk-[A-Za-z0-9]{20,}' },
  // Voyage key shape mirrors PROVIDER_KEY_SHAPES in bootstrap/interview.ts.
  { name: 'voyage', source: 'pa-[A-Za-z0-9_-]{20,}' },
  { name: 'github_pat', source: 'github_pat_[A-Za-z0-9_]{22,}' },
  { name: 'github_token', source: 'gh[pousr]_[A-Za-z0-9]{36,}' },
  { name: 'gitlab_pat', source: 'glpat-[A-Za-z0-9_-]{20,}' },
  { name: 'slack', source: 'xox[baprs]-[A-Za-z0-9-]{10,}' },
  // Long-lived (AKIA) and temporary/STS (ASIA) access-key ids: fixed 16 after
  // the prefix, hard right edge.
  { name: 'aws_access_key', source: '(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Za-z])' },
  { name: 'google_api_key', source: 'AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])' },
  // Stripe secret/restricted keys + webhook signing secrets.
  { name: 'stripe', source: '[sr]k_(?:live|test)_[0-9a-zA-Z]{20,}' },
  { name: 'stripe', source: 'whsec_[A-Za-z0-9]{24,}' },
  { name: 'sendgrid', source: 'SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}' },
  // Twilio account SID (AC) / API signing key SID (SK): 32 hex, hard right
  // edge so a longer hex digest that happens to start with AC never matches.
  { name: 'twilio', source: '(?:AC|SK)[0-9a-fA-F]{32}(?![0-9A-Za-z])' },
  // Supabase secret (sb_secret_) and management/personal access (sbp_) keys.
  // Deliberately NOT here: `sb_publishable_` (public by design) and the
  // project ref (hostname label or `project_ref=` assignment) — identifiers,
  // not credentials.
  { name: 'supabase_key', source: 'sb_secret_[A-Za-z0-9_-]{20,}' },
  { name: 'supabase_key', source: 'sbp_[a-f0-9]{40}(?![0-9A-Za-z])' },
  { name: 'npm_token', source: 'npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])' },
  { name: 'huggingface', source: 'hf_[A-Za-z0-9]{30,}' },
  // gbrain's own tokens: generateToken (core/utils.ts) mints 'gbrain_' plus an
  // optional OAuth infix (at_ access / rt_ refresh / cs_ client secret /
  // code_ auth code) plus 32 random bytes hex. Without this entry the scanner
  // redacts every vendor's keys but ships its own live tokens — MCP client
  // tooling prints the Authorization header verbatim into session logs, and
  // transcript ingest carries it into pages. gbrain_cl_ client ids are public
  // identifiers, deliberately not listed here.
  { name: 'gbrain_token', source: 'gbrain_(?:at_|rt_|cs_|code_)?[0-9a-f]{64}' },
  // JWT: three base64url segments (header.payload.signature). No vendor
  // prefix — this is the wire format of many service-role / session
  // credentials, so it is matched on shape. Same source as the PII family in
  // eval-capture-scrub.ts; secret-scan is the owner for redaction lanes.
  //
  // Prebuilt so the left boundary can exclude `-` as well as `_`: the value
  // class contains both, so with the default boundary every `-` in a run like
  // `-eyJ-eyJ-eyJ…` was a fresh start that consumed to end-of-line and
  // backtracked — quadratic (a 200 KB run took ~25 s). Each segment is also
  // bounded at 4096 so a start that never finds its `.` does constant work.
  // A JWT immediately preceded by `-` is not a realistic wire shape (headers,
  // JSON, URLs and env files put whitespace, a quote, `=`, `:` or `/` in
  // front of it); a segment over 4096 chars is the accepted miss.
  {
    name: 'jwt',
    source:
      '(^|[^A-Za-z0-9_-])' +
      '(eyJ[A-Za-z0-9_-]{8,4096}\\.[A-Za-z0-9_-]{8,4096}\\.[A-Za-z0-9_-]{8,4096})',
    prebuilt: true,
  },
  // ── Catch-alls: LAST, so vendor/JWT attribution above claims the span first.
  // Bearer: prebuilt two-group layout — the `Bearer ` keyword is the anchor
  // (group 1), only the token is the value (group 2), so the redacted text
  // reads `Bearer <REDACTED:bearer>` and the fingerprint is the token's.
  // RFC 7235 auth-scheme names are case-insensitive; the three spellings
  // seen on the wire (`Bearer`, `bearer`, `BEARER`) are accepted, and the
  // precheck tests both suffix spellings so an all-caps header line is not
  // skipped before the regex runs.
  {
    name: 'bearer',
    source: '((?:^|[^A-Za-z0-9_])[Bb](?:earer|EARER)\\s+)([A-Za-z0-9._~+/=-]{20,})',
    prebuilt: true,
    precheck: (line) => line.includes('earer') || line.includes('EARER'),
  },
  // Connection strings with inline credentials: the value is exactly the
  // scheme://user:pass@ span (an empty user is allowed — a redis URL whose
  // userinfo is just a colon and the password still fires),
  // so the host/db survive redaction for context. Database schemes only;
  // `https://user@host` never fires. Literal example spellings are avoided
  // in this comment on purpose (scripts/check-pg-url-redaction.sh).
  //
  // Both userinfo segments are BOUNDED (user 0-128, password 1-256). The
  // user segment stops at `:` and `/`; the password stops ONLY at whitespace,
  // `@` and the two string delimiters `"` `'`. Everything else is a legal
  // password character — every sub-delim (`!$&()*+,;=`), `:`, `%XX` escapes,
  // and the characters real (copy-pasted, unescaped) passwords carry: `/`
  // from base64, `{` `}` `<` `>` `|` `^` `\` and backtick. An earlier cut
  // excluded those on RFC 3986 grounds and let every such password through
  // unredacted, which is the wrong side of the trade for a redaction lane.
  // The cost is that `scheme://host:port/path@x` (an `@` inside a path) now
  // reads as a credential — a rare, harmless over-redaction.
  //
  // The old unbounded `[^\s@]+` ran to the end of the line and backtracked
  // once per scheme occurrence: quadratic on long @-free lines (a 250 KB
  // minified JSON line of credential-less redis URLs took ~4 s, 160 KB of
  // repeated `redis://:` ~5.6 s, 1 MB minutes). It ALSO turned a
  // credential-less URL followed within 256 chars by any `@` (an email in
  // the same minified JSON object) into a bogus finding, because the string
  // delimiters between them were legal password characters — excluding `"`
  // and `'` is what ends that run at the URL's closing quote; the LENGTH
  // bounds, not the exclusions, are the ReDoS fix. With the bounds the work
  // per scheme occurrence is a constant; the precheck skips the regex on
  // lines with no `@` at all. A password over 256 chars is the accepted miss
  // (a JWT that long is still claimed by `jwt` above).
  {
    name: 'db_url_credentials',
    source:
      '(?:postgres(?:ql)?|mysql|mongodb(?:\\+srv)?|redis|rediss|amqp|mssql):\\/\\/' +
      '[^\\s:/@"\']{0,128}:[^\\s@"\']{1,256}@',
    precheck: (line) => line.includes('@'),
  },
  // NOTE: private_key_pem is NOT here — a PEM key spans multiple lines and the
  // per-line scanner below cannot see the base64 body. It is matched over the
  // WHOLE text by PEM_BLOCK_RE (see scanPemBlocks) so redaction covers the
  // body+footer, not just the header line.
];

/**
 * Whole-block PEM private key: header + (optional) base64 body + (optional)
 * footer, matched multiline. The header-only pattern used to leave the base64
 * body in the redacted corpus (the redaction replaced only the header line);
 * matching the whole span means the key body is scrubbed. The body+footer are
 * OPTIONAL so a lone/truncated header (a body-only leak, or a header with no
 * END) still fires the push-block gate — value is then just the header. The
 * lazy body stops at the first END marker so two adjacent keys don't collapse
 * into one span. `-----BEGIN CERTIFICATE-----` never matches (the literal
 * `PRIVATE KEY` is required).
 *
 * The body is BOUNDED at 16384 chars (PEM_BODY_MAX_CHARS). The unbounded lazy
 * `[\s\S]*?` scanned from every header to the end of the text when no END
 * followed — quadratic on header-without-END texts (2000 header-only mentions
 * ahead of a 1 MB tail took ~4 s). With the bound a header does constant
 * work; a real key is far smaller (an RSA-4096 PEM is ~3.3 KB, RSA-16384
 * ~12.5 KB). A body longer than the bound degrades to the header-only match —
 * the gate still fires, the body is the accepted miss.
 */
export const PEM_BODY_MAX_CHARS = 16384;
export const PEM_BLOCK_RE = new RegExp(
  `-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\\s\\S]{0,${PEM_BODY_MAX_CHARS}}?-----END [A-Z ]*PRIVATE KEY-----)?`,
  'g',
);

// Opt-in: `secret|token|password|api key`-shaped assignment whose value has
// high Shannon entropy. Keyword-anchored (compiled inline below so the group
// layout matches the core patterns: group 1 = anchor, group 2 = value).
//
// The left boundary is [^A-Za-z0-9] rather than the core patterns'
// [^A-Za-z0-9_]: `_` has to read as a SEPARATOR here, or `api_access_token`
// and `SMTP_PASSWORD` cannot match their own keyword. The core patterns keep
// `_` as a word character on purpose (a vendor prefix inside a longer
// identifier must not fire); this rule is keyword-anchored, so the same
// reasoning inverts. The keyword is also allowed trailing identifier
// segments before the assignment, or `AWS_SECRET_ACCESS_KEY=` cannot match:
// the keyword `SECRET` is not adjacent to the `=`, `_ACCESS_KEY` is. The
// entropy gate still decides, so a wider anchor costs nothing on prose.
//
// The value floor is 12, not 20. A 16-character SMTP password sat under the
// old floor and stayed plaintext in the receipt on disk even once the keyword
// matched — the value length was doing gating the entropy check is there to
// do. Real passwords are frequently 12-16 characters; secrets that long with
// 3.5 bits/char of entropy are not prose.
//
// The value must ALSO contain at least one digit. Identifier-shaped values
// (`DefaultAzureCredential`, `/usr/local/bin/aws-vault`, an env-var NAME
// assigned to an `apiKeyEnvVar`) clear the entropy gate on mixed case and
// separators alone and were being redacted out of ordinary code. Real
// machine-minted secrets essentially always carry digits; a digitless
// passphrase is the accepted miss. A 40-hex git sha assigned to a `token:`
// key still redacts (digits + entropy) — documented, acceptable.
//
// Both quantifiers after the keyword are BOUNDED. The trailing identifier
// segments used to be `[A-Za-z0-9_-]*`: because the left boundary admits `-`
// and `_` and that class contains them too, every `-`/`_` in a run like
// `-apikey-apikey…` or `_token_token…` was a fresh keyword start whose
// suffix ran to end-of-line and backtracked — quadratic (210 KB of
// `-apikey` took ~35 s, 180 KB of `_token` ~15 s). At `{0,64}` a start does
// constant work; no real credential key carries 64 identifier characters
// after its keyword. The value is capped at 4096 for the same
// constant-work-per-occurrence guarantee (the jwt segments share the cap):
// a value longer than that is redacted only through its first 4096 chars —
// the accepted miss, well above any real token or base64 key blob.
const HIGH_ENTROPY_MIN_BITS_PER_CHAR = 3.5;
const HIGH_ENTROPY_REQUIRES_DIGIT_RE = /[0-9]/;

function compilePatterns(opts: ScanOpts): CompiledPattern[] {
  const out: CompiledPattern[] = CORE_PATTERNS.map((p) => ({
    name: p.name,
    re: new RegExp(p.prebuilt ? p.source : `(^|[^A-Za-z0-9_])(${p.source})`, 'g'),
    ...(p.precheck ? { precheck: p.precheck } : {}),
  }));
  if (opts.highEntropy) {
    // Group layout matches the core shape: group 1 = boundary (empty here,
    // the keyword anchor plays that role), group 2 = value. We wrap the
    // keyword part into group 1 so span math stays uniform.
    out.push({
      name: 'high_entropy_assignment',
      re: new RegExp(
        `((?:^|[^A-Za-z0-9])(?:secret|token|passwd|password|passphrase|credential|api[_-]?key|apikey)[A-Za-z0-9_-]{0,64}["']?\\s*[:=]\\s*["']?)([A-Za-z0-9+/_=-]{12,4096})`,
        'gi',
      ),
      entropyGated: true,
    });
  }
  return out;
}

/** Shannon entropy in bits/char. Exported for tests. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

// ── Allowlist ───────────────────────────────────────────────────────────────

/**
 * Load `<workspaceRoot>/.gbrain-scan-allow`: one glob-or-fingerprint per
 * line, `#` comments and blank lines ignored. Absent/unreadable file → []
 * (the shipped default allowlist is EMPTY [CX2-15]).
 */
export function loadWorkspaceAllowlist(workspaceRoot: string): string[] {
  try {
    const p = join(workspaceRoot, SCAN_ALLOW_FILENAME);
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * Minimal anchored glob → RegExp. `**` crosses `/`, `*` stays within a path
 * segment, `?` is one non-slash char. Shared by the scan allowlist and the
 * workspace-push deny-glob backstop (one glob dialect everywhere).
 */
const GLOB_REGEX_CACHE = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const cached = GLOB_REGEX_CACHE.get(glob);
  if (cached) return cached;
  let g = glob;
  if (g.endsWith('/')) g += '**'; // `foo/` means everything under foo/
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          re += '(?:.*/)?';
          i++;
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  const compiled = new RegExp(`^${re}$`);
  GLOB_REGEX_CACHE.set(glob, compiled);
  return compiled;
}

/**
 * Gitignore-flavored match: a glob WITHOUT `/` matches the basename at any
 * depth (`*.pem` catches `sub/dir/key.pem`); a glob WITH `/` is anchored at
 * the workspace root (`.gbrain/**`). Paths are normalized to `/` separators.
 */
export function matchesGlob(glob: string, relPath: string): boolean {
  const norm = relPath.split(sep).join('/');
  if (!glob.includes('/')) {
    const base = norm.slice(norm.lastIndexOf('/') + 1);
    return globToRegExp(glob).test(base);
  }
  return globToRegExp(glob).test(norm);
}

function isFingerprintEntry(entry: string): boolean {
  return entry.startsWith('sha256:');
}

/**
 * Minimum fingerprint-prefix length (hex chars) an allowlist entry must carry
 * to suppress a finding. 16 hex = 64 bits: an 8-hex (32-bit) floor was low
 * enough that a short allowlist entry could collide with an UNRELATED secret's
 * hash and silently un-report it. The emitted fingerprint is exactly 16 hex,
 * so a copy-pasted fingerprint still matches at the floor.
 */
export const ALLOWLIST_FINGERPRINT_MIN_HEX = 16;

/**
 * True when the full sha256 hex of a matched value is allowlisted (≥16-hex
 * prefix). Exported so the sensitivity scan (context/sensitivity-scan.ts)
 * honors the SAME `.gbrain-scan-allow` fingerprint mechanics for its
 * non-secret families (PII, blocklist, pattern-file) — one escape hatch,
 * one dialect.
 */
export function valueAllowlisted(fullHex: string, allowlist: string[]): boolean {
  for (const entry of allowlist) {
    if (!isFingerprintEntry(entry)) continue;
    const prefix = entry.slice('sha256:'.length).toLowerCase();
    if (prefix.length >= ALLOWLIST_FINGERPRINT_MIN_HEX && fullHex.startsWith(prefix)) return true;
  }
  return false;
}

/** True when a file path is allowlisted by any glob entry. */
export function pathAllowlisted(relPath: string, allowlist: string[]): boolean {
  return allowlist.some((entry) => !isFingerprintEntry(entry) && matchesGlob(entry, relPath));
}

// ── Scanning ────────────────────────────────────────────────────────────────

/** One claimed span on a line: where `value` starts within the line text. */
interface LineSpan {
  pattern: string;
  value: string;
  start: number;
}

/**
 * The claimed spans of one scanned line, shared BY REFERENCE between that
 * line's hits (appended to while the line is still being scanned), so
 * buildPreview can redact a hit's neighbours and snap its window to whole
 * spans.
 */
interface LineSpans {
  /** Discovery order (pattern-major). */
  all: LineSpan[];
  /** Lazily built by buildPreview: `all` sorted by `start`. */
  byStart?: LineSpan[];
}

interface RawHit extends LineSpan {
  line: number; // 1-based
  /** Absolute offset of `value` within the scanned text (redactFindings splices on it). */
  abs: number;
  lineText: string;
  spans: LineSpans;
}

/**
 * Whole-text PEM private-key pass. Runs over the FULL text (not per-line) so
 * the base64 body between header and footer is part of the matched value and
 * therefore gets redacted, never left behind. `lineText` is set to the whole
 * matched block so buildPreview / redactSecretsInText replace the entire span
 * with `<REDACTED:private_key_pem>`.
 *
 * The 1-based header line is counted INCREMENTALLY: a running cursor walks
 * the text between consecutive hits (global exec yields them in ascending
 * index order), so the pass is O(text) overall. Recomputing it per hit with
 * `text.slice(0, m.index).split('\n')` was O(hits × text).
 */
function scanPemBlocks(text: string): RawHit[] {
  const hits: RawHit[] = [];
  PEM_BLOCK_RE.lastIndex = 0;
  let cursor = 0;
  let line = 1;
  let m: RegExpExecArray | null;
  while ((m = PEM_BLOCK_RE.exec(text)) !== null) {
    const value = m[0];
    if (value.length === 0) {
      PEM_BLOCK_RE.lastIndex++; // zero-width safety
      continue;
    }
    for (let nl = text.indexOf('\n', cursor); nl !== -1 && nl < m.index; nl = text.indexOf('\n', nl + 1)) {
      line++;
    }
    cursor = m.index;
    const span: LineSpan = { pattern: 'private_key_pem', value, start: 0 };
    hits.push({ ...span, line, abs: m.index, lineText: value, spans: { all: [span] } });
  }
  return hits;
}

function scanInternal(text: string, opts: ScanOpts): RawHit[] {
  const patterns = compilePatterns(opts);
  // PEM blocks first: their full-span value must be redacted before any
  // per-line replacement can touch the region (base64 bodies never match the
  // named patterns, so order is a belt-and-suspenders guarantee).
  const hits: RawHit[] = scanPemBlocks(text);
  const lines = text.split('\n');
  // No per-line length cap, deliberately: a secret on a 1 MB minified line
  // must still be found and redacted, so long lines are scanned in full.
  // What keeps that bounded is (a) every pattern doing constant work per
  // candidate occurrence — the shapes whose value class could otherwise run
  // to end-of-line and backtrack (db_url_credentials, jwt,
  // high_entropy_assignment, and PEM_BLOCK_RE over the whole text) carry
  // bounded quantifiers, and jwt's boundary excludes `-` so a `-` run is
  // never a fresh start — and (b) each catch-all's `precheck`, a substring
  // test that skips its regex on lines without the anchor. The first-wins
  // overlap check is O(value) per hit (claimed-char bitmap) and the preview
  // window is O(log hits) per hit (binary search over the sorted spans), so
  // a line with tens of thousands of hits costs O(hits × value), not
  // O(hits²) — and preview rendering is windowed (buildPreview), not
  // O(hits × line).
  //
  // `offset` is the absolute start of the current line (the `+ 1` is the
  // `\n` split away); each hit records `abs = offset + start` so
  // redactFindings can splice the text once instead of searching it per
  // value.
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineStart = offset;
    offset += line.length + 1;
    if (line.length < 8) continue;
    const spans: LineSpans = { all: [] };
    // Claimed-character bitmap behind the first-wins dedupe: allocated on the
    // line's FIRST hit only (most lines have none), then O(value) to test and
    // to mark. Same answer as scanning every prior span for an intersection.
    let taken: Uint8Array | null = null;
    for (const p of patterns) {
      if (p.precheck && !p.precheck(line)) continue;
      p.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = p.re.exec(line)) !== null) {
        const value = m[2];
        const start = m.index + m[1].length;
        const end = start + value.length;
        // Zero-width safety: never loop forever on a pathological pattern.
        if (m[0].length === 0) p.re.lastIndex++;
        if (taken && anyTaken(taken, start, end)) continue;
        if (p.entropyGated && !HIGH_ENTROPY_REQUIRES_DIGIT_RE.test(value)) continue;
        if (p.entropyGated && shannonEntropy(value) < HIGH_ENTROPY_MIN_BITS_PER_CHAR) continue;
        (taken ??= new Uint8Array(line.length)).fill(1, start, end);
        spans.all.push({ pattern: p.name, value, start });
        hits.push({ pattern: p.name, value, start, abs: lineStart + start, line: i + 1, lineText: line, spans });
      }
    }
  }
  return hits;
}

/** True when any character in [start, end) is already claimed. */
function anyTaken(taken: Uint8Array, start: number, end: number): boolean {
  for (let k = start; k < end; k++) if (taken[k]) return true;
  return false;
}

const PREVIEW_MAX_CHARS = 160;
/** Raw context kept before / after the hit when the line is longer than the preview. */
const PREVIEW_CONTEXT_BEFORE = 40;
const PREVIEW_CONTEXT_AFTER = 80;

/**
 * Render the finding preview. ENG-9: rendered through redactSecretsInText
 * for the canonical `<REDACTED:name>` token — a value never survives into a
 * preview.
 *
 * Only a WINDOW around the hit is rendered, never the whole line: a
 * minified/bundled line can run to hundreds of KB, and redacting the full
 * line once per hit was O(hits × line) (5000 tokens on one 190 KB line took
 * ~2.6 s; 41 ms one-per-line). Lines that fit the preview are rendered whole,
 * so the short-line output is unchanged.
 *
 * Two leak guards on the window: (1) EVERY claimed span on the line that
 * falls inside it is redacted, longest value first, so a preview never
 * carries a sibling secret from the same line; (2) the window's edges snap
 * OUTWARD to the boundary of any span they would cut through, so a
 * neighbouring occurrence is redacted whole instead of leaving a fragment
 * at the edge. Ellipses mark whichever edges were cut.
 */
function buildPreview(hit: RawHit): string {
  const { lineText, value, start, pattern } = hit;
  const end = start + value.length;
  let winStart = 0;
  let winEnd = lineText.length;
  if (lineText.length > PREVIEW_MAX_CHARS) {
    winStart = Math.max(0, start - PREVIEW_CONTEXT_BEFORE);
    winEnd = Math.min(lineText.length, end + PREVIEW_CONTEXT_AFTER);
  }
  // Spans never overlap each other (claimed-span dedupe), so sorted by start
  // they are sorted by end too: binary-search the first span ending after
  // winStart, walk while spans begin before winEnd. Snapping an edge to a
  // span boundary cannot pull a further span into the window — one pass.
  const byStart = (hit.spans.byStart ??= [...hit.spans.all].sort((a, b) => a.start - b.start));
  let lo = 0;
  let hi = byStart.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const sp = byStart[mid]!;
    if (sp.start + sp.value.length <= winStart) lo = mid + 1;
    else hi = mid;
  }
  const inWindow: Array<readonly [string, string]> = [];
  for (let i = lo; i < byStart.length; i++) {
    const span = byStart[i]!;
    if (span.start >= winEnd) break;
    const e = span.start + span.value.length;
    if (span.start < winStart) winStart = span.start;
    if (e > winEnd) winEnd = e;
    inWindow.push([span.pattern, span.value]);
  }
  inWindow.sort((a, b) => b[1].length - a[1].length);
  let redacted = redactSecretsInText(lineText.slice(winStart, winEnd), inWindow).trim();
  let cutLeft = winStart > 0;
  let cutRight = winEnd < lineText.length;
  if (redacted.length > PREVIEW_MAX_CHARS) {
    const at = Math.max(0, redacted.indexOf(`<REDACTED:${pattern}>`));
    const from = Math.max(0, at - PREVIEW_CONTEXT_BEFORE);
    const to = Math.min(redacted.length, from + PREVIEW_MAX_CHARS);
    cutLeft ||= from > 0;
    cutRight ||= to < redacted.length;
    redacted = redacted.slice(from, to);
  }
  return `${cutLeft ? '…' : ''}${redacted}${cutRight ? '…' : ''}`;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** `file` is stamped by scanFiles on the way out, not here. */
function toFinding(hit: RawHit, fullHex: string): SecretFinding {
  return {
    pattern: hit.pattern,
    line: hit.line,
    redactedPreview: buildPreview(hit),
    fingerprint: `sha256:${fullHex.slice(0, 16)}`,
  };
}

/**
 * Scan a text blob. Returns findings with redacted previews — never raw
 * values. Fingerprint-allowlisted values are dropped; path-glob allowlist
 * entries only apply in `scanFiles` (they need a file path).
 */
export function scanText(text: string, opts: ScanOpts = {}): SecretFinding[] {
  const allowlist = opts.allowlist ?? [];
  const out: SecretFinding[] = [];
  for (const hit of scanInternal(text, opts)) {
    const fullHex = sha256Hex(hit.value);
    if (valueAllowlisted(fullHex, allowlist)) continue;
    out.push(toFinding(hit, fullHex));
  }
  return out;
}

/** Bytes to sniff for NUL when deciding content is binary. */
export const BINARY_SNIFF_BYTES = 8192;

/** scanFiles skips anything larger (the push gate applies the same cap). */
export const SCAN_MAX_FILE_BYTES = 25 * 1024 * 1024;

/** True when the first BINARY_SNIFF_BYTES of the buffer contain a NUL byte. */
export function looksBinaryBuffer(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function looksBinary(path: string): boolean {
  try {
    // small files dominate; callers size-cap first
    return looksBinaryBuffer(readFileSync(path));
  } catch {
    return true; // unreadable → skip like a binary
  }
}

/**
 * Scan files on disk. Unreadable and binary (NUL-sniffed) files are skipped.
 * When `opts.workspaceRoot` is set, allowlist path-globs are matched against
 * each file's path relative to that root; fingerprint entries apply as in
 * `scanText`. `finding.file` carries the path exactly as the caller gave it.
 */
export function scanFiles(paths: string[], opts: ScanOpts = {}): SecretFinding[] {
  const allowlist = opts.allowlist ?? [];
  const out: SecretFinding[] = [];
  for (const p of paths) {
    try {
      if (!existsSync(p)) continue;
      const st = statSync(p);
      if (!st.isFile() || st.size > SCAN_MAX_FILE_BYTES) continue;
    } catch {
      continue;
    }
    const rel =
      opts.workspaceRoot && isAbsolute(p) ? relative(opts.workspaceRoot, p) : p;
    if (pathAllowlisted(rel, allowlist)) continue;
    if (looksBinary(p)) continue;
    let text: string;
    try {
      text = readFileSync(p, 'utf-8');
    } catch {
      continue;
    }
    for (const f of scanText(text, opts)) {
      out.push({ ...f, file: p });
    }
  }
  return out;
}

/**
 * Corpus-write mode [S3#2]: replace every CLAIMED span in place with
 * `<REDACTED:pattern>` and report what was redacted. Allowlisted values are
 * left intact — the user declared them safe. Returns the redacted text plus
 * one finding per original occurrence (`redactions` keeps scan order: PEM
 * blocks, then line order).
 *
 * The output is rebuilt by SPAN-SPLICE, O(text + hits): every hit carries its
 * absolute offset from scanInternal, the spans are sorted by offset, and the
 * text between consecutive spans is copied through once. The previous
 * implementation ran one full-text `replaceAll` per unique (pattern, value)
 * pair — O(unique values × text): a 1 MB transcript with ~5k unique
 * high-entropy values took ~3-5 s to redact after a ~70 ms scan.
 *
 * SEMANTIC DELTA (deliberate): `replaceAll` also scrubbed a claimed value at
 * positions the scanner did NOT claim — the same bytes embedded inside a
 * longer identifier, or a bare re-occurrence that no pattern anchors (an
 * opaque bearer token repeated without its `Bearer ` keyword). The splice
 * redacts exactly the claimed spans, so `redactFindings(text).text` now
 * agrees byte-for-byte with what `scanText(text)` reports: the corpus write
 * and the push gate see the same findings. A value that recurs on two lines
 * is two claimed spans and both are redacted; a value that is a substring of
 * another claimed value is moot, because claimed spans never overlap (the
 * per-line bitmap dedupe keeps them disjoint) — the longest-first ordering
 * the replaceAll form needed no longer exists.
 *
 * Per-line spans are disjoint from each other by construction; a per-line
 * span can only overlap a whole-text PEM block (a bearer value whose class
 * admits `-` running into the block's `-----BEGIN`). The splice handles that
 * by emitting the uncovered tail of the later span as its own token rather
 * than skipping it, so nothing claimed is ever left in the output.
 */
export function redactFindings(
  text: string,
  opts: ScanOpts = {},
): { text: string; redactions: SecretFinding[] } {
  const allowlist = opts.allowlist ?? [];
  const redactions: SecretFinding[] = [];
  const claimed: Array<{ abs: number; end: number; pattern: string }> = [];
  for (const hit of scanInternal(text, opts)) {
    const fullHex = sha256Hex(hit.value);
    if (valueAllowlisted(fullHex, allowlist)) continue;
    redactions.push(toFinding(hit, fullHex));
    claimed.push({ abs: hit.abs, end: hit.abs + hit.value.length, pattern: hit.pattern });
  }
  if (claimed.length === 0) return { text, redactions };
  claimed.sort((a, b) => a.abs - b.abs);
  const parts: string[] = [];
  let cur = 0;
  for (const c of claimed) {
    if (c.end <= cur) continue; // fully inside an already-emitted span
    if (c.abs > cur) parts.push(text.slice(cur, c.abs));
    parts.push(`<REDACTED:${c.pattern}>`);
    cur = c.end;
  }
  parts.push(text.slice(cur));
  return { text: parts.join(''), redactions };
}
