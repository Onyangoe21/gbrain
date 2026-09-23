import type { Operation, OperationContext } from './contract.ts';
import { OperationError } from './contract.ts';
import { isValidSourceId } from '../source-id.ts';
import { loadMemoryCueSettings, memoryCueColumn, cueSignature } from '../memory-cues/settings.ts';
import { MEMORY_CUE_SOURCE_LIMIT, MEMORY_CUE_FAMILIES, type MemoryCueBuildReceipt } from '../memory-cues/types.ts';

const actions = ['status', 'configure', 'preview', 'build', 'cancel', 'resume'] as const;

export function validateMemoryCueConfiguration(params: Record<string, unknown>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [param, key] of [['generation_enabled', 'generation_enabled'], ['push_enabled', 'push']] as const) {
    if (params[param] === undefined) continue;
    if (typeof params[param] !== 'boolean') throw new OperationError('invalid_params', `${param} must be a boolean.`);
    values[`memory.cues.${key}`] = String(params[param]);
  }
  if (params.read_mode !== undefined) {
    if (!['off', 'shadow', 'on'].includes(params.read_mode as string)) throw new OperationError('invalid_params', 'read_mode must be off, shadow, or on.');
    values['memory.cues.read'] = params.read_mode as string;
  }
  if (params.source_ids !== undefined) {
    if (!Array.isArray(params.source_ids) || params.source_ids.length > MEMORY_CUE_SOURCE_LIMIT
      || params.source_ids.some(id => typeof id !== 'string' || !isValidSourceId(id) || id === '__all__')) {
      throw new OperationError('invalid_params', `source_ids must contain at most ${MEMORY_CUE_SOURCE_LIMIT} explicit valid source IDs.`);
    }
    values['memory.cues.sources'] = JSON.stringify([...new Set(params.source_ids)]);
  }
  if (params.families !== undefined) {
    if (!Array.isArray(params.families) || !params.families.length || params.families.length > 3
      || params.families.some(f => !MEMORY_CUE_FAMILIES.includes(f))) {
      throw new OperationError('invalid_params', 'families must select scene, horizon, or bridge.');
    }
    values['memory.cues.families'] = JSON.stringify([...new Set(params.families)].sort());
  }
  for (const key of ['min_similarity', 'push_min_similarity'] as const) {
    const value = params[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < -1 || value > 1) {
      throw new OperationError('invalid_params', `${key} must be a finite cosine threshold between -1 and 1.`);
    }
    values[`memory.cues.${key}`] = String(value);
  }
  if (params.weight !== undefined) {
    const value = params.weight;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 0.5) {
      throw new OperationError('invalid_params', 'weight must be greater than zero and at most 0.5.');
    }
    values['memory.cues.weight'] = String(value);
  }
  return values;
}

function positiveInteger(value: unknown, fallback: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new OperationError('invalid_params', `${name} must be an integer from 1 to ${maximum}.`);
  }
  return value;
}

async function sourcesFor(ctx: OperationContext, params: Record<string, unknown>): Promise<string[]> {
  const sourceIds = params.source_ids === undefined ? [ctx.sourceId] : params.source_ids;
  validateMemoryCueConfiguration({ source_ids: sourceIds });
  const ids = [...new Set(sourceIds as string[])];
  if (!ids.length) throw new OperationError('invalid_params', 'At least one explicit source is required.');
  const rows = await ctx.engine.executeRaw<{ id: string }>(
    'SELECT id FROM sources WHERE id=ANY($1::text[]) AND NOT archived', [ids],
  );
  if (rows.length !== ids.length) throw new OperationError('not_found', 'An explicitly requested source is missing or archived.');
  return ids;
}

async function configure(ctx: OperationContext, params: Record<string, unknown>) {
  const changes = validateMemoryCueConfiguration(params);
  if (!Object.keys(changes).length) throw new OperationError('invalid_params', 'Supply at least one configuration setting.');
  if (params.source_ids !== undefined && (params.source_ids as string[]).length) await sourcesFor(ctx, params);
  if (ctx.dryRun || params.apply !== true) return { applied: false, changes, settings: await loadMemoryCueSettings(ctx.engine), note: 'Review the settings, then pass --apply. No provider call or configuration write occurred.' };
  await ctx.engine.transaction(async tx => {
    if (params.min_similarity !== undefined) changes['memory.cues.read_calibration_signature'] = cueSignature(await memoryCueColumn(tx));
    if (params.push_min_similarity !== undefined) changes['memory.cues.push_calibration_signature'] = cueSignature(await memoryCueColumn(tx));
    for (const [key, value] of Object.entries(changes).sort(([a], [b]) => a.localeCompare(b))) await tx.setConfig(key, value);
  });
  return { applied: true, settings: await loadMemoryCueSettings(ctx.engine), note: 'Configuration only. Automatic capture is unchanged; builds need a separately approved spend cap.' };
}

async function advanceLocalBuild(ctx: OperationContext, receipt: MemoryCueBuildReceipt) {
  if (ctx.engine.kind !== 'pglite') return receipt;
  const { runPendingMemoryCueJob } = await import('../memory-cues/index.ts');
  const progress = await runPendingMemoryCueJob(ctx.engine, { jobId: receipt.jobId });
  if (progress?.status === 'failed') {
    throw new OperationError('unavailable', `Cue build ${receipt.buildId} stopped: ${progress.reason ?? 'build_failed'}.`,
      `Inspect gbrain memory-cues status --build-id ${receipt.buildId}. Resume preserves the original budget; a new cap requires a separately approved build.`);
  }
  return { ...receipt, ...(progress ? { status: progress.status, progress } : {}) };
}

