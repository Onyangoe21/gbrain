import type { BrainEngine } from '../../../core/engine.ts';
import { getMemoryCueStatus, loadMemoryCueSettings } from '../../../core/memory-cues/index.ts';
import type { Check } from '../../doctor.ts';

export async function checkMemoryCues(engine: BrainEngine): Promise<Check | null> {
  try {
    const settings = await loadMemoryCueSettings(engine);
    if (!settings.generationEnabled && settings.readMode === 'off' && !settings.pushEnabled) return null;
    const status = await getMemoryCueStatus(engine, { sourceIds: settings.sourceIds });
    const counts = Object.fromEntries(status.coverage.map(row => [row.status, Number(row.count)]));
    const problems: string[] = [];
    if (!settings.sourceIds.length) problems.push('no sources are enrolled');
    if (!settings.families.length) problems.push('no valid cue families are selected');
    if (!status.supported) problems.push(status.reason ?? 'the embedding configuration is unsupported');
    if (!status.indexReady) problems.push('the active cue index is missing or invalid');
    if (settings.readMode !== 'off' && settings.minSimilarity === null) problems.push('retrieval calibration is missing or belongs to another embedding model');
    if (settings.pushEnabled && settings.pushMinSimilarity === null) problems.push('push calibration is missing or belongs to another embedding model');
    if ((counts.ready ?? 0) === 0) problems.push('no current ready cue windows');
    if ((counts.stale ?? 0) > 0) problems.push(`${counts.stale} stale windows are excluded from retrieval`);
    if (status.windowsPending > 0) problems.push(`${status.windowsPending} page jobs remain pending`);
    const blocked = status.builds.filter(build => ['failed', 'blocked', 'deferred'].includes(build.status) || build.remaining_cents === 0);
    if (blocked.length) problems.push(`${blocked.length} build(s) need attention or have exhausted their original budget`);
    return {
      name: 'memory_cues',
      status: problems.length ? 'warn' : 'ok',
      message: problems.length
        ? `Situation-aware recall: ${problems.join('; ')}. Inspect with gbrain memory-cues status. No generation or repair was started.`
        : `Situation-aware recall ${settings.readMode}; ${counts.ready ?? 0} ready windows. Proactive reminders ${settings.pushEnabled ? 'enabled with separate calibration' : 'off'}.`,
      details: { settings, coverage: status.coverage, builds: status.builds, pending_pages: status.windowsPending, signature: status.signature, index_ready: status.indexReady },
    };
  } catch {
    return { name: 'memory_cues', status: 'warn', message: 'Situation-aware recall readiness could not be verified. Inspect the database and run gbrain memory-cues status locally; no generation or repair was started.' };
  }
}
