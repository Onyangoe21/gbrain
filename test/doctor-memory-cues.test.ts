import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkMemoryCues } from '../src/commands/doctor/checks/memory-cues.ts';
import { cueSignature, memoryCueColumn } from '../src/core/memory-cues/settings.ts';
import { runMemoryCueBuild, submitMemoryCueBuild } from '../src/core/memory-cues/index.ts';
import { cueProviders, enrollCues, seedCuePage } from './helpers/memory-cues.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => { await engine.disconnect(); });

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM memory_cue_builds');
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw("DELETE FROM config WHERE key LIKE 'memory.cues.%'");
  await engine.setConfig('embedding_model', 'openai:text-embedding-3-small');
  await engine.setConfig('embedding_dimensions', '1536');
  await engine.setConfig('embedding_columns', '{}');
  await engine.setConfig('chat_model', 'openai:gpt-4o-mini');
});

describe('memory cue diagnostics', () => {
  test('default-off installs have no extra warning', async () => {
    expect(await checkMemoryCues(engine)).toBeNull();
  });

  test('enabled but unenrolled configuration is visibly incomplete', async () => {
    await engine.setConfig('memory.cues.generation_enabled', 'true');
    const check = await checkMemoryCues(engine);
    expect(check?.status).toBe('warn');
    expect(check?.message).toContain('no sources are enrolled');
    expect(check?.message).toContain('No generation or repair was started');
  });

  test('read and push calibration are independently required', async () => {
    await engine.setConfig('memory.cues.sources', '["default"]');
    await engine.setConfig('memory.cues.read', 'on');
    await engine.setConfig('memory.cues.push', 'true');
    await engine.setConfig('memory.cues.min_similarity', '0.7');
    await engine.setConfig('memory.cues.read_calibration_signature', cueSignature(await memoryCueColumn(engine)));
    const check = await checkMemoryCues(engine);
    expect(check?.status).toBe('warn');
    expect(check?.message).toContain('push calibration is missing');
    expect(check?.message).not.toContain('retrieval calibration is missing');
    expect(check?.message).toContain('no current ready cue windows');
  });

  test('model rotation invalidates a previously chosen threshold', async () => {
    await engine.setConfig('embedding_columns', JSON.stringify({ embedding: { provider: 'openai:text-embedding-3-small', dimensions: 1536, type: 'vector' } }));
    await engine.setConfig('memory.cues.sources', '["default"]');
    await engine.setConfig('memory.cues.read', 'shadow');
    await engine.setConfig('memory.cues.min_similarity', '0.7');
    await engine.setConfig('memory.cues.read_calibration_signature', cueSignature(await memoryCueColumn(engine)));
    const before = cueSignature(await memoryCueColumn(engine));
    await engine.setConfig('embedding_columns', JSON.stringify({ embedding: { provider: 'openai:text-embedding-3-large', dimensions: 1536, type: 'vector' } }));
    expect(cueSignature(await memoryCueColumn(engine))).not.toBe(before);
    const check = await checkMemoryCues(engine);
    expect(check?.message).toContain('retrieval calibration is missing or belongs to another embedding model');
  });

  test('diagnostics do not schedule a build', async () => {
    await engine.setConfig('memory.cues.generation_enabled', 'true');
    await engine.setConfig('memory.cues.sources', '["default"]');
    const before = await engine.executeRaw('SELECT count(*)::int AS count FROM minion_jobs');
    await checkMemoryCues(engine);
    expect(await engine.executeRaw('SELECT count(*)::int AS count FROM minion_jobs')).toEqual(before);
  });

  test('ready windows do not hide a missing active ANN index', async () => {
    await seedCuePage(engine);
    await enrollCues(engine);
    const build = await submitMemoryCueBuild(engine, { sourceIds: ['default'], trustedLocal: true, maxUsd: 1 });
    expect(await runMemoryCueBuild(engine, { buildId: build.buildId, providers: cueProviders })).toMatchObject({ status: 'complete' });
    expect((await checkMemoryCues(engine))?.status).toBe('ok');
    const signature = cueSignature(await memoryCueColumn(engine));
    await engine.executeRaw(`DROP INDEX memory_cues_ann_${signature.slice(0, 24)}`);
    const check = await checkMemoryCues(engine);
    expect(check?.status).toBe('warn');
    expect(check?.message).toContain('active cue index is missing or invalid');
    expect(check?.details?.index_ready).toBe(false);
  });

  test('generation-model changes and archived sources are not reported as ready coverage', async () => {
    await seedCuePage(engine);
    await enrollCues(engine);
    const build = await submitMemoryCueBuild(engine, { sourceIds: ['default'], trustedLocal: true, maxUsd: 1 });
    expect(await runMemoryCueBuild(engine, { buildId: build.buildId, providers: cueProviders })).toMatchObject({ status: 'complete' });
    expect((await checkMemoryCues(engine))?.status).toBe('ok');
    await engine.setConfig('chat_model', 'anthropic:claude-haiku-4-5-20251001');
    expect((await checkMemoryCues(engine))?.message).toContain('stale windows');
    await engine.setConfig('chat_model', 'openai:gpt-4o-mini');
    await engine.executeRaw("UPDATE sources SET archived=true WHERE id='default'");
    try {
      expect((await checkMemoryCues(engine))?.message).toContain('stale windows');
    } finally { await engine.executeRaw("UPDATE sources SET archived=false WHERE id='default'"); }
    expect((await checkMemoryCues(engine))?.status).toBe('ok');
  });
});
