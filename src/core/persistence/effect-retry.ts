import type { BrainEngine } from '../engine.ts';
import { loadConfigWithEngine, type GBrainConfig } from '../config.ts';
import { MAX_RATE_LIMIT_RETRIES } from '../embed-retry.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { authorizeStoredRequest, authorizeWrite, submissionAuthority } from './authority.ts';
import { existingLocalHostId } from './identity.ts';
import { guardEffectSource } from './effect-recovery.ts';
import { readEmbeddingEffectProjection, selectedEffectPage } from './effects.ts';
import type { PersistenceEffect } from './effect-model.ts';
import type { WriteRequest } from './model.ts';

export async function retryEmbeddingEffect(engine: BrainEngine, sourceId: string, requestId: string, dryRun: boolean, baseConfig?: GBrainConfig): Promise<Record<string, unknown>> {
  const requests = await engine.executeRaw<WriteRequest>(`SELECT r.* FROM persistence_requests r WHERE source_id=$1 AND request_id=$2::uuid
    AND EXISTS (SELECT 1 FROM persistence_effects e WHERE e.request_id=r.id AND e.kind='embedding') LIMIT 2`, [sourceId, requestId]);
  if (requests.length !== 1) throw new OperationError('invalid_params', 'The source and request must identify exactly one embedding obligation.');
  const request = requests[0];
  const hostId = existingLocalHostId();
  if (!hostId) throw new OperationError('permission_denied', 'Retry requires the registered local CLI host.');
  const config = await loadConfigWithEngine(engine, baseConfig);
  const signature = config?.embedding_model && config.embedding_dimensions
    ? `${config.embedding_model}:${config.embedding_dimensions}` : null;
  return engine.transaction(async tx => {
    const [selected] = await tx.executeRaw<PersistenceEffect>("SELECT * FROM persistence_effects WHERE request_id=$1::uuid AND kind='embedding'", [request.id]);
    if (!selected) throw new OperationError('invalid_params', 'The embedding obligation is unavailable.');
    await guardEffectSource(tx, selected, hostId);
    await authorizeStoredRequest(tx, request, true);
    const authority = await submissionAuthority({ engine: tx, remote: false, sourceId } as OperationContext,
      request.operation, sourceId, request.source_incarnation, request.slug);
    await authorizeWrite(tx, authority, request.operation, request.slug, true);
    if (request.state !== 'committed') throw new OperationError('write_pending', 'Only committed canonical requests have retryable embedding obligations.');
    const [effect] = await tx.executeRaw<PersistenceEffect>('SELECT * FROM persistence_effects WHERE id=$1 FOR UPDATE', [selected.id]);
    if (!effect || effect.source_id !== sourceId || effect.source_incarnation !== request.source_incarnation || effect.recovery) {
      throw new OperationError('source_changed', 'The effect source or recovery state changed.');
    }
    const snapshot = await selectedEffectPage(tx, effect);
    const scanComplete = effect.data.source_scan === true && !snapshot;
    if (!scanComplete && (!snapshot || snapshot.page.deleted_at || !effect.data.source_scan &&
      (snapshot.revision !== effect.revision || snapshot.page.id !== effect.data.page_id))) {
      throw new OperationError('revision_conflict', 'The original embedding obligation is superseded; inspect the current page instead.');
    }
    if (snapshot) {
      await authorizeWrite(tx, request.authority, request.operation, snapshot.page.slug, true);
      await authorizeWrite(tx, authority, request.operation, snapshot.page.slug, true);
    }
    const receipt = { request_id: request.request_id, source_id: sourceId, kind: 'embedding', attempts: effect.attempts,
      retry_limit: MAX_RATE_LIMIT_RETRIES, dry_run: dryRun };
    if (effect.state !== 'failed') {
      if (effect.data.embedding_retry_base !== undefined || effect.state === 'committed') return { ...receipt, state: effect.state, action: 'unchanged',
        next_action: 'Inspect this same receipt; this command does not authorize another retry cycle.' };
      throw new OperationError('effect_not_failed', 'Only a failed, non-running embedding effect can be explicitly retried.');
    }
    if (effect.execution_token !== null) throw new OperationError('write_claim_lost', 'A failed effect still has an execution claim; inspect it before retrying.');
    if (!signature && !scanComplete) return { ...receipt, state: 'failed', action: 'blocked', reason: 'embedding_unconfigured', next_action: 'Configure embeddings, then inspect this request again.' };
    const pending = scanComplete ? [] : (await readEmbeddingEffectProjection(tx, effect, snapshot!, hostId, signature!)).pending;
    const complete = scanComplete || pending.length === 0 && !effect.data.source_scan;
    if (!complete && (config?.embedding_disabled || effect.data.embedding_retry_base !== undefined)) {
      return { ...receipt, state: 'failed', action: 'blocked', reason: config?.embedding_disabled ? 'embedding_disabled' : 'embedding_retry_exhausted',
        next_action: config?.embedding_disabled ? 'Embedding remains disabled; explicitly configure it before retrying.' : 'The explicit retry allowance is already consumed. Inspect the provider and use a separately approved scoped repair.' };
    }
    if (dryRun) return { ...receipt, state: 'failed', action: complete ? 'would_reconcile' : 'would_retry',
      pending_chunks: pending.length, next_action: 'Run the same command without --dry-run to approve this bounded action.' };
    const [updated] = await tx.executeRaw<{ state: string }>(`UPDATE persistence_effects SET state=$4,
      data=CASE WHEN $4='queued' THEN data||jsonb_build_object('embedding_attempt_base',attempts,'embedding_retry_base',attempts) ELSE data END,
      error_code=NULL,claim_expires_at=NULL,next_attempt_at=now(),updated_at=now(),
      outcome=CASE WHEN $4='committed' THEN '{"embedding":"reconciled"}'::jsonb ELSE NULL END
      WHERE id=$1 AND state='failed' AND execution_token IS NULL AND recovery IS NULL AND attempts=$2 AND source_incarnation=$3::uuid RETURNING state`,
    [effect.id, effect.attempts, effect.source_incarnation, complete ? 'committed' : 'queued']);
    if (!updated) throw new OperationError('write_claim_lost', 'The embedding obligation changed during retry approval.');
    return { ...receipt, state: updated.state, action: complete ? 'reconciled' : 'retry_queued', pending_chunks: pending.length,
      next_action: complete ? 'The existing vectors satisfy this obligation; no provider work was scheduled.' : 'The resident owner may spend up to five attempts under the existing provider and job budget policy. Repeating this command does not renew that allowance.' };
  });
}
