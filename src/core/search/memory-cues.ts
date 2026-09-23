import type { BrainEngine } from '../engine.ts';
import type { HybridSearchMeta, ResolvedColumn, SearchOpts, SearchResult } from '../types.ts';
import {
  loadMemoryCueSettings,
  recallMemoryCues,
  revalidateMemoryCueCandidates,
  MAX_CUE_GROUNDING_CHUNKS,
  type MemoryCueCandidate,
} from '../memory-cues/index.ts';
import type { FusionListEntry } from './fusion-lists.ts';
import { capRerankDoc, RERANK_ADDITIONAL_CANDIDATE_LIMIT } from './rerank.ts';
import { stampEvidence, type EvidenceOpts } from './evidence.ts';
import { enforceTokenBudget, resultTokens } from './token-budget.ts';

export const MEMORY_CUE_CANDIDATE_LIMIT = RERANK_ADDITIONAL_CANDIDATE_LIMIT;
export const MEMORY_CUE_EVIDENCE_CHUNK_LIMIT = MAX_CUE_GROUNDING_CHUNKS;

const hostKey = (r: SearchResult): string => JSON.stringify([r.source_id, r.page_id]);
const chunkKey = (r: SearchResult): string => JSON.stringify([r.source_id, r.page_id, r.chunk_id]);
const cueEvidence = (c: MemoryCueCandidate): SearchResult[] => c.evidence ?? [c.result];
const candidateKey = (c: MemoryCueCandidate): string => JSON.stringify([c.cueId, c.generation, c.family, chunkKey(c.result), c.result.chunk_text,
  cueEvidence(c).map((r) => [chunkKey(r), r.chunk_text])]);
const completeEvidence = (c: MemoryCueCandidate, rows: Map<string, SearchResult>): boolean =>
  cueEvidence(c).every((r) => rows.get(chunkKey(r))?.chunk_text === r.chunk_text);
const independentIdentity = (r: SearchResult): boolean => r.exact_lookup !== undefined || r.alias_hit === true || r.relational_pinned === true;

