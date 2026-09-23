import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { HybridSearchMeta, ResolvedColumn, SearchOpts, SearchResult } from '../../src/core/types.ts';
import type { MemoryCueCandidate, MemoryCueRecall, MemoryCueSettings } from '../../src/core/memory-cues/index.ts';
import { createMemoryCueSearch, MEMORY_CUE_CANDIDATE_LIMIT, MEMORY_CUE_EVIDENCE_CHUNK_LIMIT, memoryCueRerankDocument, selectMemoryCueCandidates } from '../../src/core/search/memory-cues.ts';
import { composeFusionLists } from '../../src/core/search/fusion-lists.ts';
import { cosineReScore, rrfFusionWeighted } from '../../src/core/search/hybrid.ts';
import { applyReranker } from '../../src/core/search/rerank.ts';
import { stampEvidence } from '../../src/core/search/evidence.ts';
import { gradeRetrievalConfidence } from '../../src/core/search/crag.ts';
import { formatResultsExplain } from '../../src/core/search/explain-formatter.ts';
import { RerankError } from '../../src/core/ai/gateway.ts';
import { estimateTokens } from '../../src/core/chunkers/token-estimate.ts';
import { resultTokens } from '../../src/core/search/token-budget.ts';

const column: ResolvedColumn = { name: 'embedding', dimensions: 2, type: 'vector', embeddingModel: 'openai:text-embedding-3-small' };
const queryEmbedding = new Float32Array([1, 0]);
const cueText = 'Planning snacks for a shared outing';

function row(id = 1, source = 'source-a'): SearchResult & { source_id: string } {
  return { source_id: source, slug: `notes/example-${id}`, page_id: id, chunk_id: id,
    chunk_index: 0, chunk_text: 'I cannot eat peanuts.', chunk_source: 'compiled_truth',
    score: 1, type: 'note', title: `Example ${id}`, stale: false };
}

function cue(id = 1, source = 'source-a', similarity = 0.94): MemoryCueCandidate {
  return { result: row(id, source), cueId: `cue-${source}-${id}`, family: 'horizon', similarity, cueText, generation: 'generation-1' };
}

function fixture(mode: MemoryCueSettings['readMode'] = 'on', candidates = [cue()]) {
  const settings: MemoryCueSettings = { generationEnabled: false, sourceIds: ['source-a', 'source-b'], readMode: mode,
    pushEnabled: false, weight: 0.25, minSimilarity: 0.8, pushMinSimilarity: null, families: ['scene', 'horizon'] };
  const calls: Array<{ embedding: Float32Array; opts: unknown }> = [];
  const validations: SearchOpts[] = [];
  const state = { recall: { status: 'ready', candidates } as MemoryCueRecall, valid: candidates };
  const api = {
    loadMemoryCueSettings: async () => ({ ...settings }),
    recallMemoryCues: async (_engine: BrainEngine, embedding: Float32Array, opts: unknown) => {
      calls.push({ embedding, opts });
      return state.recall;
    },
    revalidateMemoryCueCandidates: async (_engine: BrainEngine, input: MemoryCueCandidate[], opts: SearchOpts) => {
      validations.push(opts);
      return input.filter((c) => state.valid.includes(c));
    },
  };
  return { settings, calls, validations, state, api, engine: {} as BrainEngine };
}

function composition(arm?: { list: SearchResult[]; weight: number }, baseline = [row(2)]) {
  return composeFusionLists({ arms: [{ list: baseline, role: 'original' }], keywordFusionList: [], titleFusionList: [],
    relationalList: [], includeRelational: true, memoryCueArm: arm,
    ks: { vectorK: 60, textRrfK: 60, imageRrfK: 60, keywordK: 60, baseRrfK: 60 },
    knobs: { expansionVariantBudget: 1 } });
}

