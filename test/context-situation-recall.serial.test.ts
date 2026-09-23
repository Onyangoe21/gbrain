import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { installPageProjection, readProjectionSnapshot } from '../src/core/page-state/projections.ts';
import { runMemoryCueBuild, submitMemoryCueBuild, recallMemoryCues, memoryCueColumn, cueSignature } from '../src/core/memory-cues/index.ts';
import { volunteerContext, volunteerStage, recallSituationPage, formatVolunteeredPage, SITUATION_RECALL_BUDGET_MS } from '../src/core/context/volunteer.ts';
import { extractCandidatesFromWindow, type WindowTurn } from '../src/core/context/entity-salience.ts';
import { assembleTurnContext } from '../src/core/context/turn-context.ts';
import { buildReflexAddition } from '../src/core/context/reflex.ts';
import { bindResolveIpcForServe, type ResolveIpcBinding } from '../src/mcp/resolve-ipc-binding.ts';
import { requestSituationRecall, requestTurnContext, readIpcSecretForConfig, resolveSocketPath, startResolveIpcServer } from '../src/core/context/resolve-ipc.ts';
import { runHook } from '../src/commands/hook.ts';
import { runWatch } from '../src/commands/watch.ts';
import { __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';
import type { PointerBlock } from '../src/core/context/retrieval-reflex.ts';

const BODY = 'I do not take calls before ten.';
const CUE = 'CUE_ONLY_SENTINEL choosing a time to talk';
const SLUG = 'notes/morning-constraint';
const WINDOW: WindowTurn[] = [{ role: 'user', text: 'do it?' }];
const ENV = ['GBRAIN_HOME', 'GBRAIN_SOURCE', 'GBRAIN_MEMORY_CUES_PUSH', 'GBRAIN_RETRIEVAL_REFLEX',
  'GBRAIN_RETRIEVAL_REFLEX_VOLUNTEER', 'GBRAIN_SERVE_SYNC_IPC', 'GBRAIN_HOOKS'] as const;
let engine: PGLiteEngine;
let dir: string;
let saved: Record<string, string | undefined>;
let binding: ResolveIpcBinding | undefined;
let embedCalls: string[][];
let beforeEmbed: (() => Promise<void>) | undefined;
let queryVector: Float32Array;

function vector(index = 0): Float32Array {
  const result = new Float32Array(1536);
  result[index] = 1;
  return result;
}

async function seed(sourceId = 'default', slug = SLUG, body = BODY, title = 'Morning constraint') {
  if (sourceId !== 'default') await engine.executeRaw(
    'INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [sourceId]);
  await engine.putPage(slug, { type: 'note', title, compiled_truth: body, frontmatter: {}, timeline: '' }, { sourceId });
  const snapshot = await readProjectionSnapshot(engine, slug, sourceId, { allowUnsealed: true });
  expect(snapshot).not.toBeNull();
  await installPageProjection(engine, snapshot!, [{ chunk_index: 0, chunk_source: 'compiled_truth',
    chunk_text: body, model: 'text-embedding-3-large', modality: 'text' }], { seal: true });
}

async function build(sourceIds = ['default']) {
  await engine.setConfig('memory.cues.sources', JSON.stringify(sourceIds));
  const receipt = await submitMemoryCueBuild(engine, { sourceIds, trustedLocal: true, maxUsd: 2 });
  const result = await runMemoryCueBuild(engine, { buildId: receipt.buildId, providers: {
    generate: async ({ evidence }) => ({ actualUsd: 0.001, output: [{ family: 'horizon',
      relation: 'explicit_constraint_applies', quote: evidence, text: CUE }] }),
    embed: async texts => texts.map(() => vector()),
  } });
  expect(result).toMatchObject({ status: 'complete' });
  expect(result.windowsProcessed).toBeGreaterThan(0);
}

async function listen() {
  const dataDir = join(dir, 'data');
  mkdirSync(join(dir, '.gbrain'), { recursive: true });
  writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: dataDir }));
  binding = await bindResolveIpcForServe(engine, 'default');
  expect(binding.server).not.toBeNull();
  const cfg = { engine: 'pglite' as const, database_path: dataDir };
  return { cfg, socket: resolveSocketPath(dataDir), secret: readIpcSecretForConfig(cfg)! };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => { await engine.disconnect(); });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-situation-'));
  saved = {};
  for (const key of ENV) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env.GBRAIN_HOME = dir;
  process.env.GBRAIN_SERVE_SYNC_IPC = '0';
  await engine.executeRaw('DELETE FROM memory_cue_builds');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw("UPDATE sources SET archived=false");
  await engine.executeRaw("DELETE FROM config WHERE key LIKE 'memory.cues.%'");
  await engine.setConfig('memory.cues.generation_enabled', 'true');
  await engine.setConfig('memory.cues.push', 'true');
  await engine.setConfig('memory.cues.push_min_similarity', '0.9');
  await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');
  await engine.setConfig('embedding_dimensions', '1536');
  await engine.setConfig('memory.cues.push_calibration_signature', cueSignature(await memoryCueColumn(engine)));
  await engine.setConfig('chat_model', 'openai:gpt-4o-mini');
  resetGateway();
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'test-only' } });
  embedCalls = [];
  beforeEmbed = undefined;
  queryVector = vector();
  __setEmbedTransportForTests(async ({ values }) => {
    embedCalls.push([...values] as string[]);
    await beforeEmbed?.();
    return { embeddings: values.map(() => [...queryVector]), usage: { tokens: 1 } } as any;
  });
  __resetHotMemoryCacheForTests();
  await seed();
  await build();
});

