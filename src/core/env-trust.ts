/**
 * Trust boundary for environment variables that Bun auto-loaded from the
 * CURRENT DIRECTORY's `.env` files.
 *
 * Bun merges `.env`, `.env.local` and the `.env.<NODE_ENV>[.local]` variants
 * from the process cwd into process.env before any user code runs — for
 * `bun run` AND for `bun build --compile` binaries alike (verified on Bun
 * 1.3.10). For a globally installed CLI the cwd is arbitrary: any cloned
 * repository can carry a `.env`, so those files are UNTRUSTED input. Bun
 * gives no way to ask which variables came from a file (the merge happens
 * before module load), so this module re-parses the same files and reasons
 * about them. Two guards sit on top of that parse:
 *
 *   - The #427 DATABASE_URL guard (`config.ts:effectiveEnvDatabaseUrl`) is a
 *     VALUE match: the URL is ignored when it equals a cwd-.env assignment.
 *     Running gbrain inside a web-app checkout must not retarget the brain at
 *     that app's database; `GBRAIN_DATABASE_URL` is never auto-ignored.
 *   - The security quarantine below is a KEY-PRESENCE match: a protected key
 *     that any cwd .env file assigns is dropped, whatever its value. Value
 *     matching is unsound for a security list because Bun expands `${VAR}`
 *     inside .env values — `KEY=${PWD}/x` lands in process.env as an absolute
 *     path that never equals the file text.
 *
 * fs/path only — this runs before anything else in the CLI.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The .env names Bun auto-loads from cwd — a superset across NODE_ENV values
 * so the guards don't depend on replicating Bun's exact selection logic.
 */
export const CWD_DOTENV_FILES: readonly string[] = [
  '.env', '.env.local',
  '.env.development', '.env.development.local',
  '.env.production', '.env.production.local',
  '.env.test', '.env.test.local',
];

// `export KEY=...` is accepted so a shell-styled .env still counts as an
// assignment (the guard errs toward "file-origin").
const ASSIGNMENT = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** Every `KEY=<raw rhs>` pair across the cwd .env files in `dir`, in file order. */
function* dotenvAssignments(dir: string): Generator<[key: string, raw: string]> {
  for (const name of CWD_DOTENV_FILES) {
    let content: string;
    try {
      content = readFileSync(join(dir, name), 'utf-8');
    } catch {
      continue; // missing/unreadable file — nothing to guard against
    }
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(ASSIGNMENT);
      if (m) yield [m[1]!, m[2] ?? ''];
    }
  }
}

/**
 * All values assigned to `key` across the .env files in `dir`. Collecting
 * every assignment (rather than emulating override order) keeps the #427
 * guard independent of dotenv precedence rules — a match against ANY
 * assignment means the value is file-origin. Exported for tests.
 */
export function dotenvValuesForKey(key: string, dir: string = process.cwd()): Set<string> {
  const values = new Set<string>();
  for (const [k, raw] of dotenvAssignments(dir)) {
    if (k !== key) continue;
    let v = raw.trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
        (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
      v = v.slice(1, -1);
    } else {
      const hash = v.indexOf(' #');
      if (hash !== -1) v = v.slice(0, hash).trim();
    }
    if (v) values.add(v);
  }
  return values;
}

/**
 * True when ANY cwd .env file in `dir` assigns `key` — the value is ignored
 * (an empty assignment still shadows the key in Bun's loader). This is the
 * predicate the security quarantine and the guardrails loader use.
 */
export function cwdDotenvAssignsKey(key: string, dir: string = process.cwd()): boolean {
  for (const [k] of dotenvAssignments(dir)) {
    if (k === key) return true;
  }
  return false;
}

/**
 * GBRAIN_* variables a cwd `.env` file must never be allowed to set. Each
 * one either makes gbrain load or execute something, relocates its
 * operator-owned roots, or widens a security posture — so a value planted by
 * a cloned repository is never operator intent.
 *
 * Deliberately NOT listed (documented container/service deployments may
 * legitimately co-locate them with the process cwd, and the attack model is
 * a hostile cloned repo, not a serve cwd — SECURITY.md says to launch
 * `serve --http` from a directory you control): GBRAIN_ADMIN_BOOTSTRAP_TOKEN,
 * GBRAIN_HTTP_CORS_ORIGIN, GBRAIN_HTTP_TRUST_PROXY. Deferred for a later
 * decision (TODOS): GBRAIN_DATABASE_URL, GBRAIN_SKILLS_DIR, GBRAIN_RECIPES_DIR,
 * GBRAIN_GITHUB_PAT. `test/env-trust-protected-keys.test.ts` fails when a new
 * suspicious-looking read appears in src/ without a decision here or a
 * `cwd-dotenv-ok:` annotation at the read site.
 */
