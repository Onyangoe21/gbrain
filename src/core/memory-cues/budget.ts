import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { reserveBudget, refundBudget } from '../minions/budget-tracker.ts';
import { maximumInvocationCents } from '../minions/delegated-spend.ts';
import { withAIInvocationGuard, type AIInvocation, type AIInvocationUsage } from '../ai/invocation-guard.ts';
import { canonicalLookup } from '../model-pricing.ts';
import { lookupEmbeddingPrice } from '../embedding-pricing.ts';
import { assertCueBuildAuthority, type CueBuildRow } from './builds.ts';
import { cueSnapshotSql } from './storage.ts';

export interface CueBudgetContext {
  build: CueBuildRow;
  token: string;
  pageId: number;
  snapshot: string;
  windowIndex: number;
  inputTokenCeiling?: number;
}

export async function reserveCueAttempt(engine: BrainEngine, context: CueBudgetContext, call: AIInvocation): Promise<{ id: string; cents: number }> {
  const maximum = maximumInvocationCents(call);
  if (maximum === null) throw new Error('pricing_unknown');
  const cents = Math.max(1, Math.ceil(maximum));
  return engine.transaction(async tx => {
    await tx.executeRaw('SELECT id FROM memory_cue_builds WHERE id=$1::uuid FOR UPDATE', [context.build.id]);
    await assertCueBuildAuthority(tx, context.build, context.token);
    const [page] = await tx.executeRaw(`SELECT id FROM pages p WHERE id=$1 AND ${cueSnapshotSql}=$2 FOR SHARE`, [context.pageId, context.snapshot]);
    if (!page) throw new Error('snapshot_superseded');
    const result = await reserveBudget(tx, context.build.owner_identity, cents);
    if (result.kind !== 'reserved') throw new Error(result.kind === 'exhausted' ? 'budget_exhausted' : 'budget_owner_missing');
    const id = randomUUID();
    await tx.executeRaw(`INSERT INTO memory_cue_attempts(id,build_id,page_id,snapshot,window_index,reserved_cents) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6)`,
      [id, context.build.id, context.pageId, context.snapshot, context.windowIndex, cents]);
    return { id, cents };
  });
}

export async function settleCueAttempt(engine: BrainEngine, build: CueBuildRow, id: string, actualCents: number | null): Promise<void> {
  if (actualCents === null || !Number.isFinite(actualCents) || actualCents < 0) return;
  await engine.transaction(async tx => {
    const [attempt] = await tx.executeRaw<{ reserved_cents: number }>(`UPDATE memory_cue_attempts SET settled=true,actual_cents=$2
      WHERE id=$1::uuid AND NOT settled RETURNING reserved_cents`, [id, Math.ceil(actualCents)]);
    if (attempt) await refundBudget(tx, build.owner_identity, build.owner_identity, Math.max(0, attempt.reserved_cents - Math.ceil(actualCents)));
  });
}

function measuredCents(call: AIInvocation, usage: AIInvocationUsage | null): number | null {
  if (!usage) return null;
  if (call.kind === 'embedding') {
    const price = lookupEmbeddingPrice(call.model);
    return price.kind === 'known' ? usage.inputTokens * price.pricePerMTok / 10000 : null;
  }
  const price = canonicalLookup(call.model);
  if (!price) return null;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output
    + (usage.cacheReadTokens ?? 0) * (price.cache_read ?? price.input)
    + (usage.cacheWriteTokens ?? 0) * (price.cache_write ?? price.input * 2)) / 10000;
}

export function withCueSpend<T>(engine: BrainEngine, context: CueBudgetContext, run: () => Promise<T>): Promise<T> {
  return withAIInvocationGuard(async call => {
    if (!['chat', 'embedding'].includes(call.kind)) throw new Error('unsupported_provider_call');
    if (call.kind === 'chat' && call.model !== context.build.generation_model) throw new Error('model_changed');
    const boundedCall = { ...call, maxInputTokens: call.kind === 'chat' ? context.inputTokenCeiling : 4096 };
    const hold = await reserveCueAttempt(engine, context, boundedCall);
    return { settle: async usage => { await settleCueAttempt(engine, context.build, hold.id, measuredCents(call, usage)); } };
  }, run);
}
