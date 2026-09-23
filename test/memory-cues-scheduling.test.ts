import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite, getWriteRequestById } from '../src/core/persistence/journal.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { cueSchedulingEnabled } from '../src/core/memory-cues/scheduling.ts';
import { runMemoryCueBuild, runPendingMemoryCueJob } from '../src/core/memory-cues/index.ts';
import { cueEvidence, cueProviders, enrollCues, seedCuePage, startCueBuild } from './helpers/memory-cues.ts';
import { PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); });

test('disabled incremental scheduling ignores malformed embedding configuration', async () => {
  await engine.setConfig('search_embedding_column', 'missing_registry_column');
  expect(await cueSchedulingEnabled(engine, 'default')).toBe(false);
  await engine.setConfig('search_embedding_column', 'embedding');
});

test('canonical acceptance persists cue debt; later generation failure cannot undo the write', async () => {
  await seedCuePage(engine);
  await enrollCues(engine);
  const build = await startCueBuild(engine);
  await runMemoryCueBuild(engine, { buildId: build.buildId, providers: cueProviders });
  await registerLocalWriter(engine, 'cli');
  const config = { engine: 'pglite' as const, embedding_disabled: true };
  const ctx: OperationContext = { engine, config, remote: false, dryRun: false, sourceId: 'default', logger: { info() {}, warn() {}, error() {} } };
  const snapshot = (await engine.readPageSnapshot('cue-example', { sourceId: 'default' }))!;
  const authority = await submissionAuthority(ctx, 'put_page', 'default', snapshot.sourceIncarnation, 'cue-example');
  const admitted = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
    sourceIncarnation: snapshot.sourceIncarnation, slug: 'cue-example', pageId: snapshot.page.id,
    requestId: randomUUID(), callerIntent: { content: 'updated' }, intent: { content: 'updated' } });
  const row = (await claimNextWrite(engine, localHostId()))!;
  expect(row.id).toBe(admitted.id);
  const result = await publishMutation(engine, row, { observedRevision: snapshot.revision, deferEmbedding: true,
    apply: async tx => { await seedCuePage(tx, 'cue-example', 'default', `${cueEvidence} New explicit constraint.`); return {}; } }, localHostId());
  expect(result.state).toBe('committed');
  expect(await engine.executeRaw("SELECT kind FROM persistence_effects WHERE request_id=$1::uuid AND kind='memory-cues'", [row.id])).toHaveLength(1);
  await runPersistenceEffects(engine, config, { hostId: localHostId(), limit: 5 });
  expect(await engine.executeRaw("SELECT state FROM persistence_effects WHERE request_id=$1::uuid AND kind='memory-cues' AND state='committed'", [row.id])).toHaveLength(1);
  expect((await runMemoryCueBuild(engine, { buildId: build.buildId, providers: { ...cueProviders, generate: async () => { throw new Error('provider unavailable'); } } })).status).toBe('failed');
  expect((await engine.getPage('cue-example', { sourceId: 'default' }))!.compiled_truth).toContain('New explicit constraint.');
  expect((await getWriteRequestById(engine, row.id))!.state).toBe('committed');
});

test('PGLite inline execution claims the requested job and resumes crash debt on its original owner', async () => {
  await seedCuePage(engine);
  const older = await startCueBuild(engine);
  const target = await startCueBuild(engine);
  const completed = await runPendingMemoryCueJob(engine, { jobId: target.jobId, providers: cueProviders });
  expect(completed).toMatchObject({ jobId: target.jobId, buildId: target.buildId, status: 'complete' });
  expect(await engine.executeRaw('SELECT status FROM minion_jobs WHERE id=$1', [target.jobId])).toEqual([{ status: 'completed' }]);
  expect(await engine.executeRaw('SELECT status FROM minion_jobs WHERE id=$1', [older.jobId])).toEqual([{ status: 'waiting' }]);
  await new MinionQueue(engine).claim('interrupted-fixture', 120000, 'default', ['memory-cues-build'], older.jobId);
  await engine.executeRaw("UPDATE minion_jobs SET lock_until=now()-interval '1 hour' WHERE id=$1", [older.jobId]);
  await engine.executeRaw("UPDATE memory_cue_builds SET status='running',execution_token=gen_random_uuid(),lease_until=now()-interval '1 hour' WHERE id=$1::uuid", [older.buildId]);
  expect(await runPendingMemoryCueJob(engine, { jobId: older.jobId, providers: cueProviders })).toMatchObject({ status: 'complete', buildId: older.buildId });
  const [owner] = await engine.executeRaw<{ budget_remaining_cents: number; budget_root_owner_id: number }>('SELECT budget_remaining_cents,budget_root_owner_id FROM minion_jobs WHERE id=$1', [older.jobId]);
  expect(Number(owner!.budget_root_owner_id)).toBe(older.budgetOwnerJobId);
  expect(owner!.budget_remaining_cents).toBeLessThan(100);
});

test('resident maintenance admits cue work asynchronously and shutdown cancels before embedding', async () => {
  await engine.executeRaw('DELETE FROM memory_cue_builds');
  await engine.executeRaw('DELETE FROM minion_jobs');
  const build = await startCueBuild(engine);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let embedded = false;
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async () => { throw new Error('no canonical debt expected'); }, {
    memoryCueProviders: { generate: async input => { entered.resolve(); await release.promise; return cueProviders.generate(input); },
      embed: async () => { embedded = true; return []; } },
  });
  try {
    await consumer.tick();
    await entered.promise;
    const stopping = consumer.stop();
    release.resolve();
    await stopping;
    expect(embedded).toBe(false);
    expect(await engine.executeRaw('SELECT id FROM memory_cue_windows WHERE build_id=$1::uuid', [build.buildId])).toHaveLength(0);
    expect(await engine.executeRaw('SELECT status FROM minion_jobs WHERE id=$1', [build.jobId])).toEqual([{ status: 'failed' }]);
  } finally { release.resolve(); await consumer.stop(); }
});
