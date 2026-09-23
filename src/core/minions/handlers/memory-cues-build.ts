import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';
import { UnrecoverableError } from '../types.ts';
import { runMemoryCueBuild } from '../../memory-cues/index.ts';

export function createMemoryCueBuildHandler(engine: BrainEngine): MinionHandler {
  return async job => {
    if (typeof job.data.buildId !== 'string') throw new Error('memory-cues buildId required');
    const result = await runMemoryCueBuild(engine, { buildId: job.data.buildId, signal: job.signal });
    await job.updateProgress(result);
    if (result.status === 'failed') throw new UnrecoverableError(result.reason ?? 'cue_build_failed');
    return result;
  };
}
