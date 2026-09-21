import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { isValidSourceId } from '../source-id.ts';
import { assertNoOverlappingPath } from '../sources-ops.ts';
import { checkApprovedSchemaForEngine } from '../schema-pack/engine-resolution.ts';
import { getWorktreeBinding, managedPersistenceEnabled } from '../persistence/ownership.ts';
import { registerLocalWriter, localHostId, currentVerifiedLocalWriter } from '../persistence/identity.ts';
import { isWriteRequestId } from '../persistence/types.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { topologyTransaction } from '../persistence/topology-transaction.ts';
import { lockTopologyRows, lockTopologyPrincipal, topologyPrincipal, withTopologyLocks } from '../persistence/topology-locks.ts';
import { priorTopologyChange, recordTopologyChange } from '../persistence/topology-receipts.ts';
import { runManagedSourceLifecycle } from '../persistence/source-lifecycle.ts';
import { validateCompanyBrainPlan } from './inspection.ts';
import { beginSourceIngestionReceipt, linkSourceIngestionCheckpoints, type SourceIngestionFence } from './receipts.ts';
import type { CompanyBrainPlan } from './types.ts';
import type { CompanyBrainProfile } from './profile.ts';

export interface CompanyBrainDestination {
  brainId: string;
  sourceId: string;
  remote: boolean;
}
export interface CompanyBrainConnectInput extends CompanyBrainDestination {
  plan: CompanyBrainPlan;
  path: string;
  requestId?: string;
}
export function unwrapCompanyBrainPlan(value: unknown): CompanyBrainPlan {
  if (value && typeof value === 'object' && 'plan' in value) value = (value as { plan: unknown }).plan;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('plan_digest' in value)) {
    throw new OperationError('plan_stale', 'A raw inspection plan or inspection envelope with plan is required.');
  }
  return value as CompanyBrainPlan;
}
export interface CompanyBrainPreview {
  brainId: string;
  databaseId: string;
  sourceId: string;
  managed: boolean;
  schemaBinding: string | null;
  policy: { audience: 'internal'; existingBroadGrants: number; grantsUnchanged: true; federated: false };
  planDigest: string;
  approvedRevision: string;
}

export function assertCompanyBrainCaller(input: CompanyBrainDestination): void {
  const authority = currentSubmissionAuthority();
  if (input.remote !== false || currentVerifiedLocalWriter()?.remote || authority?.kind === 'remote_agent' || authority?.kind === 'remote_generic') {
    throw new OperationError('permission_denied', 'Company source administration requires an explicitly trusted local caller.');
  }
  if (typeof input.brainId !== 'string' || !input.brainId.trim() || !isValidSourceId(input.sourceId)) {
    throw new OperationError('destination_not_ready', 'An explicitly selected initialized brain and source ID are required.');
  }
}

export async function ingestionFence(engine: BrainEngine, sourceId: string): Promise<SourceIngestionFence> {
  if (!await managedPersistenceEnabled(engine)) return { mode: 'unmanaged' };
  const binding = await getWorktreeBinding(engine, sourceId);
  if (!binding?.owner_host_id || binding.owner_host_id !== localHostId() || binding.state !== 'active' || !binding.local_path) {
    throw new OperationError('owner_unavailable', 'The managed source must run on its active registered local owner.');
  }
  return { mode: 'managed', worktreeId: binding.worktree_id, ownerHostId: binding.owner_host_id,
    ownerEpoch: String(binding.owner_epoch), topologyGeneration: String(binding.topology_generation) };
}

async function assertIngestionStorage(engine: BrainEngine): Promise<void> {
  const [storage] = await engine.executeRaw<{ receipts: string | null; persistence: string | null }>(
    "SELECT to_regclass('source_ingestion_receipts')::text AS receipts,to_regclass('persistence_brain')::text AS persistence");
  if (!storage?.receipts || !storage.persistence) throw new OperationError('destination_not_ready', 'The selected brain needs company ingestion migration 160.',
    'Run gbrain apply-migrations --yes against the explicitly selected brain, then preview again.');
}

