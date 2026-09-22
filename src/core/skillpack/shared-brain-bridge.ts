import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrainEngine } from '../engine.ts';
import { configDir, type GBrainConfig } from '../config.ts';
import { checkedRoot, confinedPath, sha256, privateWrite, readFileConfigState } from '../agent-install/state.ts';
import { findBridgeEntry, loadBridgeState } from './bridge-state.ts';
import { isUndefinedTableError } from '../utils.ts';
import { createSharedSkillsAdapter, type SharedSkillsToolCaller } from '../shared-skills/adapter.ts';
import { readLocalWriter, registerLocalWriter, withVerifiedLocalRegistration } from '../persistence/identity.ts';
import { renderAgentLauncher } from '../agent-install/launcher.ts';
import { resolveSourceWithTier, ALL_SOURCES } from '../source-resolver.ts';
import { resolveBrainId } from '../brain-resolver.ts';
import { acquireBootstrapLock } from '../bootstrap/lock.ts';
import { assertLegacySkillFilesystemWrite } from './writer-guard.ts';

export async function sharedBrainBridgePlan(options: {
  engine: BrainEngine | null;
  config: GBrainConfig | null;
  harness: string;
  dest?: string;
  statePath?: string;
}) {
  let active = !!options.config?.remote_mcp;
  let unavailable = false;
  if (!active && options.engine) {
    try {
      const [brain] = await options.engine.executeRaw<{ skill_bundles_enabled: boolean }>('SELECT skill_bundles_enabled FROM persistence_brain WHERE singleton=1');
      active = brain?.skill_bundles_enabled === true;
    } catch (error) {
      if (!isUndefinedTableError(error)) unavailable = true;
    }
  } else if (!active && (options.config?.database_url || options.config?.database_path || options.config?.engine === 'pglite')) unavailable = true;
  if (!active && !unavailable) return null;
  const migration = { owned_unchanged: [] as string[], modified: [] as string[], missing: [] as string[], ownership: 'unverified' };
  if (options.dest) {
    const entry = findBridgeEntry(loadBridgeState({ statePath: options.statePath }), { harness: options.harness, dest: options.dest });
    if (entry) {
      migration.ownership = 'ledger';
      const files = new Map(Object.values(entry.written).flatMap(record => Object.entries(record.files)));
      if (files.size > 2048) migration.modified.push('(inventory limit exceeded)');
      else for (const [relative, expected] of files) {
        try {
          const path = confinedPath(checkedRoot(options.dest), relative);
          if (!existsSync(path)) { migration.missing.push(relative); continue; }
          const stat = lstatSync(path);
          if (!stat.isFile() || stat.size > 8 * 1024 * 1024 || sha256(readFileSync(path)) !== expected) migration.modified.push(relative);
          else migration.owned_unchanged.push(relative);
        } catch { migration.modified.push(relative); }
      }
    }
  }
  const reason = migration.modified.length ? 'legacy_skill_conflict' : migration.owned_unchanged.length
    ? 'legacy_skill_migration_required' : unavailable ? 'shared_brain_unavailable' : 'follow_approval_required';
  return {
    status: 'pending', reason, native: 'unverified', legacy_copy_written: false, migration,
    next_action: migration.modified.length
      ? 'Preserve the modified legacy skills and resolve their native shadow copies before enrolling. No copied bodies, pointers, or unrelated native skills were changed.'
      : migration.owned_unchanged.length
        ? 'Review and explicitly remove the unchanged bridge-owned copies with skillpack remove for this harness and destination, then use the shared-skills connection installer with an approved follow policy. No legacy copy was removed automatically.'
        : unavailable
          ? 'Reconnect the selected brain and verify its shared catalog before installing skills. Memory and existing native files are unchanged; unavailable is not a legacy-copy fallback.'
          : options.config?.remote_mcp
            ? 'Use the existing remote private-handoff connection installer with explicit follow approval and a skills_member_self grant for join_brain, sync_brain_skills, leave_brain and catalog reads. Do not mint against a local brain or install bundled copies.'
            : 'Use bootstrap harness with explicit shared-skills follow approval, or the installation-bound setup for a personal agent. Confirm the intended source and self-member grant; skillpack scaffold does not invent an enrollment credential or install stale bundled copies.',
  };
}

