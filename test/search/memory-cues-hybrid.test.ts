import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch, hybridSearchCached, type HybridSearchOpts } from '../../src/core/search/hybrid.ts';
import { cueSignature, memoryCueColumn, runMemoryCueBuild, submitMemoryCueBuild } from '../../src/core/memory-cues/index.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { gradeRetrievalConfidence } from '../../src/core/search/crag.ts';
import type { HybridSearchMeta, SearchOpts } from '../../src/core/types.ts';

const QUERY = 'arrange food for the group outing';
const CUE = 'Choosing snacks for a shared outing';
const SOURCE = 'I cannot eat peanuts.';
const SLUG = 'notes/food-constraint-example';
const DIM = 1536;
const embedding = (axis: number) => Float32Array.from({ length: DIM }, (_, i) => i === axis ? 1 : 0);
let engine: PGLiteEngine;

async function seed(slug: string, title: string, text: string, sourceId = 'default') {
  await engine.putPage(slug, { type: 'note', title, compiled_truth: text }, { sourceId });
  await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: text,
    embedding: embedding(text === SOURCE ? 1 : 0) }], { sourceId });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const [key, value] of Object.entries({
    embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: String(DIM), chat_model: 'openai:gpt-4o-mini',
    embedding_columns: JSON.stringify({ embedding: { provider: 'openai:text-embedding-3-large', dimensions: DIM, type: 'vector' } }),
    'memory.cues.generation_enabled': 'true', 'memory.cues.sources': '["default","source-b"]',
    'memory.cues.read': 'off', 'memory.cues.min_similarity': '0.8',
  })) await engine.setConfig(key, value);
  await engine.setConfig('memory.cues.read_calibration_signature', cueSignature(await memoryCueColumn(engine)));
  await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES('source-b','Source B','{}'::jsonb)");
  await seed(SLUG, 'Dietary note', SOURCE);
  await seed(SLUG, 'Foreign dietary note', SOURCE, 'source-b');
  await seed('notes/outing-plan-example', 'Outing plan', 'Arrange food for the group outing and prepare a picnic checklist.');
  const receipt = await submitMemoryCueBuild(engine, { sourceIds: ['default', 'source-b'], pageLimit: 3, maxUsd: 1, trustedLocal: true });
  const built = await runMemoryCueBuild(engine, { buildId: receipt.buildId, providers: {
    generate: async ({ evidence }) => ({ output: evidence.includes(SOURCE) ? [{ family: 'horizon',
      relation: 'explicit_constraint_applies', quote: SOURCE, text: CUE }] : [], actualUsd: 0 }),
    embed: async (texts) => texts.map(() => embedding(0)),
  } });
  expect(built).toMatchObject({ status: 'complete', windowsProcessed: 3 });
}, 120_000);

afterAll(async () => { await engine.disconnect(); });

function reranker(onCall?: () => Promise<void>): SearchOpts['reranker'] {
  return { enabled: true, topNIn: 10, topNOut: null, rerankerFn: async ({ documents }) => {
    await onCall?.();
    return documents.map((text, index) => ({ index, relevanceScore: text.includes(CUE) ? 0.99 : text.includes('picnic checklist') ? 0.7 : 0.01 }))
      .sort((a, b) => b.relevanceScore - a.relevanceScore);
  } };
}

async function search(mode: 'off' | 'shadow' | 'on', overrides: Partial<HybridSearchOpts> = {}, query = QUERY, cached = false) {
  await engine.setConfig('memory.cues.read', mode);
  let meta: HybridSearchMeta | undefined;
  const options: HybridSearchOpts = { sourceId: 'default', limit: 5, expansion: false, relationalRetrieval: false,
    graph_signals: false, salience: 'off', recency: 'off', detail: 'medium', autocut: false,
    intentWeighting: false, queryEmbedFn: () => embedding(0), reranker: reranker(), onMeta: (value) => { meta = value; }, ...overrides };
  const results = await (cached ? hybridSearchCached : hybridSearch)(engine, query, options);
  return { results, meta };
}