describe('bounded cue arm identity and scope', () => {
  test('all families and windows cast at most one vote per qualified host', () => {
    const best = cue();
    const otherWindow = { ...cue(), cueId: 'scene-duplicate', family: 'scene' as const, similarity: 0.9,
      result: { ...row(), chunk_id: 99 } };
    const namesake = { ...cue(1, 'source-b'), result: { ...row(1, 'source-b'), slug: best.result.slug } };
    const selected = selectMemoryCueCandidates([otherWindow, best, { ...best, family: 'bridge' }, namesake], {}, ['source-a', 'source-b'], 0.8);
    expect(selected).toHaveLength(2);
    expect(selected.find((c) => c.result.source_id === 'source-a')).toBe(best);
    expect(selected.map((c) => c.result.source_id).sort()).toEqual(['source-a', 'source-b']);
    expect(selectMemoryCueCandidates(Array.from({ length: 100 }, (_, i) => cue(i)), {}, ['source-a'], 0.8)).toHaveLength(MEMORY_CUE_CANDIDATE_LIMIT);
  });

  test('empty scopes, explicit enrollment and federated precedence are fail closed', () => {
    const candidates = [cue(), cue(2, 'source-b'), cue(3, 'foreign'), cue(4, 'source-a', 0.7), cue(5, 'source-a', NaN)];
    expect(selectMemoryCueCandidates(candidates, { sourceIds: [] }, ['source-a'], 0.8)).toEqual([]);
    expect(selectMemoryCueCandidates(candidates, { sourceId: 'source-b' }, ['source-a'], 0.8)).toEqual([]);
    expect(selectMemoryCueCandidates(candidates, { sourceId: 'source-a', sourceIds: ['source-b'] }, ['source-a', 'source-b'], 0.8).map((c) => c.result.source_id)).toEqual(['source-b']);
  });

  test('cue votes have one bounded weight and never change baseline capacity or arm weights', async () => {
    const f = fixture();
    const arm = await createMemoryCueSearch(f.engine, {}, f.api);
    await arm.recall(queryEmbedding, column, true);
    const lists = composition(arm);
    expect(lists.slice(0, -1)).toEqual(composition());
    expect(lists.at(-1)).toEqual({ list: arm.list, k: 60, weight: 0.25 });
    const fused = rrfFusionWeighted(lists, false);
    expect(fused.find((r) => r.page_id === 1)?.score).toBeCloseTo(0.25, 12);
    for (const weight of [0, -1, 0.51, NaN, Infinity]) {
      expect(composition({ list: arm.list, weight })).toEqual(composition());
    }
  });
});