export async function checkCompanyBrainDestination(engine: BrainEngine, input: CompanyBrainConnectInput, newSource = true): Promise<CompanyBrainPreview> {
  assertCompanyBrainCaller(input);
  await assertIngestionStorage(engine);
  if (!input.plan.ready || !input.plan.revision || !input.plan.schema) throw new OperationError('source_not_ready', 'The inspected source is not ready to connect.');
  const [brain] = await engine.executeRaw<{ brain_id: string; enabled: boolean }>('SELECT brain_id,enabled FROM persistence_brain WHERE singleton=1');
  if (!brain) throw new OperationError('destination_not_ready', 'Initialize the selected brain before connecting a source.');
  if (newSource && (await engine.executeRaw('SELECT id FROM sources WHERE id=$1', [input.sourceId])).length) {
    throw new OperationError('source_id_taken', 'Connect requires a new source. Resume the existing source through sync.');
  }
  const requirements = input.plan.audience_requirements;
  if (requirements.some(value => !['internal', 'public', 'world'].includes(value))) {
    throw new OperationError('destination_not_ready', 'The source requires a narrower audience policy; no access grants will be inferred or changed.');
  }
  const schema = input.plan.schema;
  const checked = await checkApprovedSchemaForEngine(engine, { name: schema.name, identity: schema.identity, resolvedManifestHash: schema.resolved_digest },
    { sourceId: input.sourceId, remote: false, allowBinding: true });
  if (checked.binding) {
    const [page] = await engine.executeRaw('SELECT id FROM pages LIMIT 1');
    const [profile] = await engine.executeRaw("SELECT id FROM sources WHERE config->'company_brain' IS NOT NULL LIMIT 1");
    if (page || profile) throw new OperationError('destination_not_ready', 'An occupied brain must already use the exact company schema. Mixed-schema admission is not supported.');
  }
  const [broad] = await engine.executeRaw<{ count: string }>(
    `SELECT count(*)::text AS count FROM (
      SELECT client_id AS id FROM oauth_clients WHERE deleted_at IS NULL AND source_id IS NULL AND cardinality(federated_read)=0
        AND (scope IS NULL OR scope ~ '(^|\\s)(read|admin)(\\s|$)') AND (allowed_operations IS NULL OR cardinality(allowed_operations)>0)
      UNION ALL SELECT id::text FROM persistence_local_writers WHERE lane='stdio' AND revoked_at IS NULL
        AND grant_ceiling->'sourceIds' ? '*' AND grant_ceiling->'scopes' ? 'read'
    ) grants`);
  return { brainId: input.brainId, databaseId: brain.brain_id, sourceId: input.sourceId, managed: brain.enabled,
    schemaBinding: checked.binding?.value ?? null, policy: { audience: 'internal', existingBroadGrants: Number(broad?.count ?? 0), grantsUnchanged: true, federated: false },
    planDigest: input.plan.plan_digest, approvedRevision: input.plan.revision.commit };
}

export async function previewCompanyBrain(engine: BrainEngine, input: CompanyBrainConnectInput): Promise<CompanyBrainPreview> {
  input = { ...input, plan: unwrapCompanyBrainPlan(input.plan) };
  assertCompanyBrainCaller(input);
  const checked = await validateCompanyBrainPlan(input.plan, { path: input.path, mode: 'apply' });
  if (!checked.valid) throw new OperationError(checked.code, 'The source no longer matches its approved inspection plan.');
  return checkCompanyBrainDestination(engine, input);
}