describe('production hybrid cue recall with real PGLite and stubbed providers', () => {
  test('an indirect query reaches original evidence without elevating raw evidence or CRAG confidence', async () => {
    const off = await search('off');
    expect(off.results[0].slug).toBe('notes/outing-plan-example');
    expect(off.meta?.memory_cues).toMatchObject({ mode: 'off', status: 'skipped', reason: 'disabled', candidates: 0, admitted: 0 });
    const on = await search('on');
    expect(on.meta?.memory_cues).toMatchObject({ mode: 'on', status: 'ready', candidates: 1, admitted: 1 });
    expect(on.results[0]).toMatchObject({ slug: SLUG, source_id: 'default', chunk_text: SOURCE, cosine: 0,
      evidence: 'weak_semantic', create_safety: 'unknown', rerank_uses_memory_cue: true });
    expect(on.results[0].memory_cue?.similarity).toBeCloseTo(1);
    expect(gradeRetrievalConfidence(on.results).level).toBe('weak');
    expect(JSON.stringify(on)).not.toContain(CUE);
  });

  test('shadow executes lookup but is byte-identical to off for every returned result', async () => {
    const off = await search('off');
    const shadow = await search('shadow');
    expect(shadow.results).toEqual(off.results);
    expect(shadow.meta?.memory_cues).toMatchObject({ mode: 'shadow', status: 'ready', candidates: 1, admitted: 0 });
  });

  test('the cached public entry point preserves execution metadata and original evidence', async () => {
    const on = await search('on', {}, QUERY, true);
    expect(on.results[0].chunk_text).toBe(SOURCE);
    expect(on.meta?.memory_cues).toMatchObject({ mode: 'on', status: 'ready', candidates: 1, admitted: 1 });
    expect(JSON.stringify(on)).not.toContain(CUE);
  });

  test('exact title lookup remains rank one even when the cue-aware reranker prefers another page', async () => {
    const on = await search('on', {}, 'Outing plan');
    expect(on.meta?.memory_cues?.admitted).toBe(1);
    expect(on.results[0].slug).toBe('notes/outing-plan-example');
    expect(on.results[0].exact_lookup).toBeDefined();
  });

  test('federated scope keeps both namesakes distinct and empty scopes admit no cues', async () => {
    const federated = await search('on', { sourceIds: ['default', 'source-b'] });
    expect(federated.results.filter((r) => r.slug === SLUG).map((r) => r.source_id).sort()).toEqual(['default', 'source-b']);
    expect(federated.meta?.memory_cues).toMatchObject({ candidates: 2, admitted: 2 });
    const empty = await search('on', { sourceIds: [] });
    expect(empty.results.some((r) => r.memory_cue)).toBe(false);
    expect(empty.meta?.memory_cues).toMatchObject({ status: 'skipped', reason: 'empty_scope', admitted: 0 });
    const foreign = await search('on', { sourceIds: ['source-b'] });
    expect(foreign.results.every((r) => r.source_id === 'source-b')).toBe(true);
  });

  test('fifty repeated cues cannot crowd another qualified host out of the bounded arm', async () => {
    const duplicateIds = await engine.executeRaw<{ id: string }>(`INSERT INTO memory_cues
      (id,window_id,page_id,chunk_id,signature,family,relation,cue_text,quote,embedding,embedding_half)
      SELECT gen_random_uuid(),c.window_id,c.page_id,c.chunk_id,c.signature,c.family,c.relation,c.cue_text,c.quote,c.embedding,c.embedding_half
      FROM memory_cues c JOIN pages p ON p.id=c.page_id CROSS JOIN generate_series(1,50)
      WHERE p.source_id='default' AND p.slug=$1 RETURNING id`, [SLUG]);
    const lower = embedding(0);
    lower[0] = 0.98;
    lower[1] = Math.sqrt(1 - 0.98 ** 2);
    await engine.executeRaw("UPDATE memory_cues SET embedding=$1::vector WHERE page_id IN (SELECT id FROM pages WHERE source_id='source-b')", [`[${Array.from(lower)}]`]);
    try {
      const on = await search('on', { sourceIds: ['default', 'source-b'] });
      expect(on.meta?.memory_cues).toMatchObject({ candidates: 2, admitted: 2 });
      expect(on.results.filter((r) => r.memory_cue).map((r) => r.source_id).sort()).toEqual(['default', 'source-b']);
    } finally {
      await engine.executeRaw('DELETE FROM memory_cues WHERE id=ANY($1::uuid[])', [duplicateIds.map((r) => r.id)]);
      await engine.executeRaw("UPDATE memory_cues SET embedding=$1::vector WHERE page_id IN (SELECT id FROM pages WHERE source_id='source-b')", [`[${Array.from(embedding(0))}]`]);
    }
  });

  test('per-call shape filters govern the cue arm', async () => {
    const excluded = await search('on', { exclude_slugs: [SLUG] });
    expect(excluded.meta?.memory_cues?.candidates).toBe(0);
    const future = await search('on', { since: '2099-01-01' });
    expect(future.meta?.memory_cues?.candidates).toBe(0);
    const wrongType = await search('on', { type: 'company' });
    expect(wrongType.meta?.memory_cues?.candidates).toBe(0);
  });

  test('enabled cues never add embedding calls to the keyless path', async () => {
    const keyless = await search('on', { queryEmbedFn: undefined });
    expect(keyless.meta?.vector_enabled).toBe(false);
    expect(keyless.meta?.memory_cues).toMatchObject({ mode: 'on', status: 'skipped', reason: 'no_embedding', candidates: 0, admitted: 0 });
    expect(keyless.results.some((r) => r.memory_cue)).toBe(false);
  });

  test('turning read off during the reranker await removes the candidate despite independent push enablement', async () => {
    await engine.setConfig('memory.cues.push', 'true');
    try {
      const on = await search('on', { reranker: reranker(async () => { await engine.setConfig('memory.cues.read', 'off'); }) });
      expect(on.results.some((r) => r.slug === SLUG)).toBe(false);
      expect(on.meta?.memory_cues).toMatchObject({ status: 'degraded', reason: 'candidates_invalidated', admitted: 0 });
    } finally {
      await engine.setConfig('memory.cues.push', 'false');
    }
  });

  test('model rotation during reranking invalidates cue-derived candidates', async () => {
    const previous = await engine.getConfig('embedding_columns');
    let rotationVerified = false;
    try {
      const on = await search('on', { reranker: reranker(async () => {
        await engine.setConfig('embedding_columns', JSON.stringify({ embedding: { provider: 'openai:text-embedding-3-small', dimensions: DIM, type: 'vector' } }));
        expect(await memoryCueColumn(engine)).toMatchObject({ embeddingModel: 'openai:text-embedding-3-small', dimensions: DIM });
        rotationVerified = true;
      }) });
      expect(rotationVerified).toBe(true);
      expect(on.results.some((r) => r.slug === SLUG)).toBe(false);
      expect(on.meta?.memory_cues).toMatchObject({ reason: 'candidates_invalidated', admitted: 0 });
    } finally {
      if (previous === null) await engine.unsetConfig('embedding_columns');
      else await engine.setConfig('embedding_columns', previous);
    }
  });

  test('a page edit during reranking cannot leak the old source snippet after final validation', async () => {
    const on = await search('on', { reranker: reranker(async () => {
      await engine.putPage(SLUG, { type: 'note', title: 'Revised dietary note', compiled_truth: 'The previous restriction is withdrawn.' }, { sourceId: 'default' });
    }) });
    expect(on.results.some((r) => r.slug === SLUG)).toBe(false);
    expect(JSON.stringify(on)).not.toContain(SOURCE);
    expect(on.meta?.memory_cues).toMatchObject({ reason: 'candidates_invalidated', admitted: 0 });
  });
});
