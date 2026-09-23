/**
 * v0.43 (#2095) — push-based context: the brain VOLUNTEERS relevant pages
 * from a rolling conversation window instead of waiting to be asked.
 *
 *   window text ─ parseWindow() ─→ turns[] ─ extractCandidatesFromWindow()
 *        │                                       (recency + frequency +
 *        │                                        user-role weights)
 *        ▼
 *   resolveEntitiesToPointers(sourceIds[])    alias 0.9 / title 0.8 /
 *        │                                    slug-suffix 0.6 (+0.05 boost
 *        ▼                                    for ≥2-turn or newest-turn
 *   gate min_confidence (default 0.7) →       mentions)
 *   suppression (slug-only — windowing) →
 *   cap (3 default / 5 max)
 *
 * Zero-LLM, deterministic, precision-biased: push noise is worse than pull
 * silence (#2095). At the default gate, slug-suffix matches (0.6+0.05 < 0.7)
 * never volunteer — they need an explicit lower min_confidence.
 *
 * Consumed by three channels: the volunteer_context op, the retrieval-reflex
 * window path, and `gbrain watch`. Event logging lives in
 * volunteer-events.ts; usage stats here derive "used" from
 * pages.last_retrieved_at — APPROXIMATE by design (the 5-min last-retrieved
 * throttle causes false negatives; unrelated reads cause false positives).
 */

import type { BrainEngine } from '../engine.ts';
import { loadConfig, loadConfigWithEngine } from '../config.ts';
import { normalizeAlias } from '../search/alias-normalize.ts';
import {
  extractCandidatesFromWindow,
  type WindowTurn,
  type WindowEntityCandidate,
} from './entity-salience.ts';
import {
  resolveEntitiesToPointers,
  ARM_CONFIDENCE,
  safeSynopsis,
  type ResolveArm,
  type PointerBlock,
} from './retrieval-reflex.ts';

export const VOLUNTEER_DEFAULT_MAX_PAGES = 3;
export const VOLUNTEER_MAX_PAGES_CAP = 5;
export const VOLUNTEER_DEFAULT_MIN_CONFIDENCE = 0.7;
export const SITUATION_RECALL_BUDGET_MS = 300;
/** Deterministic boost for ≥2-turn or newest-turn mentions. */
export const VOLUNTEER_SALIENCE_BOOST = 0.05;

export interface VolunteeredPage {
  slug: string;
  source_id: string;
  display: string;
  confidence: number;
  arm: ResolveArm | 'situation';
  /** Deterministic template string — never raw conversation text. */
  rationale: string;
  synopsis: string;
}

export interface VolunteerOpts {
  /** Resolved source scope (federated array > scalar — sourceScopeOpts shape). */
  sourceIds: string[];
  /** Prior context (already-surfaced pointers/pages) for slug-only suppression. */
  priorContext?: string;
  /**
   * Slugs to skip BEFORE the confidence gate and the maxPages cap (O(1)
   * membership). `gbrain watch` passes its session-dedupe set here — a
   * post-call filter would let a recurring already-pushed entity consume cap
   * slots every turn and starve new pages behind it (red-team finding).
   */
  excludeSlugs?: ReadonlySet<string>;
  maxPages?: number;
  minConfidence?: number;
  /** v0.46.15: lexical-arms kill switch — see ResolvePointersOpts.lexicalArms. */
  lexicalArms?: boolean;
  deadlineAt?: number;
}

/** Shared wire protocol for window turns — watch.ts imports this so the two
 * channels can never desynchronize on the prefix grammar. */
export const TURN_PREFIX_RE = /^(user|assistant)\s*:\s?(.*)$/i;

/**
 * Lenient window parser: `user:` / `assistant:` line prefixes start a new
 * turn (oldest → newest); unprefixed lines continue the current turn; input
 * with no prefixes at all is ONE user turn (so `echo "..." | volunteer-context`
 * just works). CRLF-tolerant. Empty/whitespace input → [].
 */
export function parseWindow(text: string): WindowTurn[] {
  if (!text || !text.trim()) return [];
  const turns: WindowTurn[] = [];
  let current: WindowTurn | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const m = TURN_PREFIX_RE.exec(rawLine);
    if (m) {
      if (current) turns.push(current);
      current = { role: m[1].toLowerCase() as WindowTurn['role'], text: m[2] ?? '' };
    } else if (current) {
      current.text += (current.text ? '\n' : '') + rawLine;
    } else if (rawLine.trim()) {
      // No prefix seen yet — accumulate into an implicit user turn.
      current = { role: 'user', text: rawLine };
    }
  }
  if (current) turns.push(current);
  // Trim trailing whitespace-only turn bodies.
  return turns
    .map((t) => ({ role: t.role, text: t.text.trim() }))
    .filter((t) => t.text.length > 0);
}