export function selectMemoryCueCandidates(
  candidates: MemoryCueCandidate[],
  opts: SearchOpts,
  sourceIds: string[],
  minSimilarity: number,
): MemoryCueCandidate[] {
  const allowed = new Set(sourceIds.filter((source) => opts.sourceIds !== undefined
    ? opts.sourceIds.includes(source)
    : opts.sourceId === undefined || opts.sourceId === source));
  const seen = new Set<string>();
  return [...candidates]
    .filter((c) => typeof c.result.source_id === 'string' && allowed.has(c.result.source_id)
      && Number.isFinite(c.similarity) && c.similarity >= minSimilarity && c.similarity <= 1
      && cueEvidence(c).length > 0 && cueEvidence(c).length <= MEMORY_CUE_EVIDENCE_CHUNK_LIMIT
      && cueEvidence(c).every((r) => hostKey(r) === hostKey(c.result))
      && cueEvidence(c).some((r) => chunkKey(r) === chunkKey(c.result) && r.chunk_text === c.result.chunk_text)
      && new Set(cueEvidence(c).map(chunkKey)).size === cueEvidence(c).length)
    .sort((a, b) => b.similarity - a.similarity || a.cueId.localeCompare(b.cueId))
    .filter((c) => {
      const key = hostKey(c.result);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MEMORY_CUE_CANDIDATE_LIMIT);
}

export function memoryCueRerankDocument(result: SearchResult, cue: MemoryCueCandidate): string {
  const evidence = capRerankDoc(cue.evidence?.map((r) => r.chunk_text).join('\n') || result.chunk_text || result.title || '', 1000, 4200);
  const cueText = capRerankDoc(cue.cueText, 200, 800);
  return capRerankDoc(`Original source evidence:\n${evidence}\n\nGenerated situation cue (retrieval metadata, not evidence):\n${cueText}`);
}

export async function createMemoryCueSearch(
  engine: BrainEngine,
  opts: SearchOpts,
  api = { loadMemoryCueSettings, recallMemoryCues, revalidateMemoryCueCandidates },
) {
  const settings = await api.loadMemoryCueSettings(engine);
  const meta: NonNullable<HybridSearchMeta['memory_cues']> = {
    mode: settings.readMode,
    status: 'skipped',
    reason: settings.readMode === 'off' ? 'disabled' : 'no_embedding',
    candidates: 0,
    admitted: 0,
  };
  let candidates: MemoryCueCandidate[] = [];
  let byChunk = new Map<string, MemoryCueCandidate>();
  const arm = {
    meta,
    weight: settings.weight,
    list: [] as SearchResult[],
    async recall(embedding: Float32Array | null, column: ResolvedColumn, textRoute: boolean) {
      if (settings.readMode === 'off') return;
      const reason = !textRoute ? 'unsupported_modality'
        : opts.sourceIds?.length === 0 ? 'empty_scope'
        : settings.sourceIds.length === 0 ? 'not_enrolled'
        : settings.minSimilarity === null || !Number.isFinite(settings.minSimilarity) || settings.minSimilarity < -1 || settings.minSimilarity > 1 ? 'uncalibrated'
        : !embedding ? 'no_embedding'
        : undefined;
      if (reason) {
        meta.reason = reason;
        return;
      }
      const recall = await api.recallMemoryCues(engine, embedding!, {
        ...opts,
        embeddingColumn: column,
        limit: MEMORY_CUE_CANDIDATE_LIMIT,
        minSimilarity: settings.minSimilarity!,
      });
      meta.status = recall.status;
      meta.reason = recall.reason;
      if (recall.status !== 'ready') return;
      candidates = selectMemoryCueCandidates(recall.candidates.filter((c) => settings.families.includes(c.family)), opts, settings.sourceIds, settings.minSimilarity!);
      meta.candidates = candidates.length;
      if (candidates.length === 0) meta.status = 'empty';
      if (settings.readMode !== 'on') return;
      byChunk = new Map(candidates.map((c) => [chunkKey(c.result), c]));
      arm.list = candidates.map((c) => ({ ...c.result }));
    },
    rrfShare(lists: FusionListEntry[]): (result: SearchResult) => number {
      const entry = lists.find((l) => l.list === arm.list);
      if (!entry) return () => 0;
      const totals = new Map<string, number>();
      const votes = new Map(arm.list.map((r, rank) => [chunkKey(r), (entry.weight ?? 1) / (entry.k + rank)]));
      if (votes.size > 0) {
        for (const { list, k, weight } of lists) {
          list.forEach((r, rank) => {
            const key = chunkKey(r);
            if (votes.has(key)) totals.set(key, (totals.get(key) ?? 0) + (weight ?? 1) / (k + rank));
          });
        }
      }
      return (r) => (votes.get(chunkKey(r)) ?? 0) / (totals.get(chunkKey(r)) || 1);
    },
    rerankerOptions() {
      if (byChunk.size === 0) return {};
      return {
        additionalCandidates: (r: SearchResult) => byChunk.has(chunkKey(r)),
        documentForResult: (r: SearchResult) => {
          const cue = byChunk.get(chunkKey(r));
          return cue ? memoryCueRerankDocument(r, cue) : r.chunk_text || r.title || '';
        },
      };
    },
    async expandEvidence(results: SearchResult[], rescore: (rows: SearchResult[]) => Promise<SearchResult[]>, evidenceOpts: EvidenceOpts = {}): Promise<SearchResult[]> {
      if (byChunk.size === 0) return results;
      const rows = new Map(results.map((r) => [chunkKey(r), r]));
      if (!candidates.some((c) => cueEvidence(c).length > 1 && rows.has(chunkKey(c.result)))) return results;
      const missing = new Map<string, SearchResult>();
      for (const c of candidates) {
        if (!rows.has(chunkKey(c.result))) continue;
        for (const r of cueEvidence(c)) {
          if (!rows.has(chunkKey(r))) missing.set(chunkKey(r), { ...r, score: 0 });
        }
      }
      const scored = missing.size > 0 ? await rescore([...missing.values()]) : [];
      for (const r of scored) {
        const original = missing.get(chunkKey(r));
        if (original) original.cosine = r.cosine;
      }
      stampEvidence([...missing.values()], evidenceOpts);
      for (const [key, r] of missing) rows.set(key, r);
      const expanded: SearchResult[] = [];
      const emitted = new Set<string>();
      for (const r of results) {
        const c = byChunk.get(chunkKey(r));
        for (const piece of c ? cueEvidence(c) : [r]) {
          const key = chunkKey(piece);
          if (emitted.has(key)) continue;
          emitted.add(key);
          expanded.push(rows.get(key)!);
        }
      }
      return expanded;
    },
    pack(results: SearchResult[], offset: number, limit: number, budget?: number,
      caps: { maxPerPage?: number; relationalList?: SearchResult[] } = {}) {
      if (byChunk.size === 0) {
        const sliced = results.slice(offset, offset + limit);
        return { ...enforceTokenBudget(sliced, budget), sliced };
      }
      const requestedCap = Math.ceil(caps.maxPerPage ?? 2);
      const maxPerPage = Number.isNaN(requestedCap) ? 0 : Math.max(0, requestedCap);
      const cueHosts = new Set(candidates.map((c) => hostKey(c.result)));
      const relationalHosts = new Set((caps.relationalList ?? []).map(hostKey));
      const typedKeys = new Set((caps.relationalList ?? []).map(chunkKey));
      const relationalRows = new Map<string, SearchResult>();
      for (const r of results.slice(offset, offset + limit)) {
        const key = hostKey(r);
        if (!relationalHosts.has(key)) continue;
        const prior = relationalRows.get(key);
        if (!prior || (!typedKeys.has(chunkKey(prior)) && typedKeys.has(chunkKey(r)))) relationalRows.set(key, r);
      }
      const protectedKeys = new Set([...relationalRows.values()].map(chunkKey));
      const preserve = (r: SearchResult) => independentIdentity(r) || protectedKeys.has(chunkKey(r));
      const reserved = new Map<string, number>();
      for (const r of results) {
        if (preserve(r)) reserved.set(hostKey(r), Math.min(maxPerPage, (reserved.get(hostKey(r)) ?? 0) + 1));
      }
      const counts = new Map<string, number>();
      const capped = results.filter((r) => {
        const key = hostKey(r);
        if (!cueHosts.has(key)) return true;
        const count = counts.get(key) ?? 0;
        const remaining = reserved.get(key) ?? 0;
        if (count >= maxPerPage || (!preserve(r) && count + remaining >= maxPerPage)) return false;
        counts.set(key, count + 1);
        if (preserve(r)) reserved.set(key, Math.max(0, remaining - 1));
        return true;
      });
      const sliced = capped.slice(offset, offset + limit);
      const packed = enforceTokenBudget(sliced, budget);
      const rows = new Map(packed.results.map((r) => [chunkKey(r), r]));
      const inputKeys = new Set(results.map(chunkKey));
      const incomplete = candidates.filter((c) => inputKeys.has(chunkKey(c.result)) && !completeEvidence(c, rows));
      const incompleteKeys = new Set(incomplete.flatMap((c) => cueEvidence(c).map(chunkKey)));
      const kept = packed.results.filter((r) => !incompleteKeys.has(chunkKey(r)) || preserve(r));
      const cappedKeys = new Set(capped.map(chunkKey));
      const capRejected = incomplete.some((c) => cueEvidence(c).some((r) => inputKeys.has(chunkKey(r)) && !cappedKeys.has(chunkKey(r))));
      if (kept.length !== packed.results.length || capRejected) {
        meta.status = 'degraded';
        meta.reason = capRejected ? 'evidence_page_cap' : 'evidence_budget_incomplete';
      }
      return { sliced, results: kept, meta: { ...packed.meta, used: kept.reduce((n, r) => n + resultTokens(r), 0),
        kept: kept.length, dropped: sliced.length - kept.length } };
    },
    async revalidate(results: SearchResult[]): Promise<SearchResult[]> {
      if (candidates.length === 0) return results;
      const current = await api.loadMemoryCueSettings(engine);
      const valid = current.readMode !== settings.readMode || current.minSimilarity === null
        ? []
        : await api.revalidateMemoryCueCandidates(engine, candidates.filter((c) => current.families.includes(c.family) && c.similarity >= current.minSimilarity!), opts);
      const validIds = new Set(valid.filter((c) => current.families.includes(c.family)).map(candidateKey));
      const invalidHosts = new Set(candidates.filter((c) => !validIds.has(candidateKey(c))).map((c) => hostKey(c.result)));
      if (invalidHosts.size > 0) {
        meta.status = 'degraded';
        meta.reason = 'candidates_invalidated';
      }
      if (settings.readMode !== 'on') return results;
      const kept = results.filter((r) => !invalidHosts.has(hostKey(r)));
      const rows = new Map(kept.map((r) => [chunkKey(r), r]));
      const complete = candidates.filter((c) => validIds.has(candidateKey(c)) && completeEvidence(c, rows));
      const byEvidence = new Map(complete.flatMap((c) => cueEvidence(c).map((r) => [chunkKey(r), c] as const)));
      meta.admitted = complete.length;
      return kept.map((r) => {
        const cue = byEvidence.get(chunkKey(r));
        return cue ? { ...r, memory_cue: { id: cue.cueId, family: cue.family, similarity: cue.similarity,
          ...(cueEvidence(cue).length > 1 ? { role: chunkKey(r) === chunkKey(cue.result) ? 'anchor' as const : 'support' as const,
            evidence_chunks: cueEvidence(cue).length } : {}) } } : r;
      });
    },
  };
  return arm;
}