afterEach(async () => {
  binding?.close(); binding = undefined;
  __setEmbedTransportForTests(null);
  resetGateway();
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('situation volunteering through production cue recall', () => {
  test('no entity candidates yields one source pointer and safe evidence, never cue prose', async () => {
    expect(extractCandidatesFromWindow(WINDOW)).toHaveLength(0);
    const pages = await volunteerContext(engine, WINDOW, { sourceIds: ['default'], deadlineAt: Date.now() + 30_000 });
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ slug: SLUG, source_id: 'default', arm: 'situation', rationale: 'related situation', synopsis: BODY });
    expect(JSON.stringify(pages)).not.toContain('CUE_ONLY_SENTINEL');
    expect(formatVolunteeredPage(pages[0])).toContain('cue similarity 1.00');
    expect(embedCalls).toHaveLength(1);
  });

  test('the default situation deadline rejects late embeddings before cue lookup', async () => {
    let now = Date.now();
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    const executeRaw = engine.executeRaw.bind(engine);
    let cueLookups = 0;
    const query = spyOn(engine, 'executeRaw').mockImplementation(async (sql, params, opts) => {
      if (sql.includes('WITH nearest AS MATERIALIZED')) cueLookups++;
      return executeRaw(sql, params, opts);
    });
    beforeEmbed = async () => { now += SITUATION_RECALL_BUDGET_MS + 1; };
    try {
      expect(await volunteerContext(engine, WINDOW, { sourceIds: ['default'] })).toEqual([]);
      expect(embedCalls).toHaveLength(1);
      expect(cueLookups).toBe(0);
    } finally {
      clock.mockRestore();
      query.mockRestore();
    }
  });

  test('bounded situation queries retain complete role labels on truncated turns', async () => {
    await recallSituationPage(engine, [{ role: 'assistant', text: 'Earlier context.' },
      { role: 'user', text: `${'x'.repeat(9000)} newest request` }], { sourceIds: ['default'] });
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0][0].length).toBeLessThanOrEqual(8000);
    expect(embedCalls[0][0].startsWith('user: ')).toBe(true);
    expect(embedCalls[0][0].endsWith('newest request')).toBe(true);
  });

  test('default off, missing calibrated threshold, and empty or unenrolled scope make no provider calls', async () => {
    await engine.setConfig('memory.cues.push', 'false');
    expect(await volunteerContext(engine, WINDOW, { sourceIds: ['default'] })).toEqual([]);
    await engine.setConfig('memory.cues.push', 'true');
    await engine.executeRaw("DELETE FROM config WHERE key='memory.cues.push_min_similarity'");
    expect(await volunteerContext(engine, WINDOW, { sourceIds: ['default'] })).toEqual([]);
    await engine.setConfig('memory.cues.push_min_similarity', '0.9');
    expect(await volunteerContext(engine, WINDOW, { sourceIds: [] })).toEqual([]);
    expect(await volunteerContext(engine, WINDOW, { sourceIds: ['other'] })).toEqual([]);
    expect(embedCalls).toEqual([]);
  });

  test('global embedding disable prevents provider calls despite enrolled and calibrated push', async () => {
    mkdirSync(join(dir, '.gbrain'), { recursive: true });
    writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', embedding_disabled: true }));
    expect(await volunteerContext(engine, WINDOW, { sourceIds: ['default'] })).toEqual([]);
    expect(embedCalls).toEqual([]);
  });

  test('global embedding disable during the provider await suppresses late delivery', async () => {
    beforeEmbed = async () => {
      mkdirSync(join(dir, '.gbrain'), { recursive: true });
      writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', embedding_disabled: true }));
    };
    expect(await volunteerContext(engine, WINDOW, { sourceIds: ['default'] })).toEqual([]);
    expect(embedCalls).toHaveLength(1);
  });

  test('global embedding disable during final hydration suppresses delivery', async () => {
    const executeRaw = PGLiteEngine.prototype.executeRaw;
    let disabled = false;
    const query = spyOn(engine, 'executeRaw').mockImplementation(async function<T = Record<string, unknown>>(
      this: PGLiteEngine, sql: string, params?: unknown[], opts?: { signal?: AbortSignal },
    ): Promise<T[]> {
      if (!disabled && sql.includes('WHERE c.id=ANY')) {
        disabled = true;
        mkdirSync(join(dir, '.gbrain'), { recursive: true });
        writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', embedding_disabled: true }));
      }
      return executeRaw.call(this, sql, params, opts) as Promise<T[]>;
    });
    try {
      expect(await volunteerContext(engine, WINDOW, { sourceIds: ['default'] })).toEqual([]);
      expect(disabled).toBe(true);
    } finally { query.mockRestore(); }
  });

  test('core database failure is not reported as an empty memory result', async () => {
    const query = spyOn(engine, 'executeRaw').mockRejectedValueOnce(new Error('database unavailable'));
    try {
      await expect(volunteerContext(engine, WINDOW, { sourceIds: ['default'] })).rejects.toThrow('database unavailable');
      expect(embedCalls).toEqual([]);
    } finally { query.mockRestore(); }
  });

  test('revoking push while query embedding runs refuses delivery even if pull remains enabled', async () => {
    await engine.setConfig('memory.cues.read', 'on');
    beforeEmbed = async () => { await engine.setConfig('memory.cues.push', 'false'); };
    expect(await volunteerContext(engine, WINDOW, { sourceIds: ['default'] })).toEqual([]);
    expect(embedCalls).toHaveLength(1);
  });

  test('push revocation at final candidate hydration cannot borrow pull authorization', async () => {
    await engine.setConfig('memory.cues.read', 'on');
    const executeRaw = PGLiteEngine.prototype.executeRaw;
    let revoked = false;
    const query = spyOn(engine, 'executeRaw').mockImplementation(async function<T = Record<string, unknown>>(
      this: PGLiteEngine, sql: string, params?: unknown[], opts?: { signal?: AbortSignal },
    ): Promise<T[]> {
      if (!revoked && sql.includes('WHERE c.id=ANY')) {
        revoked = true;
        await engine.setConfig('memory.cues.push', 'false');
      }
      return executeRaw.call(this, sql, params, opts) as Promise<T[]>;
    });
    try {
      expect(await volunteerContext(engine, WINDOW, { sourceIds: ['default'] })).toEqual([]);
      expect(revoked).toBe(true);
    } finally { query.mockRestore(); }
  });

  test('orthogonal situations stay silent; previous delivery and watch exclusions suppress repeats', async () => {
    queryVector = vector(1);
    expect(await volunteerContext(engine, WINDOW, { sourceIds: ['default'] })).toEqual([]);
    queryVector = vector();
    expect(await volunteerContext(engine, WINDOW, { sourceIds: ['default'], priorContext: `Loaded ${SLUG}` })).toEqual([]);
    expect(await volunteerContext(engine, WINDOW, { sourceIds: ['default'], excludeSlugs: new Set([SLUG]) })).toEqual([]);
  });

  test('watch delivers exactly once across repeated no-entity turns', async () => {
    let output = '';
    await runWatch(engine, ['--json', '--source', 'default'], { isTTY: false,
      lines: (async function* () { yield 'user: do it?'; yield 'user: do it?'; })(),
      write: text => { output += text; },
    });
    const rows = output.trim().split('\n').map(line => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ turn: 1, slug: SLUG, arm: 'situation', source_id: 'default' });
    expect(output).not.toContain('CUE_ONLY_SENTINEL');
  });

  test('private, archived, stale and revoked source evidence never reaches push', async () => {
    await engine.executeRaw('UPDATE pages SET frontmatter=$1::jsonb WHERE slug=$2', [JSON.stringify({ visibility: 'private' }), SLUG]);
    expect(await volunteerContext(engine, WINDOW, { sourceIds: ['default'] })).toEqual([]);
    await engine.executeRaw("UPDATE pages SET frontmatter='{}'::jsonb");
    await engine.executeRaw("UPDATE sources SET archived=true WHERE id='default'");
    expect(await volunteerContext(engine, WINDOW, { sourceIds: ['default'] })).toEqual([]);
    await engine.executeRaw("UPDATE sources SET archived=false WHERE id='default'");
    beforeEmbed = async () => { await engine.setConfig('memory.cues.sources', '[]'); };
    expect(await volunteerContext(engine, WINDOW, { sourceIds: ['default'] })).toEqual([]);
    beforeEmbed = undefined;
    await engine.setConfig('memory.cues.sources', '["default"]');
    await engine.putPage(SLUG, { type: 'note', title: 'Correction', compiled_truth: 'Calls are fine at any time.' }, { sourceId: 'default' });
    expect(await volunteerContext(engine, WINDOW, { sourceIds: ['default'] })).toEqual([]);
  });

  test('same-slug source identities are preserved and foreign evidence is excluded', async () => {
    await seed('other', SLUG, 'I only take calls in the evening.');
    await build(['default', 'other']);
    const pages = await volunteerContext(engine, WINDOW, { sourceIds: ['other'] });
    expect(pages).toHaveLength(1);
    expect(pages[0].source_id).toBe('other');
    expect(pages[0].synopsis).toBe('I only take calls in the evening.');
  });

  test('a production-built split constraint pushes one source pointer without a partial synopsis', async () => {
    const sourceId = 'split-source';
    const chunks = ['I do not take calls ', 'before 10.'];
    await seed(sourceId, SLUG, chunks.join(''));
    const snapshot = await readProjectionSnapshot(engine, SLUG, sourceId);
    expect(snapshot).not.toBeNull();
    await installPageProjection(engine, snapshot!, chunks.map((chunk_text, chunk_index) => ({
      chunk_index, chunk_text, chunk_source: 'compiled_truth' as const, model: 'text-embedding-3-large', modality: 'text' as const,
    })), { seal: true });
    await engine.setConfig('memory.cues.sources', JSON.stringify([sourceId]));
    const receipt = await submitMemoryCueBuild(engine, { sourceIds: [sourceId], trustedLocal: true, maxUsd: 2 });
    const built = await runMemoryCueBuild(engine, { buildId: receipt.buildId, providers: {
      generate: async ({ evidence }) => ({ actualUsd: 0.001, output: evidence.includes(chunks[0]) && evidence.includes(chunks[1])
        ? [{ family: 'horizon', relation: 'explicit_constraint_applies', quote: evidence, text: CUE }] : [] }),
      embed: async texts => texts.map(() => vector()),
    } });
    expect(built).toMatchObject({ status: 'complete' });
    const recalled = await recallMemoryCues(engine, vector(), { sourceIds: [sourceId], excludePrivate: true,
      purpose: 'push', embeddingColumn: await memoryCueColumn(engine) });
    expect(recalled.candidates).toHaveLength(1);
    expect(recalled.candidates[0].evidence?.map(result => result.chunk_text)).toEqual(chunks);
    const pages = await volunteerContext(engine, WINDOW, { sourceIds: [sourceId] });
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ slug: SLUG, source_id: sourceId, arm: 'situation', synopsis: '', rationale: 'related situation' });
    const rendered = formatVolunteeredPage(pages[0]);
    expect(rendered).toContain('source_id: "split-source"');
    expect(rendered).not.toContain('I do not take calls');
    expect(rendered).not.toContain('before 10.');
    expect(rendered).not.toContain('CUE_ONLY_SENTINEL');
  });

  test('entity-first gate shares its cap with at most one situation result', async () => {
    const block: PointerBlock = { text: 'entity pointers', pointers: ['one', 'two', 'three'].map(slug => ({
      slug, source_id: 'default', display: slug, synopsis: '', arm: 'alias', confidence: 0.9,
    })) };
    const cands = extractCandidatesFromWindow([{ role: 'user', text: 'Alice Example' }]);
    const recall = (turns: WindowTurn[], opts: Parameters<typeof recallSituationPage>[2]) => recallSituationPage(engine, turns, opts);
    const pages = await volunteerStage(async () => ({ ...block, pointers: block.pointers.slice(0, 2) }), cands, 1, {
      turns: WINDOW, maxPages: 3, recallSituation: (turns, opts) => recall(turns, { ...opts, sourceIds: ['default'] }),
    });
    expect(pages.map(page => page.arm)).toEqual(['alias', 'alias', 'situation']);
    const calls = embedCalls.length;
    const full = await volunteerStage(async () => block, cands, 1, {
      turns: WINDOW, maxPages: 3, recallSituation: (turns, opts) => recall(turns, { ...opts, sourceIds: ['default'] }),
    });
    expect(full.map(page => page.arm)).toEqual(['alias', 'alias', 'alias']);
    expect(embedCalls).toHaveLength(calls);
  });

  test('a rejected optional arm preserves entity pages but cannot hide a database failure as an empty result', async () => {
    const candidates = extractCandidatesFromWindow([{ role: 'user', text: 'Alice Example' }]);
    const opts = { turns: WINDOW, recallSituation: async () => { throw new Error('database unavailable'); } };
    const pages = await volunteerStage(async () => ({ text: 'entity pointer', pointers: [{
      slug: 'people/alice-example', source_id: 'default', display: 'Alice Example', synopsis: BODY,
      arm: 'alias', confidence: 0.9,
    }] }), candidates, 1, opts);
    expect(pages.map(page => page.slug)).toEqual(['people/alice-example']);
    await expect(volunteerStage(async () => null, [], 1, opts)).rejects.toThrow('database unavailable');
  });

  test('optional embedding deadline preserves resolved entities and does not continue lookup', async () => {
    let release!: () => void;
    beforeEmbed = () => new Promise<void>(resolve => { release = resolve; });
    const result = await volunteerStage(async () => ({ text: 'pointer', pointers: [{ slug: 'people/alice-example',
      source_id: 'default', display: 'Alice Example', arm: 'alias', confidence: 0.9, synopsis: '' }] }),
    extractCandidatesFromWindow([{ role: 'user', text: 'Alice Example' }]), 1, {
      turns: WINDOW, deadlineAt: Date.now() + 80,
      recallSituation: (turns, opts) => recallSituationPage(engine, turns, { ...opts, sourceIds: ['default'] }),
    });
    expect(result.map(page => page.slug)).toEqual(['people/alice-example']);
    release();
    await Bun.sleep(15);
    expect(result).toHaveLength(1);
  });
});

