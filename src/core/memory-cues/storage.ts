import type { BrainEngine } from '../engine.ts';
import type { ResolvedColumn, SearchOpts } from '../types.ts';
import { pageReadFilter } from '../search/read-policy-sql.ts';
import { safeChunksFilter, currentTextProjectionFilter } from '../search/safe-chunks.ts';
import { MEMORY_CUE_PROMPT_VERSION, type MemoryCueFamily } from './types.ts';
import { cueSignature, unsupportedCueColumn } from './settings.ts';
import { buildHardExcludeClause } from '../search/sql-ranking.ts';
import { resolveHardExcludes } from '../search/source-boost.ts';
import { resolveSearchDateBounds } from '../search/date-bounds.ts';
import { cueGroundingReadSql } from './grounding-sql.ts';

export const cueSnapshotSql = `md5(jsonb_build_array(p.id,p.knowledge_revision,p.text_projection_revision,p.chunker_version,p.title,
  (SELECT jsonb_agg(jsonb_build_array(sc.id,sc.chunk_index,sc.chunk_text,sc.chunk_source,sc.modality,sc.language,sc.symbol_name,sc.start_line,sc.end_line) ORDER BY sc.id) FROM content_chunks sc WHERE sc.page_id=p.id))::text)`;

export const cueReadConfigSql = `(SELECT md5(COALESCE(string_agg(key||'='||value,E'\\n' ORDER BY key),'')) FROM config
  WHERE key LIKE 'memory.cues.%' OR key IN ('embedding_model','embedding_dimensions','embedding_columns','search_embedding_column','chat_model'))`;

export async function cueReadConfigurationStamp(engine: BrainEngine): Promise<string> {
  const [row] = await engine.executeRaw<{ stamp: string }>(`SELECT ${cueReadConfigSql} AS stamp`);
  return row!.stamp;
}

export function cueReadPredicate(opts: SearchOpts, sourceIds: string[], signature: string, generationModel: string, stamp: string, params: unknown[], families: readonly MemoryCueFamily[] = ['scene', 'horizon']): string {
  const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
  const predicates = [pageReadFilter('p', opts, params, true), safeChunksFilter('p'), currentTextProjectionFilter('p'),
    `${cueReadConfigSql}=${bind(stamp)}`, `c.family=ANY(${bind(families)}::text[])`,
    `p.source_id=ANY(${bind(sourceIds)}::text[])`, `w.source_incarnation=s.incarnation`, `w.revision=p.knowledge_revision`,
    `w.snapshot=${cueSnapshotSql}`, `w.status='ready'`, `w.signature=${bind(signature)}`, `w.prompt_version=${bind(MEMORY_CUE_PROMPT_VERSION)}`, `w.generation_model=${bind(generationModel)}`,
    `COALESCE(p.frontmatter->>'status','') NOT IN ('superseded','withdrawn')`, `cc.page_id=p.id`,
    `cc.modality='text'`, `cc.chunk_source IN ('compiled_truth','timeline')`, cueGroundingReadSql(opts, params).valid];
  const excluded = buildHardExcludeClause('p.slug', resolveHardExcludes(opts.exclude_slug_prefixes, opts.include_slug_prefixes));
  if (excluded) predicates.push(`TRUE ${excluded}`);
  if (opts.type) predicates.push(`p.type=${bind(opts.type)}`);
  if (opts.types) predicates.push(`p.type=ANY(${bind(opts.types)}::text[])`);
  if (opts.exclude_slugs?.length) predicates.push(`NOT(p.slug=ANY(${bind(opts.exclude_slugs)}::text[]))`);
  if (opts.language) predicates.push(`cc.language=${bind(opts.language)}`);
  if (opts.symbolKind) predicates.push(`cc.symbol_type=${bind(opts.symbolKind)}`);
  if (opts.detail === 'low') predicates.push("cc.chunk_source='compiled_truth'");
  const dates = resolveSearchDateBounds(opts);
  if (dates.afterDate) predicates.push(`COALESCE(p.effective_date,p.updated_at,p.created_at) ${dates.afterDateInclusive ? '>=' : '>'} ${bind(dates.afterDate)}::text::timestamptz`);
  if (dates.beforeDate) predicates.push(`COALESCE(p.effective_date,p.updated_at,p.created_at) ${dates.beforeDateInclusive ? '<=' : '<'} ${bind(dates.beforeDate)}::text::timestamptz`);
  return predicates.join(' AND ');
}

export function cueVectorExpression(column: ResolvedColumn): string {
  if (unsupportedCueColumn(column)) throw new Error('unsupported_embedding_signature');
  return `${column.type === 'halfvec' ? 'embedding_half' : 'embedding'}::${column.type}(${column.dimensions})`;
}

export async function provisionCueIndex(engine: BrainEngine, column: ResolvedColumn): Promise<void> {
  const signature = cueSignature(column);
  const name = `memory_cues_ann_${signature.slice(0, 24)}`;
  await engine.executeRaw(`CREATE INDEX IF NOT EXISTS ${name} ON memory_cues USING hnsw ((${cueVectorExpression(column)}) ${column.type}_cosine_ops) WHERE signature='${signature}'`);
  await engine.executeRaw(`INSERT INTO memory_cue_indexes(signature,descriptor,index_name) VALUES($1,$2::text::jsonb,$3) ON CONFLICT(signature) DO NOTHING`,
    [signature, JSON.stringify(column), name]);
  if (!await cueIndexExists(engine, signature)) throw new Error('cue_index_invalid');
}

export async function cueIndexExists(engine: BrainEngine, signature: string): Promise<boolean> {
  const rows = await engine.executeRaw<{ descriptor: ResolvedColumn; expression: string; predicate: string; opclass: string }>(`SELECT ci.descriptor,
    pg_get_expr(i.indexprs,i.indrelid,true) AS expression,pg_get_expr(i.indpred,i.indrelid,true) AS predicate,oc.opcname AS opclass
    FROM memory_cue_indexes ci JOIN pg_class c ON c.relname=ci.index_name JOIN pg_index i ON i.indexrelid=c.oid
    JOIN pg_am am ON am.oid=c.relam JOIN pg_opclass oc ON oc.oid=i.indclass[0]
    JOIN pg_depend dependency ON dependency.classid='pg_opclass'::regclass AND dependency.objid=oc.oid
      AND dependency.refclassid='pg_extension'::regclass AND dependency.deptype='e'
    JOIN pg_extension extension ON extension.oid=dependency.refobjid AND extension.extname='vector'
    WHERE ci.signature=$1 AND i.indrelid=to_regclass('memory_cues') AND i.indisvalid AND i.indisready AND i.indislive
      AND am.amname='hnsw' AND i.indnatts=1 AND i.indnkeyatts=1 AND i.indkey[0]=0`, [signature]);
  const normalized = (value: string | null) => value?.replace(/\s|[()]/g, '');
  return rows.some(row => row.descriptor && !unsupportedCueColumn(row.descriptor) && cueSignature(row.descriptor) === signature
    && row.opclass === `${row.descriptor.type}_cosine_ops`
    && normalized(row.expression) === normalized(cueVectorExpression(row.descriptor))
    && normalized(row.predicate)?.replace(/::text/g, '') === `signature='${signature}'`);
}