function clampMaxPages(n: number | undefined): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 1) return VOLUNTEER_DEFAULT_MAX_PAGES;
  return Math.min(Math.floor(n), VOLUNTEER_MAX_PAGES_CAP);
}

function rationaleFor(arm: ResolveArm, display: string, c: WindowEntityCandidate | undefined, windowSize: number): string {
  const armText =
    arm === 'alias' ? `alias match "${display}"`
    : arm === 'title' ? `exact title match "${display}"`
    : arm === 'title-surname' ? `surname match "${display}"`
    : arm === 'cjk-title' ? `exact CJK title/slug match "${display}"`
    : `slug match "${display}"`;
  if (!c) return armText;
  const parts = [armText];
  if (c.occurrences >= 2) parts.push(`mentioned in ${c.occurrences} of last ${windowSize} turns`);
  else if (c.inNewestTurn) parts.push('mentioned in the newest turn');
  if (!c.userMention) parts.push('assistant-introduced');
  return parts.join('; ');
}

/** Options for the pure confidence-gate step (see gateVolunteeredPointers). */
export interface GateOpts {
  maxPages?: number;
  minConfidence?: number;
  /** Skipped BEFORE gate + cap — see VolunteerOpts.excludeSlugs. */
  excludeSlugs?: ReadonlySet<string>;
  /** Turn count of the extraction window — feeds the rationale template. */
  windowSize: number;
}

/** Build the norm→candidate provenance map the gate joins pointers against. */
export function candidatesByNorm(candidates: WindowEntityCandidate[]): Map<string, WindowEntityCandidate> {
  const byNorm = new Map<string, WindowEntityCandidate>();
  for (const c of candidates) {
    const norm = normalizeAlias(c.query);
    if (norm && !byNorm.has(norm)) byNorm.set(norm, c);
  }
  return byNorm;
}

/**
 * The pure confidence-gate step: pointer pool in, gated VolunteeredPage[] out.
 * Extracted from volunteerContext so the gate is deterministic, zero-I/O, and
 * directly unit-testable (idempotency pinned in test/volunteer-context.test.ts:
 * gating an already-gated set is a no-op).
 */
export function gateVolunteeredPointers(
  block: PointerBlock,
  byNorm: ReadonlyMap<string, WindowEntityCandidate>,
  opts: GateOpts,
): Array<VolunteeredPage & { arm: ResolveArm }> {
  const maxPages = clampMaxPages(opts.maxPages);
  const minConfidence =
    typeof opts.minConfidence === 'number' && opts.minConfidence >= 0 && opts.minConfidence <= 1
      ? opts.minConfidence
      : VOLUNTEER_DEFAULT_MIN_CONFIDENCE;

  const out: Array<VolunteeredPage & { arm: ResolveArm }> = [];
  for (const p of block.pointers) {
    if (opts.excludeSlugs?.has(p.slug)) continue; // before gate + cap — see VolunteerOpts
    // matchedNorm is the resolver's provenance join-key (the candidate that
    // resolved the pointer); display-based lookup is the fallback for the
    // rare suffix rows where provenance couldn't be recovered.
    const cand = (p.matchedNorm ? byNorm.get(p.matchedNorm) : undefined) ?? byNorm.get(normalizeAlias(p.display));
    const boost = cand && (cand.occurrences >= 2 || cand.inNewestTurn) ? VOLUNTEER_SALIENCE_BOOST : 0;
    const confidence = Math.min(0.99, ARM_CONFIDENCE[p.arm] + boost);
    if (confidence < minConfidence) continue;
    // Collapse whitespace in display at CONSTRUCTION (adversarial review,
    // 2026-09): display comes from brain content (page titles/aliases) and
    // renders into single-line prompt bullets in both lanes — a multi-line
    // title must not be able to forge markdown structure in the injected
    // block. synopsis is already collapse+clip sanitized (safeSynopsis);
    // rationale is template-generated from this sanitized display.
    const display = p.display.replace(/\s+/g, ' ').trim();
    out.push({
      slug: p.slug,
      source_id: p.source_id,
      display,
      confidence,
      arm: p.arm,
      rationale: rationaleFor(p.arm, display, cand, opts.windowSize),
      synopsis: p.synopsis,
    });
    if (out.length >= maxPages) break;
  }
  return out;
}