describe('cue execution and metadata', () => {
  test('family selection filters API candidates before choosing one vote per host', async () => {
    const horizon = cue();
    const scene = { ...cue(), cueId: 'scene-cue', family: 'scene' as const, similarity: 0.9 };
    const bridge = { ...cue(2), family: 'bridge' as const };
    const f = fixture('on', [horizon, scene, bridge]);
    f.settings.families = ['scene'];
    const arm = await createMemoryCueSearch(f.engine, {}, f.api);
    await arm.recall(queryEmbedding, column, true);
    expect(arm.meta.candidates).toBe(1);
    const final = await arm.revalidate(arm.list);
    expect(final).toHaveLength(1);
    expect(final[0].memory_cue).toMatchObject({ id: 'scene-cue', family: 'scene' });
  });

  test('off does not query cues and shadow never changes result data or ranking', async () => {
    for (const mode of ['off', 'shadow'] as const) {
      const f = fixture(mode);
      const arm = await createMemoryCueSearch(f.engine, {}, f.api);
      await arm.recall(queryEmbedding, column, true);
      expect(arm.list).toEqual([]);
      expect(composition(arm)).toEqual(composition());
      expect(arm.rerankerOptions()).toEqual({});
      const input = [row()];
      expect(await arm.revalidate(input)).toBe(input);
      expect(arm.meta.admitted).toBe(0);
      expect(f.calls).toHaveLength(mode === 'off' ? 0 : 1);
      expect(arm.meta.candidates).toBe(mode === 'off' ? 0 : 1);
    }
  });

  test('uncalibrated, no-embedding, unsupported modality and empty-scope arms do not execute', async () => {
    for (const reason of ['uncalibrated', 'no_embedding', 'unsupported_modality', 'empty_scope', 'not_enrolled']) {
      const f = fixture();
      if (reason === 'uncalibrated') f.settings.minSimilarity = null;
      if (reason === 'not_enrolled') f.settings.sourceIds = [];
      const arm = await createMemoryCueSearch(f.engine, reason === 'empty_scope' ? { sourceIds: [] } : {}, f.api);
      await arm.recall(reason === 'no_embedding' ? null : queryEmbedding, column, reason !== 'unsupported_modality');
      expect(f.calls).toHaveLength(0);
      expect(arm.meta).toMatchObject({ status: 'skipped', reason, candidates: 0, admitted: 0 });
    }
  });

  test('recall receives the original vector, complete signature and exact read policy', async () => {
    const f = fixture();
    const opts: SearchOpts = { sourceIds: ['source-a'], excludePrivate: true, requireSafeChunks: true, type: 'note', limit: 500 };
    const arm = await createMemoryCueSearch(f.engine, opts, f.api);
    await arm.recall(queryEmbedding, column, true);
    expect(f.calls[0]).toEqual({ embedding: queryEmbedding, opts: { ...opts, embeddingColumn: column, limit: MEMORY_CUE_CANDIDATE_LIMIT, minSimilarity: 0.8 } });
    await arm.revalidate(arm.list);
    expect(f.validations).toEqual([opts]);
  });

  test('missing schema and unsupported signatures remain visible without false execution', async () => {
    for (const [status, reason] of [['degraded', 'schema_missing'], ['skipped', 'embedding_signature_changed']] as const) {
      const f = fixture();
      f.state.recall = { candidates: [], status, reason };
      const arm = await createMemoryCueSearch(f.engine, {}, f.api);
      await arm.recall(queryEmbedding, column, true);
      expect(arm.meta).toMatchObject({ status, reason, candidates: 0, admitted: 0 });
      expect(arm.list).toEqual([]);
    }
  });

  test('core database failures propagate rather than becoming empty success', async () => {
    const f = fixture();
    const error = new Error('database unavailable');
    const arm = await createMemoryCueSearch(f.engine, {}, { ...f.api, recallMemoryCues: async () => { throw error; } });
    await expect(arm.recall(queryEmbedding, column, true)).rejects.toBe(error);
    const validating = await createMemoryCueSearch(f.engine, {}, { ...f.api, revalidateMemoryCueCandidates: async () => { throw error; } });
    await validating.recall(queryEmbedding, column, true);
    await expect(validating.revalidate(validating.list)).rejects.toBe(error);
  });
});