export async function installSharedBrainBridge(options: {
  engine: BrainEngine | null;
  config: GBrainConfig | null;
  harness: string;
  dest?: string;
  policy?: 'follow' | 'memory-only';
  dryRun?: boolean;
  statePath?: string;
}) {
  const plan = await sharedBrainBridgePlan(options);
  if (!plan) return options.policy ? {
    status: 'pending', reason: options.policy === 'follow' ? 'shared_content_migration_required' : 'memory_only', native: 'unverified', legacy_copy_written: false,
    migration: { owned_unchanged: [] as string[], modified: [] as string[], missing: [] as string[], ownership: 'unverified' },
    next_action: options.policy === 'follow' ? 'Activate the selected brain’s shared content through the reviewed host migration before following. No legacy body or stub was installed as a substitute.'
      : 'Memory-only was selected. No bundled skill copies or shared routers were installed.',
  } : null;
  if (options.config?.remote_mcp || !options.engine || !options.config || options.dryRun ||
    plan.migration.modified.length || plan.migration.owned_unchanged.length) return plan;
  if (!options.dest) return { ...plan, reason: 'native_destination_required', next_action: 'Specify a supported native skill destination before approving shared following. No native installation is inferred.' };
  const engine = options.engine, config = options.config;
  const pending = (reason: string, next_action: string) => ({ ...plan, reason, next_action });
  const home = dirname(configDir());
  const stored = readFileConfigState(join(configDir(), 'config.json'));
  if (resolveBrainId(null) !== 'host' || stored.kind !== 'present' || stored.config.engine !== config.engine ||
    stored.config.database_url !== config.database_url || stored.config.database_path !== config.database_path) {
    return pending('bound_connection_required', 'The selected brain depends on ambient routing. Use an installation-bound connection instead of creating a launcher that could select another brain.');
  }
  const source = await resolveSourceWithTier(engine, null);
  if (source.source_id === ALL_SOURCES) return pending('source_approval_required', 'Select one explicit source for the native shared router before approving following.');
  const dest = checkedRoot(options.dest);
  try { assertLegacySkillFilesystemWrite(dest); }
  catch { return pending('canonical_destination_refused', 'Native router installation cannot write into a managed canonical source. Choose the harness’s separate native skills directory; publish canonical skill changes through the catalog.'); }
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  const key = sha256(JSON.stringify([brain.brain_id, source.source_id, options.harness, dest])).slice(0, 32);
  const root = join(configDir(), 'skillpack-shared', key);
  const receiptPath = confinedPath(root, 'installation.json');
  const priorText = existsSync(receiptPath) ? readFileSync(receiptPath, 'utf8') : null;
  let prior: { policy?: string; launcher_hash?: string; pending_hash?: string } = {};
  if (priorText !== null) {
    try {
      prior = JSON.parse(priorText);
      if (!prior || typeof prior !== 'object' || Array.isArray(prior)) throw new Error('invalid receipt');
    }
    catch { return pending('local_conflict', 'Preserve the unreadable shared bridge receipt before retrying.'); }
  }
  const policy = options.policy ?? prior.policy;
  if (policy !== 'follow' && policy !== 'memory-only') return plan;
  if (policy === 'memory-only' && !existsSync(join(root, 'shared-skills', 'receipt.json'))) return {
    ...plan, reason: 'memory_only', next_action: 'Shared following is disabled. Memory and unrelated native skills are unchanged.',
  };
  const launcher = confinedPath(root, 'gbrain');
  const sourceCli = fileURLToPath(new URL('../../cli.ts', import.meta.url));
  const content = renderAgentLauncher({ root: home, sourceId: source.source_id, bunPath: process.execPath,
    cliPath: sourceCli.includes('$bunfs') ? undefined : sourceCli });
  const actual = existsSync(launcher) ? sha256(readFileSync(launcher)) : null;
  if (actual !== null && ![prior.launcher_hash, prior.pending_hash].includes(actual)) return pending('local_conflict', 'The installation-bound launcher was edited or is unowned. Preserve it before retrying.');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = await acquireBootstrapLock(root);
  try {
    if ((existsSync(receiptPath) ? readFileSync(receiptPath, 'utf8') : null) !== priorText) return pending('local_conflict', 'Another installer changed the shared bridge receipt. Retry without overwriting it.');
    const current = existsSync(launcher) ? sha256(readFileSync(launcher)) : null;
    if (current !== actual) return pending('local_conflict', 'The installation-bound launcher changed while installing. Preserve it and retry.');
    privateWrite(receiptPath, `${JSON.stringify({ ...prior, policy, pending_hash: sha256(content) })}\n`);
    if (current !== sha256(content)) privateWrite(launcher, content, 0o700);
    privateWrite(receiptPath, `${JSON.stringify({ policy, launcher_hash: sha256(content) })}\n`);
    const { operationsByName } = await import('../operations.ts');
    const ctx = { engine, config, sourceId: source.source_id, remote: false, dryRun: false,
      logger: { info() {}, warn() {}, error() {} } };
    const allowed = new Set(['join_brain', 'sync_brain_skills', 'leave_brain', 'get_skill', 'get_skill_asset']);
    const call: SharedSkillsToolCaller = async <T>(name: string, params: Record<string, unknown>): Promise<T> => {
      if (!allowed.has(name) || !operationsByName[name]) throw new Error('unsupported shared-skills operation');
      const registration = policy === 'follow' ? await registerLocalWriter(engine, 'cli') : await readLocalWriter(engine, 'cli');
      return await withVerifiedLocalRegistration(engine, registration, async () => await operationsByName[name].handler(ctx, params) as T);
    };
    const adapter = createSharedSkillsAdapter({ call, root: join(root, 'shared-skills'), adapter: options.harness,
      launcher, nativeSkillsDir: dest, connectionName: `bridge-${key}` });
    const result = policy === 'follow' ? await adapter.join({ approved: true, source_ids: [source.source_id] }) : await adapter.leave();
    if ('remote_membership_pending' in result && result.remote_membership_pending) return { ...plan, ...result, status: 'pending', reason: 'remote_membership_pending',
      next_action: 'Owned local router cleanup completed, but enrollment closure remains pending. Repair the existing local writer and retry memory-only cleanup; no new authority was created.' };
    return { ...plan, ...result, source_id: source.source_id, launcher, reason: policy === 'follow' ? 'native_activation_unverified' : 'memory_only' };
  } catch {
    return pending('shared_enrollment_unavailable', 'Memory and unrelated files are preserved. Verify local writer authority, follow policy and the owned router/cache, then retry; native activation is unverified.');
  } finally { lock.release(); }
}