/**
 * The resolve I/O a volunteer stage needs — structurally compatible with the
 * reflex orchestrator's ResolveEntitiesFn AND a directly-bound
 * resolveEntitiesToPointers closure, without importing either (reflex.ts
 * imports this module; a type import back would be a cycle).
 */
export type VolunteerResolveFn = (
  candidates: WindowEntityCandidate[],
  opts: {
    priorContextText?: string;
    /**
     * CONTRACT (red-team, 2026-09): the resolver MUST honor this cap — the
     * volunteer stage requests a wide ungated pool (VOLUNTEER_MAX_PAGES_CAP*2)
     * so the confidence gate sees every candidate; a resolver that silently
     * applies its own smaller pointer budget reintroduces the gated-out-alias-
     * shadows-a-passing-title bug the wide pool exists to prevent, with no
     * telemetry (host rungs can't log). Host-injected resolvers that ignore
     * `probe` are tolerated; ignoring `maxPointers` is not.
     */
    maxPointers?: number;
    suppression?: 'slug-and-title' | 'slug-only';
    lexicalArms?: boolean;
    /** Telemetry marker: a wide ungated pool resolve for the volunteer gate —
     * delivery loggers must NOT count it as injected pointers. */
    probe?: 'volunteer';
  },
) => Promise<PointerBlock | null>;

export interface VolunteerStageOpts {
  /** Skipped BEFORE gate + cap — typically the turn's already-injected pointer slugs. */
  excludeSlugs?: ReadonlySet<string>;
  priorContextText?: string;
  lexicalArms?: boolean;
  maxPages?: number;
  minConfidence?: number;
  turns?: WindowTurn[];
  recallSituation?: SituationRecallFn;
  deadlineAt?: number;
}

export interface SituationRecallOpts {
  priorContextText?: string;
  excludeSlugs?: ReadonlySet<string>;
  deadlineAt?: number;
}

export type SituationRecallFn = (
  turns: WindowTurn[],
  opts: SituationRecallOpts,
) => Promise<VolunteeredPage | null>;

export async function recallSituationPage(
  engine: BrainEngine,
  turns: WindowTurn[],
  opts: SituationRecallOpts & { sourceIds: string[] },
): Promise<VolunteeredPage | null> {
  const expired = () => opts.deadlineAt !== undefined && Date.now() >= opts.deadlineAt;
  if (!turns.some(turn => turn.text.trim()) || !opts.sourceIds.length || expired()) return null;
  const { loadMemoryCueSettings, memoryCueColumn, unsupportedCueColumn, recallMemoryCues, revalidateMemoryCueCandidates } =
    await import('../memory-cues/index.ts');
  const settings = await loadMemoryCueSettings(engine);
  if (!settings.pushEnabled || settings.pushMinSimilarity === null || expired()) return null;
  const sourceIds = opts.sourceIds.filter(id => settings.sourceIds.includes(id));
  if (!sourceIds.length) return null;
  const column = await memoryCueColumn(engine);
  if (unsupportedCueColumn(column) || expired()) return null;
  const queryTurns: string[] = [];
  let remaining = 8000;
  for (const turn of turns.slice(-4).reverse()) {
    const body = turn.text.trim();
    if (!body) continue;
    const prefix = `${turn.role}: `;
    if (remaining <= prefix.length) break;
    const line = prefix + body.slice(-(remaining - prefix.length));
    queryTurns.unshift(line);
    remaining -= line.length + 1;
  }
  const text = queryTurns.join('\n');
  if (!text) return null;
  const { embedQuery } = await import('../embedding.ts');
  if ((await loadConfigWithEngine(engine))?.embedding_disabled === true || expired()) return null;
  let embedding: Float32Array;
  try {
    embedding = await embedQuery(text, {
      embeddingModel: column.embeddingModel,
      dimensions: column.dimensions,
      ...(opts.deadlineAt !== undefined
        ? { abortSignal: AbortSignal.timeout(Math.max(1, opts.deadlineAt - Date.now())) }
        : {}),
    });
  } catch {
    return null;
  }
  if (expired()) return null;
  if ((await loadConfigWithEngine(engine))?.embedding_disabled === true || expired()) return null;
  const scope = { sourceIds, excludePrivate: true, requireSafeChunks: true, purpose: 'push' as const };
  const recalled = await recallMemoryCues(engine, embedding, {
    ...scope,
    embeddingColumn: column,
    minSimilarity: settings.pushMinSimilarity,
    limit: VOLUNTEER_MAX_PAGES_CAP * 2,
  });
  if (expired()) return null;
  const prior = opts.priorContextText?.toLowerCase() ?? '';
  const candidates = recalled.candidates.filter(candidate => {
    const result = candidate.result;
    return typeof result.source_id === 'string' && sourceIds.includes(result.source_id) && Number.isFinite(candidate.similarity)
      && candidate.similarity >= settings.pushMinSimilarity!
      && !opts.excludeSlugs?.has(result.slug) && !prior.includes(result.slug.toLowerCase());
  });
  const [candidate] = await revalidateMemoryCueCandidates(engine, candidates, scope);
  if (expired() || !candidate) return null;
  if (loadConfig()?.embedding_disabled === true) return null;
  const result = candidate.result;
  if (typeof result.source_id !== 'string' || !sourceIds.includes(result.source_id)) return null;
  return {
    slug: result.slug,
    source_id: result.source_id,
    display: result.title.replace(/\s+/g, ' ').trim(),
    arm: 'situation',
    confidence: candidate.similarity,
    rationale: 'related situation',
    synopsis: (candidate.evidence?.length ?? 0) > 1 ? '' : safeSynopsis({
      slug: result.slug, source_id: result.source_id, title: result.title,
      type: result.type, frontmatter: {}, compiled_truth: result.chunk_text,
    }),
  };
}