describe('cue ranking is separate from source evidence', () => {
  test('cue-aware reranking does not replace independent identity, vector or lexical evidence', () => {
    const result: SearchResult = { ...row(), rerank_score: 0.99, rerank_uses_memory_cue: true, cosine: 0.01 };
    stampEvidence([result]);
    expect(gradeRetrievalConfidence([result]).level).toBe('weak');
    for (const evidence of ['alias_hit', 'exact_title_match', 'high_vector_match'] as const) {
      expect(gradeRetrievalConfidence([{ ...result, evidence }]).level).toBe('strong');
    }
    expect(gradeRetrievalConfidence([{ ...result, evidence: 'keyword_exact' }]).level).toBe('moderate');
    expect(gradeRetrievalConfidence([{ ...result, rerank_uses_memory_cue: undefined }]).level).toBe('strong');
  });

  test('cosine rescoring preserves only the cue vote without inventing source similarity', async () => {
    const f = fixture();
    const arm = await createMemoryCueSearch(f.engine, {}, f.api);
    await arm.recall(queryEmbedding, column, true);
    const lists = composition(arm);
    const fused = rrfFusionWeighted(lists, false);
    const engine = { getEmbeddingsByChunkIds: async () => new Map([[1, new Float32Array([-1, 0])], [2, queryEmbedding]]) } as unknown as BrainEngine;
    const rescored = await cosineReScore(engine, fused, queryEmbedding, 'embedding', arm.rrfShare(lists));
    const associative = rescored.find((r) => r.page_id === 1)!;
    expect(associative.score).toBeCloseTo(0.25, 12);
    expect(associative.cosine).toBe(-1);
    stampEvidence([associative]);
    expect(associative.evidence).not.toBe('high_vector_match');
    expect(associative.create_safety).not.toBe('exists');
    expect(associative.keyword_hit).toBeUndefined();
    expect(associative.chunk_text).toBe(row().chunk_text);
    const overlapLists = composition(arm, [row()]);
    expect(arm.rrfShare(overlapLists)(row())).toBeCloseTo(0.2, 12);
    expect(arm.rrfShare(composition())(row())).toBe(0);
  });

  test('a cue-aware reranker can recover the source but serialized results never contain cue prose', async () => {
    const f = fixture();
    const arm = await createMemoryCueSearch(f.engine, {}, f.api);
    await arm.recall(queryEmbedding, column, true);
    const original = { ...arm.list[0], cosine: 0.01 };
    const input = [row(2), original];
    const docs: string[] = [];
    const ranked = await applyReranker('Arrange snacks for the outing', input, { enabled: true, topNIn: 1, topNOut: null,
      ...arm.rerankerOptions(), rerankerFn: async ({ documents }) => {
        docs.push(...documents);
        return documents.map((text, index) => ({ index, relevanceScore: text.includes(cueText) ? 0.98 : 0.01 })).sort((a, b) => b.relevanceScore - a.relevanceScore);
      } });
    expect(docs).toHaveLength(2);
    expect(docs[1]).toContain('retrieval metadata, not evidence');
    expect(docs[1]).toContain(row().chunk_text);
    expect(ranked[0]).toBe(original);
    expect(ranked[0].cosine).toBe(0.01);
    expect(ranked[0].rerank_uses_memory_cue).toBe(true);
    stampEvidence(ranked);
    expect(gradeRetrievalConfidence(ranked).level).toBe('weak');
    expect(ranked[0].chunk_text).toBe(row().chunk_text);
    const final = await arm.revalidate(ranked);
    expect(final[0].memory_cue).toEqual({ id: cue().cueId, family: 'horizon', similarity: 0.94 });
    expect(arm.meta.admitted).toBe(1);
    const meta = { vector_enabled: true, detail_resolved: 'medium', expansion_applied: false, memory_cues: arm.meta } as HybridSearchMeta;
    expect(JSON.stringify({ final, meta })).not.toContain(cueText);
    expect(formatResultsExplain(final, meta)).not.toContain(cueText);
    expect(Object.values(original)).not.toContain(cueText);
  });

  test('reranker capacity keeps baseline candidates and adds only the bounded cue set without re-pinning', async () => {
    const baseline = Array.from({ length: 5 }, (_, i) => ({ ...row(i + 100), chunk_text: `Baseline ${i}` }));
    const generated = Array.from({ length: 40 }, (_, i) => ({ ...row(i), chunk_text: `Cue ${i}` }));
    let documents: string[] = [];
    const out = await applyReranker('query', [...generated, ...baseline], { enabled: true, topNIn: 5, topNOut: null,
      additionalCandidates: (r) => r.page_id < 100,
      rerankerFn: async (input) => {
        documents = input.documents;
        return input.documents.map((_, index) => ({ index, relevanceScore: 0 })).reverse();
      } });
    expect(documents).toHaveLength(25);
    expect(documents.filter((text) => text.startsWith('Baseline'))).toHaveLength(5);
    expect(out[0].page_id).toBe(104);
  });

  test('long evidence and generated cue documents stay capped without losing the cue block', () => {
    const evidence = { ...row(), chunk_text: '漢字'.repeat(4000) };
    const document = memoryCueRerankDocument(evidence, { ...cue(), cueText: `${cueText} ${'word '.repeat(4000)}` });
    expect(estimateTokens(document)).toBeLessThanOrEqual(1400);
    expect(document.length).toBeLessThanOrEqual(6000);
    expect(document).toContain(cueText);
    expect(evidence.chunk_text).toBe('漢字'.repeat(4000));
  });

  test('no-key failure and disabled reranking preserve the input ordering and text', async () => {
    const f = fixture();
    const arm = await createMemoryCueSearch(f.engine, {}, f.api);
    await arm.recall(queryEmbedding, column, true);
    const input = [row(2), ...arm.list];
    const opts = { enabled: true, topNIn: 1, topNOut: null, ...arm.rerankerOptions(),
      rerankerFn: async () => { throw new RerankError('no key', 'no_key'); } };
    expect(await applyReranker('query', input, opts)).toBe(input);
    expect(await applyReranker('query', input, { ...opts, enabled: false })).toBe(input);
    expect(input.map((r) => r.chunk_text)).toEqual([row().chunk_text, row().chunk_text]);
  });
});

