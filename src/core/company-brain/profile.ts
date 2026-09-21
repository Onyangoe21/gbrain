import { AsyncLocalStorage } from 'node:async_hooks';
import { basename, relative } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { parseSourceConfig } from '../sources-load.ts';
import { importFromContent } from '../import-file.ts';
import { readCommittedBlob } from './revision.ts';
import { parseMarkdown } from '../markdown.ts';
import { prepareCanonicalProjections } from '../persistence/canonical-projections.ts';
import { digest } from '../persistence/digest.ts';
import type { ResolvedPack } from '../schema-pack/registry.ts';
import type { CompanyBrainPlan, InspectionEntry } from './types.ts';
import type { SourceIngestionCheckpoint } from './receipts.ts';

export interface CompanyBrainProfile {
  version: 1;
  profile: 'company-brain';
  brainId: string;
  receiptId: string;
  planDigest: string;
  selection: CompanyBrainPlan['selection'];
  limits: CompanyBrainPlan['limits'];
  schema: NonNullable<CompanyBrainPlan['schema']>;
  extractorVersion: string;
  approvedRevision: string;
  committedOnly: true;
  noPull: true;
  noEmbed: true;
  noBackfill: true;
  noWriteback: true;
}

export function companyBrainProfile(config: unknown): CompanyBrainProfile | null {
  const value = parseSourceConfig(config).company_brain;
  if (value === undefined) return null;
  const p = value as CompanyBrainProfile;
  if (!p || p.version !== 1 || p.profile !== 'company-brain' || !p.brainId || !p.receiptId || !p.planDigest ||
      !p.selection || !p.limits || !p.schema || !p.extractorVersion || !p.approvedRevision ||
      [p.committedOnly, p.noPull, p.noEmbed, p.noBackfill, p.noWriteback].some(flag => flag !== true)) {
    throw new OperationError('profile_incompatible', 'The persisted company profile is invalid; inspect its source policy before syncing.');
  }
  return p;
}

export async function getCompanyBrainProfile(engine: BrainEngine, sourceId: string): Promise<CompanyBrainProfile | null> {
  const [source] = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id=$1', [sourceId]);
  return source ? companyBrainProfile(source.config) : null;
}

export interface CompanyBrainSyncContext {
  sourceId: string;
  sourceIncarnation: string;
  receiptId: string;
  plan: CompanyBrainPlan;
  entries: ReadonlyMap<string, InspectionEntry>;
  pack: ResolvedPack;
  failureCode?: string;
  protect(checkpoints: SourceIngestionCheckpoint[]): Promise<void>;
}
const active = new AsyncLocalStorage<CompanyBrainSyncContext>();
export const withCompanyBrainSync = <T>(context: CompanyBrainSyncContext, run: () => T): T => active.run(context, run);
export function currentCompanyBrainSync(sourceId?: string): CompanyBrainSyncContext | undefined {
  const context = active.getStore();
  return context?.sourceId === sourceId ? context : undefined;
}

export async function withCompanyBrainSource<T>(engine: BrainEngine, sourceId: string | undefined, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
  const context = currentCompanyBrainSync(sourceId);
  if (!context) return run(engine);
  return engine.transaction(async tx => {
    const [source] = await tx.executeRaw<{ incarnation: string; config: unknown }>('SELECT incarnation,config FROM sources WHERE id=$1 AND NOT archived FOR SHARE', [sourceId!]);
    if (!source || source.incarnation !== context.sourceIncarnation || companyBrainProfile(source.config)?.receiptId !== context.receiptId) {
      throw new OperationError('source_changed', 'The source incarnation or approved ingestion changed before publication.');
    }
    return run(tx);
  });
}

export function softDeleteSyncPages(engine: BrainEngine, slugs: string[], opts: { sourceId: string }): Promise<string[]> {
  return withCompanyBrainSource(engine, opts.sourceId, tx => tx.softDeletePages(slugs, opts));
}

export async function readCompanyBrainPlan(engine: BrainEngine, receiptId: string): Promise<CompanyBrainPlan> {
  const [row] = await engine.executeRaw<{ completed_keys: CompanyBrainPlan[] }>(
    "SELECT completed_keys FROM op_checkpoints WHERE op='company-brain-plan' AND fingerprint=$1", [receiptId]);
  if (!row?.completed_keys?.[0]) throw new OperationError('checkpoint_missing', 'The approved source plan is missing; do not restart from a different revision.');
  return row.completed_keys[0];
}

export async function importCompanyBrainFile(engine: BrainEngine, filePath: string, sourceId: string) {
  const context = currentCompanyBrainSync(sourceId);
  if (!context?.plan.revision) throw new OperationError('plan_stale', 'An approved committed source plan is required.');
  const path = relative(context.plan.revision.root, filePath).split('\\').join('/');
  const entry = context.entries.get(path);
  if (!entry?.page || entry.disposition !== 'included') throw new OperationError('plan_stale', 'The import path is outside the approved selection.');
  const content = (await readCommittedBlob(context.plan.revision, entry, context.plan.limits)).toString('utf8');
  const pack = context.pack;
  const parsed = parseMarkdown(content, entry.page.slug, { activePack: pack.manifest });
  const snapshot = await engine.readPageSnapshot(entry.page.slug, { sourceId });
  const canonical = (page: Pick<typeof parsed, 'type' | 'title' | 'compiled_truth' | 'timeline' | 'frontmatter'>, tags: string[]) => ({ type: page.type, title: page.title, body: page.compiled_truth,
    timeline: page.timeline ?? '', frontmatter: page.frontmatter, tags: [...new Set(tags)].sort() });
  return importFromContent(engine, entry.page.slug, content, { sourceId, noEmbed: true, remote: false,
    activePack: pack.manifest, filename: basename(path).replace(/\.mdx?$/i, ''), sourcePath: path,
    prepare: async ready => {
      const tags = [...(snapshot?.tags ?? []), ...ready.parsedPage.tags];
      if (digest(canonical(parsed, parsed.tags)) !== digest(canonical(ready.parsedPage, tags))) {
        throw new OperationError('source_writeback_required', 'Canonical preparation requires a source-content correction; this profile never writes repository files.');
      }
      if (ready.slug !== entry.page!.slug || ready.observedRevision !== (snapshot?.revision ?? null)) {
        throw new OperationError('revision_conflict', 'The approved file no longer names the same page revision.');
      }
      const project = prepareCanonicalProjections(ready.parsedPage, ready.slug, sourceId);
      await withCompanyBrainSource(engine, sourceId, async tx => { await ready.apply(tx); await project(tx); });
      return ready.result;
    } }).catch(error => {
      if (error instanceof OperationError) context.failureCode = error.code;
      throw error;
    });
}