/**
 * THE volunteer primitive (2026-08 fix wave, eng-review E1/E2): window
 * candidates in, gated VolunteeredPage[] out, resolve I/O injected. It OWNS
 * its resolve options — slug-only suppression and the wide ungated pool cap —
 * so no caller's seam configuration can skew the stage: volunteerContext
 * (op/watch/turn-context), the production reflex lane, and the BrainBench
 * openclaw adapter all volunteer identically BY CONSTRUCTION. Callers pass
 * only data (resolve closure, candidates, exclusions, prior context).
 */
export async function volunteerStage(
  resolve: VolunteerResolveFn,
  candidates: WindowEntityCandidate[],
  windowSize: number,
  opts: VolunteerStageOpts = {},
): Promise<VolunteeredPage[]> {
  if (!candidates.length && !opts.recallSituation) return [];
  // Resolve up to the hard cap so the confidence gate sees the full pool —
  // a gated-out alias hit must not shadow a passing title hit behind it.
  const block = candidates.length ? await resolve(candidates, {
    priorContextText: opts.priorContextText,
    suppression: 'slug-only',
    maxPointers: VOLUNTEER_MAX_PAGES_CAP * 2,
    lexicalArms: opts.lexicalArms,
    probe: 'volunteer',
  }) : null;

  const pages: VolunteeredPage[] = block ? gateVolunteeredPointers(block, candidatesByNorm(candidates), {
    maxPages: opts.maxPages,
    minConfidence: opts.minConfidence,
    excludeSlugs: opts.excludeSlugs,
    windowSize,
  }) : [];
  if (pages.length >= clampMaxPages(opts.maxPages) || !opts.recallSituation || !opts.turns?.length) return pages;
  if (opts.deadlineAt !== undefined && Date.now() >= opts.deadlineAt) return pages;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = opts.recallSituation(opts.turns, {
      priorContextText: opts.priorContextText,
      excludeSlugs: new Set([...(opts.excludeSlugs ?? []), ...pages.map(p => p.slug)]),
      deadlineAt: opts.deadlineAt,
    });
    const suggestion = opts.deadlineAt === undefined ? await work : await Promise.race([
      work,
      new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), Math.max(0, opts.deadlineAt! - Date.now()));
      }),
    ]);
    if (suggestion?.arm === 'situation' && !opts.excludeSlugs?.has(suggestion.slug)
      && !opts.priorContextText?.toLowerCase().includes(suggestion.slug.toLowerCase())
      && !pages.some(p => p.source_id === suggestion.source_id && p.slug === suggestion.slug)) {
      pages.push({ ...suggestion, rationale: 'related situation' });
    }
  } catch (error) {
    if (!pages.length) throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
  return pages;
}

/**
 * Volunteer confidence-gated pages for a conversation window. Pure read —
 * event logging is the CALLER's job (through the volunteer-events sink).
 * Non-relational, zero-LLM; returns [] when nothing clears the gate.
 * Engine-bound wrapper over volunteerStage (the one implementation).
 */