export const memoryCueOperations: Operation[] = [{
  name: 'memory_cues',
  description: 'Inspect, configure, preview, build, cancel, or resume optional situation-aware retrieval cues. Trusted local administration only. Generated cues locate original evidence; they are never facts. Generation and retrieval default off. Apply requires explicit source enrollment and a bounded build budget.',
  scope: 'admin',
  localOnly: true,
  mutating: true,
  area: 'admin',
  params: {
    action: { type: 'string', required: true, enum: [...actions], description: 'status, configure, preview, build, cancel, or resume.' },
    source_ids: { type: 'array', items: { type: 'string' }, description: 'At most 1000 explicit source IDs. Build/preview default to the resolved CLI source; configure changes enrollment only when supplied.' },
    families: { type: 'array', items: { type: 'string' }, description: 'Retrieval family selection for controlled ablations: scene, horizon, bridge. Default scene+horizon. Does not generate or rewrite cues; bridge generation additionally needs include_bridge.' },
    apply: { type: 'boolean', description: 'Explicit approval to configure, submit a budgeted build, or cancel. Without it, only preview.' },
    generation_enabled: { type: 'boolean', description: 'Opt into background cue generation for enrolled sources; does not enable conversation capture.' },
    read_mode: { type: 'string', enum: ['off', 'shadow', 'on'], description: 'off preserves ordinary retrieval; shadow measures candidates without changing answers; on admits cues.' },
    push_enabled: { type: 'boolean', description: 'Allow separately calibrated situation reminders within existing context budgets.' },
    min_similarity: { type: 'number', description: 'Explicit encoder-specific cosine threshold for retrieval. Unset means uncalibrated and inactive.' },
    push_min_similarity: { type: 'number', description: 'Separately calibrated cosine threshold for proactive reminders.' },
    weight: { type: 'number', description: 'Total cue fusion vote, greater than zero and at most 0.5; default 0.25.' },
    max_usd: { type: 'number', description: 'Required finite positive lifetime spending cap for a new build, shared across retries and restarts.' },
    page_limit: { type: 'number', description: 'Maximum pages admitted to this build; default 100, maximum 1000.' },
    window_limit: { type: 'number', description: 'Maximum windows processed per page pass; default 8, maximum 8.' },
    include_bridge: { type: 'boolean', description: 'Include experimental fact-level bridges for ablation; default false.' },
    build_id: { type: 'string', description: 'Existing build ID for status, cancellation, or resume without resetting its lifetime budget.' },
  },
  cliHints: { name: 'memory-cues', positional: ['action'] },
  handler: async (ctx, params) => {
    if (ctx.remote !== false || ctx.viaSubagent) throw new OperationError('permission_denied', 'Memory cue administration requires a trusted local CLI caller.');
    if (!actions.includes(params.action as typeof actions[number])) throw new OperationError('invalid_params', 'Unknown memory-cues action.');
    if (params.build_id !== undefined && (typeof params.build_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.build_id))) {
      throw new OperationError('invalid_params', 'build_id must be a UUID.');
    }
    if (params.action === 'configure') return configure(ctx, params);
    const api = await import('../memory-cues/index.ts');
    if (params.action === 'status') return api.getMemoryCueStatus(ctx.engine, { sourceIds: await sourcesFor(ctx, params), buildId: params.build_id as string | undefined });
    if (params.action === 'cancel' || params.action === 'resume') {
      if (typeof params.build_id !== 'string') throw new OperationError('invalid_params', 'A build_id is required.');
      if (ctx.dryRun || params.apply !== true) return { applied: false, buildId: params.build_id, note: `Pass --apply to ${params.action} this build; its original lifetime budget is preserved.` };
      if (params.action === 'resume') return advanceLocalBuild(ctx, await api.resumeMemoryCueBuild(ctx.engine, { buildId: params.build_id, trustedLocal: true }));
      await api.cancelMemoryCueBuild(ctx.engine, { buildId: params.build_id, trustedLocal: true });
      return { applied: true, buildId: params.build_id, cancellationRequested: true };
    }
    const options = {
      sourceIds: await sourcesFor(ctx, params),
      pageLimit: positiveInteger(params.page_limit, 100, 1000, 'page_limit'),
      windowLimit: positiveInteger(params.window_limit, 8, 8, 'window_limit'),
      includeBridge: params.include_bridge === true,
    };
    if (params.action === 'preview' || ctx.dryRun || params.apply !== true) return api.previewMemoryCueBuild(ctx.engine, options);
    if (typeof params.max_usd !== 'number' || !Number.isFinite(params.max_usd) || params.max_usd < 0.01 || params.max_usd > 10000) {
      throw new OperationError('invalid_params', 'Build requires max_usd from 0.01 to 10000.');
    }
    return advanceLocalBuild(ctx, await api.submitMemoryCueBuild(ctx.engine, { ...options, maxUsd: params.max_usd, trustedLocal: true }));
  },
}];