export const CWD_DOTENV_PROTECTED_KEYS: readonly string[] = [
  // --- code-loading: gbrain import()s the named module -------------------
  'GBRAIN_GUARDRAILS_MODULE',        // guardrail provider module loaded before dispatch
  'GBRAIN_PLUGIN_PATH',              // plugin / skillpack module path
  // --- exec-target: gbrain spawns the named program ------------------------
  'GBRAIN_CLAUDE_CLI_BIN',           // binary run for the claude-cli language model
  'GBRAIN_CLAUDE_CLI_HERMETIC_CONFIG', // becomes that binary's CLAUDE_CONFIG_DIR → its hooks/settings
  'GBRAIN_JOB_CHILD_CLI',            // CLI the job-isolation worker spawns per job
  'GBRAIN_BIN_OVERRIDE',             // gbrain binary used by claw-test
  // --- root / registry redirect ------------------------------------------
  'GBRAIN_HOME',                     // relocates ~/.gbrain (config, .env, keys, registry)
  'GBRAIN_MOUNTS_PATH',              // brain mounts registry file
  // --- posture-widening ----------------------------------------------------
  'GBRAIN_ALLOW_SHELL_JOBS',         // enables the shell job handler (arbitrary exec on the worker)
  'GBRAIN_ALLOW_PRIVATE_REMOTES',    // permits git remotes on private networks
  'GBRAIN_ALLOW_UNVERIFIED_REMOTE',  // skips remote verification on workspace push
  'GBRAIN_GIT_ALLOW_FILE_TRANSPORT', // permits the git file:// transport
  'GBRAIN_ALLOW_MASS_RECONCILE',     // lifts the mass-delete reconcile guard
  'GBRAIN_ALLOW_DEFAULT_WRITE',      // permits writes into the 'default' source
  'GBRAIN_NO_SANITY',                // disables content sanity checks
  'GBRAIN_REMOTE_PRIVATE_PAGES',     // exposes private pages to remote callers
];

export interface QuarantineOpts {
  /** Warning sink; default writes one line to stderr. Injectable for tests. */
  warn?: (line: string) => void;
}

export function formatQuarantineWarning(keys: readonly string[]): string {
  return (
    `[env] Ignoring ${keys.join(', ')} because a .env file in the current directory assigns it — ` +
    'cwd .env files are untrusted for security settings. Export it from your shell or set it ' +
    'in ~/.gbrain/.env.'
  );
}

/**
 * Drop every protected key present in `env` that a cwd .env file in `dir`
 * assigns, and print ONE stderr warning naming them. Returns the dropped keys.
 *
 * Semantics worth knowing:
 *   - Per-process. Every gbrain process re-applies this at startup (via
 *     `cli-preflight.ts`). `delete process.env.X` is NOT seen by children
 *     spawned without an explicit `env` option (verified on Bun 1.3.10) — a
 *     child that must inherit the quarantined view passes `env: process.env`.
 *   - Key presence, not value. A value the operator exported from the shell
 *     is ALSO dropped while a cwd .env assigns the same key: Bun's `${VAR}`
 *     expansion makes the two indistinguishable, and for this fixed security
 *     list a false drop (loud, with the fix in the message) is the safe side.
 *   - Fail-soft on I/O: an unreadable .env is treated as absent.
 */
export function quarantineCwdDotenv(
  env: Record<string, string | undefined> = process.env,
  dir: string = process.cwd(),
  opts: QuarantineOpts = {},
): string[] {
  const present = CWD_DOTENV_PROTECTED_KEYS.filter((k) => env[k] !== undefined);
  if (present.length === 0) return [];
  const assigned = new Set<string>();
  for (const [k] of dotenvAssignments(dir)) assigned.add(k);
  const dropped: string[] = [];
  for (const key of present) {
    if (!assigned.has(key)) continue;
    delete env[key];
    dropped.push(key);
  }
  if (dropped.length > 0) {
    (opts.warn ?? ((line: string) => console.error(line)))(formatQuarantineWarning(dropped));
  }
  return dropped;
}