export async function admitCompanyBrain(engine: BrainEngine, input: CompanyBrainConnectInput): Promise<{ receiptId: string; sourceIncarnation: string }> {
  input = { ...input, plan: unwrapCompanyBrainPlan(input.plan) };
  assertCompanyBrainCaller(input);
  await assertIngestionStorage(engine);
  const requestId = input.requestId ?? randomUUID();
  if (!isWriteRequestId(requestId)) throw new OperationError('invalid_params', 'requestId must be a UUID.');
  if (!input.plan.revision || !input.plan.schema) throw new OperationError('source_not_ready', 'A committed source and approved schema are required.');
  const plan = input.plan;
  const profile: CompanyBrainProfile = { version: 1, profile: 'company-brain', brainId: input.brainId, receiptId: requestId,
    planDigest: plan.plan_digest, selection: plan.selection, limits: plan.limits, schema: plan.schema!, extractorVersion: plan.extractor_version,
    approvedRevision: plan.revision!.commit, committedOnly: true, noPull: true, noEmbed: true, noBackfill: true, noWriteback: true };
  const config = { federated: false, strategy: 'markdown', slug_root_mode: 'source-root', company_brain: profile };
  if (Buffer.byteLength(JSON.stringify(config)) > 8192) throw new OperationError('request_too_large', 'The approved selection exceeds source policy capacity; narrow the selection.');
  await registerLocalWriter(engine, 'cli');
  const before = async (tx: BrainEngine) => {
    await tx.executeRaw("SELECT key FROM config WHERE key='schema_pack' FOR UPDATE");
    const preview = await checkCompanyBrainDestination(tx, input);
    const validation = await validateCompanyBrainPlan(plan, { path: input.path, mode: 'apply' });
    if (!validation.valid) throw new OperationError(validation.code, 'The source changed before admission; inspect it again.');
    await assertNoOverlappingPath(tx, input.sourceId, plan.revision!.root);
    if (preview.schemaBinding) await tx.setConfig('schema_pack', preview.schemaBinding);
  };
  const after = async (tx: BrainEngine, incarnation: string) => {
    const fence = await ingestionFence(tx, input.sourceId);
    const receipt = await beginSourceIngestionReceipt(tx, { id: requestId, sourceId: input.sourceId, sourceIncarnation: incarnation,
      approvedRevision: plan.revision!.commit, profile: 'company-brain', schemaFingerprint: plan.schema!.resolved_digest,
      extractorVersion: plan.extractor_version, fence, lifecycleRequestIds: [requestId] });
    await linkSourceIngestionCheckpoints(tx, { receiptId: receipt.id, sourceId: input.sourceId, sourceIncarnation: incarnation,
      expectedRevision: receipt.revision, expectedPhase: receipt.phase, fence,
      checkpoints: [{ op: 'company-brain-plan', fingerprint: requestId, kind: 'manifest' }] });
    await tx.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('company-brain-plan',$1,$2::text::jsonb)", [requestId, JSON.stringify([plan])]);
  };
  if (await managedPersistenceEnabled(engine)) {
    const result = await runManagedSourceLifecycle(engine, { operation: 'add', sourceId: input.sourceId, path: plan.revision!.root,
      requestId, config, requireGitContent: true }, { before, after });
    return { receiptId: requestId, sourceIncarnation: String(result.source_incarnation) };
  }
  const principal = await topologyPrincipal(engine);
  const intent = { operation: 'company-brain-connect', brainId: input.brainId, sourceId: input.sourceId, path: input.path, planDigest: plan.plan_digest };
  return withTopologyLocks(engine, input.sourceId, bindings => topologyTransaction(engine, async tx => {
    await lockTopologyRows(tx, input.sourceId, bindings);
    await lockTopologyPrincipal(tx, principal);
    const prior = await priorTopologyChange(tx, principal, requestId, intent);
    if (prior) return { receiptId: requestId, sourceIncarnation: prior.source_incarnation! };
    await before(tx);
    const incarnation = randomUUID();
    await tx.executeRaw('INSERT INTO sources(id,name,local_path,config,incarnation) VALUES($1,$1,$2,$3::text::jsonb,$4::uuid)',
      [input.sourceId, plan.revision!.root, JSON.stringify(config), incarnation]);
    await after(tx, incarnation);
    await recordTopologyChange(tx, { principal, requestId, intent, operation: 'company-brain-connect', sourceId: input.sourceId, incarnation, worktrees: [] },
      { source_id: input.sourceId, source_incarnation: incarnation, receipt_id: requestId });
    return { receiptId: requestId, sourceIncarnation: incarnation };
  }), plan.revision!.git_root);
}