describe('supported IPC, hook and OpenClaw delivery', () => {
  test('real hook traverses authenticated turn-context IPC and emits only original evidence', async () => {
    const { cfg, socket, secret } = await listen();
    let output = '';
    expect(await runHook(['user-prompt'], { stdin: JSON.stringify({ prompt: WINDOW[0].text, session_id: 'situation-test' }),
      write: text => { output += text; }, cwd: dir, configOverride: cfg, disablePushBanner: true })).toBe(0);
    const context = JSON.parse(output).hookSpecificOutput.additionalContext;
    expect(context).toContain(SLUG);
    expect(context).toContain('source_id: "default"');
    expect(context).toContain(BODY);
    expect(context).toContain('related situation');
    expect(context).toContain('cue similarity 1.00');
    expect(context).not.toContain('CUE_ONLY_SENTINEL');
    const repeated = await requestTurnContext(socket, { secret, window: WINDOW, priorContextText: context });
    expect(repeated).toMatchObject({ ok: true, block: { volunteered: [] } });
    const transcript = join(dir, 'session.jsonl');
    writeFileSync(transcript, JSON.stringify({ type: 'attachment', attachment: {
      type: 'hook_additional_context', content: [context],
    } }) + '\n');
    output = '';
    expect(await runHook(['user-prompt'], { stdin: JSON.stringify({ prompt: WINDOW[0].text,
      session_id: 'situation-test', transcript_path: transcript }), transcriptRoot: dir,
      write: text => { output += text; }, cwd: dir, configOverride: cfg, disablePushBanner: true })).toBe(0);
    expect(output).toBe('');
  });

  test('manual named-pointer control uses the same real hook with semantic push off', async () => {
    await seed('default', 'people/alice-example', BODY, 'Alice Example');
    await engine.setConfig('memory.cues.push', 'false');
    const { cfg } = await listen();
    let output = '';
    expect(await runHook(['user-prompt'], { stdin: JSON.stringify({ prompt: 'Alice Example', session_id: 'manual-control' }),
      write: text => { output += text; }, cwd: dir, configOverride: cfg, disablePushBanner: true })).toBe(0);
    const context = JSON.parse(output).hookSpecificOutput.additionalContext;
    expect(context).toContain('people/alice-example');
    expect(context).toContain(BODY);
    expect(context).not.toContain('related situation');
    expect(context).not.toContain('cue similarity');
    expect(embedCalls).toEqual([]);
  });

  test('situation IPC rejects wrong secret, mismatched or absent binding, and malformed inputs', async () => {
    const { socket, secret } = await listen();
    expect(await requestSituationRecall(socket, { secret: 'wrong', window: WINDOW })).toMatchObject({ ok: false, error: 'unauthorized' });
    expect(await requestSituationRecall(socket, { secret, sourceId: 'other', window: WINDOW })).toMatchObject({ ok: false, error: 'source_mismatch' });
    expect(await requestSituationRecall(socket, { secret, sourceId: '', window: WINDOW })).toMatchObject({ ok: false, error: 'source_mismatch' });
    expect(await requestSituationRecall(socket, { secret, window: [null] as any })).toMatchObject({ ok: false, error: 'invalid_request' });
    const unboundSocket = resolveSocketPath(join(dir, 'unbound'));
    const server = await startResolveIpcServer(unboundSocket, { resolve: async () => null,
      situation_recall: async () => { throw new Error('unbound handler must not run'); } }, { secret });
    expect(server).not.toBeNull();
    try {
      expect(await requestSituationRecall(unboundSocket, { secret, window: WINDOW })).toMatchObject({ ok: false, error: 'source_mismatch' });
    } finally { server?.close(); }
    expect(embedCalls).toEqual([]);
  });

  test('OpenClaw direct reflex uses the dedicated same-harness IPC arm with no entity candidates', async () => {
    await listen();
    process.env.GBRAIN_MEMORY_CUES_PUSH = '1';
    const result = await buildReflexAddition({ workspaceDir: dir, currentUserText: WINDOW[0].text,
      priorContextText: '', windowTurns: WINDOW });
    expect(result).toContain(SLUG);
    expect(result).toContain('source_id: "default"');
    expect(result).toContain('cue similarity 1.00');
    expect(result).not.toContain('CUE_ONLY_SENTINEL');
    expect(await buildReflexAddition({ workspaceDir: dir, currentUserText: WINDOW[0].text,
      priorContextText: result!, windowTurns: WINDOW })).toBeNull();
  });

  test('legacy zero-candidate reflex does no I/O and entity-only host cannot route to another brain', async () => {
    let resolutions = 0;
    const params = { workspaceDir: dir, currentUserText: WINDOW[0].text, priorContextText: '', windowTurns: WINDOW,
      resolveEntities: async () => { resolutions++; return null; } };
    expect(await buildReflexAddition(params)).toBeNull();
    await listen();
    process.env.GBRAIN_MEMORY_CUES_PUSH = '1';
    expect(await buildReflexAddition(params)).toBeNull();
    expect(resolutions).toBe(0);
    expect(embedCalls).toEqual([]);
  });

  test('host capability shares the primitive and byte trimming removes situation before entity pages', async () => {
    const addition = await buildReflexAddition({ workspaceDir: dir, currentUserText: WINDOW[0].text,
      priorContextText: '', resolveEntities: async () => null,
      recallSituation: (turns, opts) => recallSituationPage(engine, turns, { ...opts, sourceIds: ['default'] }) });
    expect(addition).toContain(SLUG);
    await seed('default', 'people/alice-example', 'Original named pointer evidence.', 'Alice Example');
    const window: WindowTurn[] = [{ role: 'user', text: 'Alice Example' }];
    const full = await assembleTurnContext(engine, { sourceId: 'default', window });
    expect(full.pointers).toHaveLength(1);
    expect(full.volunteered?.[0].arm).toBe('situation');
    await engine.setConfig('memory.cues.push', 'false');
    const control = await assembleTurnContext(engine, { sourceId: 'default', window });
    await engine.setConfig('memory.cues.push', 'true');
    const result = await assembleTurnContext(engine, { sourceId: 'default', window, maxBytes: Buffer.byteLength(control.text) });
    expect(result.text).toBe(control.text);
    expect(result.pointers).toHaveLength(1);
    expect(result.volunteered).toEqual([]);
  });
});