export async function volunteerContext(
  engine: BrainEngine,
  turns: WindowTurn[],
  opts: VolunteerOpts,
): Promise<VolunteeredPage[]> {
  if (!turns.length || !opts.sourceIds?.length) return [];
  const candidates = extractCandidatesFromWindow(turns);
  return volunteerStage(
    (cands, ropts) =>
      resolveEntitiesToPointers(engine, opts.sourceIds[0], cands, {
        sourceIds: opts.sourceIds,
        priorContextText: ropts.priorContextText,
        suppression: ropts.suppression,
        maxPointers: ropts.maxPointers,
        lexicalArms: ropts.lexicalArms,
      }),
    candidates,
    turns.length,
    {
      excludeSlugs: opts.excludeSlugs,
      priorContextText: opts.priorContext,
      lexicalArms: opts.lexicalArms,
      maxPages: opts.maxPages,
      minConfidence: opts.minConfidence,
      turns,
      recallSituation: (window, situationOpts) => recallSituationPage(engine, window, { ...situationOpts, sourceIds: opts.sourceIds }),
      deadlineAt: opts.deadlineAt ?? Date.now() + SITUATION_RECALL_BUDGET_MS,
    },
  );
}

export function formatVolunteerScore(p: Pick<VolunteeredPage, 'arm' | 'confidence'>): string {
  return `${p.arm === 'situation' ? 'cue similarity ' : ''}${p.confidence.toFixed(2)}`;
}

/**
 * Canonical human rendering of one volunteered page — shared by
 * `gbrain volunteer-context` (cli.ts formatResult) and `gbrain watch` so the
 * two surfaces can't drift.
 */
export function formatVolunteeredPage(p: VolunteeredPage): string {
  return (
    `${p.display} → ${p.slug}${p.arm === 'situation' ? ` (source_id: ${JSON.stringify(p.source_id)})` : ''} (${formatVolunteerScore(p)}, ${p.arm}) — ${p.rationale}` +
    (p.synopsis ? `\n    ${p.synopsis}` : '')
  );
}

// ── Usage stats (the feedback loop) ──────────────────────────────────────

export interface VolunteerArmStats {
  match_arm: string;
  channel: string;
  volunteered: number;
  used: number;
  /** used / volunteered, 0 when nothing volunteered. */
  precision: number;
}

export interface VolunteerUsageStats {
  days: number;
  /** The join is approximate — see the note (false +/- documented in #2095 D9). */
  approximate: true;
  note: string;
  total_volunteered: number;
  total_used: number;
  by_arm: VolunteerArmStats[];
}

export const VOLUNTEER_STATS_NOTE =
  'approximate: "used" = pages.last_retrieved_at > volunteered_at. The 5-min ' +
  'last-retrieved throttle causes false negatives; unrelated reads of the same ' +
  'page cause false positives.';

/**
 * Per-arm/channel precision over the last N days, source-scoped. Read-only;
 * returns zeroed stats on pre-v117 brains (no table).
 */
export async function volunteerUsageStats(
  engine: BrainEngine,
  sourceIds: string[],
  days = 30,
): Promise<VolunteerUsageStats> {
  const safeDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 30;
  let rows: Array<{ match_arm: string; channel: string; volunteered: string | number; used: string | number }> = [];
  try {
    rows = await engine.executeRaw(
      `SELECT e.match_arm, e.channel,
              count(*)::text AS volunteered,
              count(*) FILTER (WHERE p.last_retrieved_at > e.volunteered_at)::text AS used
         FROM context_volunteer_events e
         LEFT JOIN pages p
           ON p.source_id = e.source_id AND p.slug = e.slug AND p.deleted_at IS NULL
        WHERE e.source_id = ANY($1::text[])
          AND e.volunteered_at > now() - ($2 || ' days')::interval
        GROUP BY e.match_arm, e.channel
        ORDER BY e.match_arm, e.channel`,
      [sourceIds, String(safeDays)],
    );
  } catch {
    rows = []; // pre-v117 brain — table doesn't exist yet
  }
  const by_arm: VolunteerArmStats[] = rows.map((r) => {
    const volunteered = Number(r.volunteered);
    const used = Number(r.used);
    return {
      match_arm: r.match_arm,
      channel: r.channel,
      volunteered,
      used,
      precision: volunteered > 0 ? Number((used / volunteered).toFixed(3)) : 0,
    };
  });
  return {
    days: safeDays,
    approximate: true,
    note: VOLUNTEER_STATS_NOTE,
    total_volunteered: by_arm.reduce((s, a) => s + a.volunteered, 0),
    total_used: by_arm.reduce((s, a) => s + a.used, 0),
    by_arm,
  };
}
