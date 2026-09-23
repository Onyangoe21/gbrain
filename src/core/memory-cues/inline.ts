import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { MinionQueue } from '../minions/queue.ts';
import { reconfigureGatewayWithEngine } from '../ai/gateway.ts';
import { runMemoryCueBuild } from './generate.ts';
import type { MemoryCueProviders } from './types.ts';

export async function runPendingMemoryCueJob(engine: BrainEngine, opts: { jobId?: number; signal?: AbortSignal; providers?: MemoryCueProviders } = {}) {
  if (engine.kind !== 'pglite' || opts.signal?.aborted || await engine.getConfig('memory.cues.generation_enabled') !== 'true') return null;
  const token = randomUUID();
  const queue = new MinionQueue(engine);
  await queue.handleStalled(undefined, ['memory-cues-build']);
  const job = await queue.claim(token, 120000, 'default', ['memory-cues-build'], opts.jobId);
  if (!job) return null;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(600000), ...(opts.signal ? [opts.signal] : [])]);
  let renewing: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (renewing) return;
    renewing = queue.renewLock(job.id, token, 120000).then(live => { if (!live) controller.abort(); })
      .catch(() => { controller.abort(); }).finally(() => { renewing = undefined; });
  }, 10000);
  timer.unref?.();
  try {
    if (!opts.providers) await reconfigureGatewayWithEngine(engine);
    if (typeof job.data.buildId !== 'string') throw new Error('invalid_build_job');
    const result = await runMemoryCueBuild(engine, { buildId: job.data.buildId, signal, providers: opts.providers });
    if (result.status === 'failed') await queue.failJob(job.id, token, result.reason ?? 'cue_build_failed', 'failed');
    else await queue.completeJob(job.id, token, result);
    return { jobId: job.id, buildId: job.data.buildId, ...result };
  } catch (error) {
    await queue.failJob(job.id, token, 'cue_inline_failed', 'failed');
    throw error;
  } finally { clearInterval(timer); await renewing; }
}