describe('post-await lifecycle guard', () => {
  test('removing a family during reranking excludes it even when the revalidation API returns it', async () => {
    const horizon = cue();
    const scene = { ...cue(2), family: 'scene' as const };
    const f = fixture('on', [horizon, scene]);
    const arm = await createMemoryCueSearch(f.engine, {}, { ...f.api,
      revalidateMemoryCueCandidates: async () => [horizon, scene],
    });
    await arm.recall(queryEmbedding, column, true);
    const ranked = await applyReranker('query', arm.list, { enabled: true, topNIn: 2, topNOut: null, ...arm.rerankerOptions(),
      rerankerFn: async ({ documents }) => {
        f.settings.families = ['scene'];
        return documents.map((_, index) => ({ index, relevanceScore: 1 }));
      } });
    const final = await arm.revalidate(ranked);
    expect(final.map((r) => r.page_id)).toEqual([2]);
    expect(final[0].memory_cue?.family).toBe('scene');
    expect(arm.meta).toMatchObject({ candidates: 2, admitted: 1, reason: 'candidates_invalidated' });
  });

  test('revocation during reranking removes every stale candidate host row', async () => {
    const f = fixture();
    const arm = await createMemoryCueSearch(f.engine, { excludePrivate: true }, f.api);
    await arm.recall(queryEmbedding, column, true);
    const input = [...arm.list, { ...row(), chunk_id: 99 }, row(2)];
    const ranked = await applyReranker('query', input, { enabled: true, topNIn: 3, topNOut: null, ...arm.rerankerOptions(),
      rerankerFn: async ({ documents }) => {
        f.state.valid = [];
        return documents.map((_, index) => ({ index, relevanceScore: 1 }));
      } });
    expect((await arm.revalidate(ranked)).map((r) => r.page_id)).toEqual([2]);
    expect(arm.meta).toMatchObject({ status: 'degraded', reason: 'candidates_invalidated', candidates: 1, admitted: 0 });
  });

  test('read disable, shadow switch and raised calibration revoke admission even when push remains enabled', async () => {
    for (const change of ['off', 'shadow', 'threshold'] as const) {
      const f = fixture();
      const arm = await createMemoryCueSearch(f.engine, {}, f.api);
      await arm.recall(queryEmbedding, column, true);
      f.settings.pushEnabled = true;
      if (change === 'threshold') f.settings.minSimilarity = 0.99;
      else f.settings.readMode = change;
      expect(await arm.revalidate(arm.list)).toEqual([]);
      expect(arm.meta.admitted).toBe(0);
    }
  });

  test('empty-result explain output still exposes a skipped enabled arm', () => {
    const meta = { vector_enabled: false, detail_resolved: null, expansion_applied: false,
      memory_cues: { mode: 'on', status: 'skipped', reason: 'uncalibrated', candidates: 0, admitted: 0 } } as HybridSearchMeta;
    expect(formatResultsExplain([], meta)).toContain('on/skipped (uncalibrated)');
  });
});

