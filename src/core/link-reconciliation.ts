import type { BrainEngine, LinkBatchInput } from './engine.ts';
import { extractPageLinks, buildBasenameIndex, queryBasenameIndex, normalizeBasename, unwrapWikilink,
  type LinkExtractionPack, type SlugResolver } from './link-extraction.ts';
import { slugifySegment } from './sync.ts';
import { isValidSourceId } from './source-id.ts';

export interface LinkPageMetadata {
  slug: string;
  source_id: string;
  type: string;
  title: string;
  knowledge_revision: string;
}

export async function loadLinkPageMetadata(engine: Pick<BrainEngine, 'executeRaw'>, sourceId?: string): Promise<LinkPageMetadata[]> {
  return engine.executeRaw<LinkPageMetadata>(`SELECT slug, source_id, type, title, knowledge_revision FROM pages
    WHERE deleted_at IS NULL${sourceId ? ' AND source_id=$1' : ''} ORDER BY source_id, slug`, sourceId ? [sourceId] : []);
}

function makeIndexedLinkResolver(pages: readonly LinkPageMetadata[], sourceId: string): SlugResolver {
  const slugs = new Set(pages.map(page => page.slug));
  const basenames = buildBasenameIndex(slugs);
  const titles = new Map<string, string[]>();
  for (const page of pages) {
    const key = normalizeBasename(page.title);
    const matches = titles.get(key) ?? [];
    matches.push(page.slug);
    titles.set(key, matches);
  }
  return {
    async resolve(name, dirHint) {
      if (!name) return null;
      let value = name.trim();
      const colon = value.indexOf(':');
      if (colon !== -1 && isValidSourceId(value.slice(0, colon))) {
        if (value.slice(0, colon) !== sourceId) return null;
        value = value.slice(colon + 1);
      }
      if (slugs.has(value)) return value;
      const hints = Array.isArray(dirHint) ? dirHint : dirHint ? [dirHint] : [];
      for (const hint of hints) {
        for (const form of new Set([normalizeBasename(value), slugifySegment(value)])) {
          if (slugs.has(`${hint}/${form}`)) return `${hint}/${form}`;
        }
      }
      const matches = (titles.get(normalizeBasename(value)) ?? [])
        .filter(slug => !hints.length || hints.some(hint => slug.startsWith(`${hint}/`)));
      return matches.length === 1 ? matches[0] : null;
    },
    async resolveBasenameMatches(name) { return name.includes(':') ? [] : queryBasenameIndex(basenames, name); },
  };
}

export interface SourceLinkReconciliationResult {
  ok: boolean;
  complete: boolean;
  pagesProcessed: number;
  linksCreated: number;
  linksRemoved: number;
  nextAfterSlug?: string;
  unresolved: Array<{ originSlug: string; field?: string; target: string; reason: 'missing_target' | 'cross_source' | 'target_type_mismatch' }>;
  failures: Array<{ originSlug?: string; code: string }>;
}

export async function reconcileSourceLinks(
  engine: BrainEngine,
  sourceId: string,
  opts: { pack: LinkExtractionPack; afterSlug?: string; limit?: number; globalBasename?: boolean;
    expectedSourceIncarnation?: string },
): Promise<SourceLinkReconciliationResult> {
  if (!isValidSourceId(sourceId)) throw new TypeError('An exact valid source ID is required for reconciliation');
  const limit = opts.limit ?? Infinity;
  if (opts.limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) throw new TypeError('Reconciliation limit must be between 1 and 1000');
  const result: SourceLinkReconciliationResult = { ok: false, complete: false, pagesProcessed: 0,
    linksCreated: 0, linksRemoved: 0, nextAfterSlug: opts.afterSlug, unresolved: [], failures: [] };
  let originSlug: string | undefined;
  try {
    const sources = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
    if (!sources.length || (opts.expectedSourceIncarnation && sources[0].incarnation !== opts.expectedSourceIncarnation)) {
      result.failures.push({ code: 'source_identity_changed' });
      return result;
    }
    const sourceIncarnation = sources[0].incarnation;
    const pages = await loadLinkPageMetadata(engine, sourceId);
    const index = new Map(pages.map(page => [page.slug, page]));
    const resolver = makeIndexedLinkResolver(pages, sourceId);
    const remaining = pages.filter(page => !opts.afterSlug || page.slug > opts.afterSlug)
      .sort((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
    for (const metadata of remaining.slice(0, limit)) {
      originSlug = metadata.slug;
      const snapshot = await engine.readPageSnapshot(originSlug, { sourceId });
      if (!snapshot || snapshot.revision !== metadata.knowledge_revision || snapshot.sourceIncarnation !== sourceIncarnation) {
        result.failures.push({ originSlug, code: 'revision_conflict' });
        return result;
      }
      const page = snapshot.page;
      const extracted = await extractPageLinks(page.slug, `${page.compiled_truth}\n${page.timeline}`, page.frontmatter,
        page.type, resolver, { pack: opts.pack, globalBasename: opts.globalBasename,
          targetType: (slug, source) => !source || source === sourceId ? index.get(slug)?.type : undefined });
      for (const ref of extracted.unresolved) {
        const target = unwrapWikilink(ref.name);
        const qualifier = target.split(':')[0];
        const foreign = target.includes(':') && isValidSourceId(qualifier) && qualifier !== sourceId;
        result.unresolved.push({ originSlug: page.slug, field: ref.field, target: ref.name,
          reason: ref.reason ?? (foreign ? 'cross_source' : 'missing_target') });
      }
      const rows: LinkBatchInput[] = [];
      for (const candidate of extracted.candidates) {
        const from = candidate.fromSlug ?? page.slug;
        if (candidate.targetSourceId && candidate.targetSourceId !== sourceId) {
          result.unresolved.push({ originSlug, target: `${candidate.targetSourceId}:${candidate.targetSlug}`, reason: 'cross_source' });
          continue;
        }
        if (!index.has(from) || !index.has(candidate.targetSlug)) {
          result.unresolved.push({ originSlug, target: candidate.targetSlug, reason: 'missing_target' });
          continue;
        }
        rows.push({ from_slug: from, to_slug: candidate.targetSlug, link_type: candidate.linkType,
          context: candidate.context, link_source: candidate.linkSource, origin_slug: page.slug,
          origin_field: candidate.originField, from_source_id: sourceId, to_source_id: sourceId, origin_source_id: sourceId });
      }
      const written = await engine.replaceDerivedLinks({ slug: page.slug, sourceId,
        expectedRevision: snapshot.revision, sourceIncarnation }, rows, { expectedEndpoints:
          [...new Set(rows.flatMap(row => [row.from_slug, row.to_slug]))].map(slug => ({ slug, sourceId,
            revision: index.get(slug)!.knowledge_revision })) });
      result.pagesProcessed++;
      result.linksCreated += written.created;
      result.linksRemoved += written.removed;
      result.nextAfterSlug = page.slug;
    }
    result.ok = true;
    result.complete = remaining.length <= limit;
    return result;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code : 'graph_write_failed';
    result.failures.push({ originSlug, code });
    return result;
  }
}