describe('complete original evidence groups', () => {
  function groupedCue(): MemoryCueCandidate {
    const anchor = { ...row(), chunk_text: 'I do not take calls ' };
    return { ...cue(), result: anchor, evidence: [anchor, { ...anchor, chunk_id: 2, chunk_index: 1, chunk_text: 'before 10.' }] };
  }

  test('foreign, duplicate, missing-anchor or oversized supporting groups fail closed', () => {
    const c = groupedCue();
    for (const evidence of [[], [c.evidence![1]], [c.result, c.result], [c.result, row(2, 'foreign')],
      Array.from({ length: MEMORY_CUE_EVIDENCE_CHUNK_LIMIT + 1 }, (_, i) => ({ ...c.result, chunk_id: i + 1 }))]) {
      expect(selectMemoryCueCandidates([{ ...c, evidence }], {}, ['source-a'], 0.8)).toEqual([]);
    }
  });

  test('companions arrive as original chunks before the result limit and token budget', async () => {
    const c = groupedCue();
    const f = fixture('on', [c]);
    const arm = await createMemoryCueSearch(f.engine, {}, f.api);
    await arm.recall(queryEmbedding, column, true);
    expect(arm.list).toHaveLength(1);
    const expanded = await arm.expandEvidence([...arm.list, row(3)], async (rows) => rows.map((r) => ({ ...r, cosine: 0.03 })));
    expect(expanded.map((r) => r.chunk_id)).toEqual([1, 2, 3]);
    expect(expanded[1]).toMatchObject({ chunk_text: 'before 10.', score: 0, cosine: 0.03, evidence: 'weak_semantic' });
    const packed = arm.pack(expanded, 0, 2, 100);
    const final = await arm.revalidate(packed.results);
    expect(final.map((r) => r.chunk_text)).toEqual(['I do not take calls ', 'before 10.']);
    expect(final.map((r) => r.memory_cue?.role)).toEqual(['anchor', 'support']);
    expect(final.every((r) => r.memory_cue?.evidence_chunks === 2)).toBe(true);
    expect(arm.meta.admitted).toBe(1);
    expect(packed.meta.used).toBe(final.reduce((n, r) => n + resultTokens(r), 0));
    expect(JSON.stringify(final)).not.toContain(cueText);
  });

  test('a group already in the candidate pool is contiguous without duplicate chunks', async () => {
    const c = groupedCue();
    const f = fixture('on', [c]);
    const arm = await createMemoryCueSearch(f.engine, {}, f.api);
    await arm.recall(queryEmbedding, column, true);
    const existingSupport = { ...c.evidence![1], cosine: 0.07, score: 0.12 };
    const expanded = await arm.expandEvidence([arm.list[0], row(3), existingSupport], async () => { throw new Error('nothing needs hydration'); });
    expect(expanded.map((r) => r.chunk_id)).toEqual([1, 2, 3]);
    expect(expanded[1]).toBe(existingSupport);
    expect(arm.pack(expanded, 0, 2).results).toHaveLength(2);
  });

  test('limit, offset and token truncation cannot turn half a constraint into admitted evidence', async () => {
    for (const [offset, limit, budget] of [[0, 1, 100], [1, 1, 100], [0, 2, 1], [0, 2, 10]]) {
      const f = fixture('on', [groupedCue()]);
      const arm = await createMemoryCueSearch(f.engine, {}, f.api);
      await arm.recall(queryEmbedding, column, true);
      const expanded = await arm.expandEvidence(arm.list, async (rows) => rows);
      const packed = arm.pack(expanded, offset, limit, budget);
      expect(packed.results).toEqual([]);
      expect(packed.meta.used).toBe(0);
      expect(await arm.revalidate(packed.results)).toEqual([]);
      expect(arm.meta).toMatchObject({ admitted: 0, reason: 'evidence_budget_incomplete' });
    }
  });

  test('independent exact lookups retain precedence but never claim incomplete cue support', async () => {
    const c = groupedCue();
    const f = fixture('on', [c]);
    const arm = await createMemoryCueSearch(f.engine, {}, f.api);
    await arm.recall(queryEmbedding, column, true);
    const exact = { ...row(3), exact_lookup: 'slug' as const };
    const expanded = await arm.expandEvidence([exact, ...arm.list], async (rows) => rows);
    expect(arm.pack(expanded, 0, 2).results).toEqual([exact]);
    const exactAnchor = { ...arm.list[0], exact_lookup: 'slug' as const };
    const exactGroup = await arm.expandEvidence([exactAnchor], async (rows) => rows);
    const final = await arm.revalidate(arm.pack(exactGroup, 0, 1).results);
    expect(final).toEqual([exactAnchor]);
    expect(final[0].memory_cue).toBeUndefined();
    expect(arm.meta.admitted).toBe(0);
  });

  test('hard page caps reject the whole cue group but preserve independent typed rows', async () => {
    const c = groupedCue();
    const f = fixture('on', [c]);
    const arm = await createMemoryCueSearch(f.engine, {}, f.api);
    await arm.recall(queryEmbedding, column, true);
    const expanded = await arm.expandEvidence(arm.list, async (rows) => rows);
    expect(arm.pack(expanded, 0, 3, undefined, { maxPerPage: 1 }).results).toEqual([]);
    expect(arm.pack(expanded, 0, 3, undefined, { maxPerPage: 2 }).results).toHaveLength(2);
    const typed = { ...c.evidence![1], relational_seed: 'companies/widget-co' };
    const capped = arm.pack([expanded[0], typed], 0, 3, undefined, { maxPerPage: 1, relationalList: [typed] });
    expect(capped.results).toEqual([typed]);
    expect((await arm.revalidate(capped.results))[0].memory_cue).toBeUndefined();
    expect(arm.meta.admitted).toBe(0);
  });

  test('changed or missing supporting evidence invalidates the entire candidate after awaiting', async () => {
    const c = groupedCue();
    const f = fixture('on', [c]);
    const arm = await createMemoryCueSearch(f.engine, {}, { ...f.api,
      revalidateMemoryCueCandidates: async () => [{ ...c, evidence: [{ ...c.evidence![0] }, { ...c.evidence![1], chunk_text: 'changed constraint' }] }],
    });
    await arm.recall(queryEmbedding, column, true);
    const expanded = await arm.expandEvidence(arm.list, async (rows) => rows);
    expect(await arm.revalidate(arm.pack(expanded, 0, 2).results)).toEqual([]);
    expect(arm.meta).toMatchObject({ admitted: 0, reason: 'candidates_invalidated' });
  });

  test('shadow mode does not expand evidence, repack results or add ranking documents', async () => {
    const f = fixture('shadow', [groupedCue()]);
    const arm = await createMemoryCueSearch(f.engine, {}, f.api);
    await arm.recall(queryEmbedding, column, true);
    const input = [row(3)];
    expect(await arm.expandEvidence(input, async () => { throw new Error('shadow must not hydrate'); })).toBe(input);
    expect(arm.pack(input, 0, 2).results).toEqual(input);
    expect(arm.rerankerOptions()).toEqual({});
  });
});
