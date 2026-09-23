import type { SearchOpts } from '../types.ts';
import { MAX_CUE_GROUNDING_CHUNKS, MAX_CUE_GROUNDING_SPANS } from './types.ts';

export function cueGroundingReadSql(opts: SearchOpts, params: unknown[]): { valid: string; evidence: string } {
  const raw = `COALESCE(c.grounding,jsonb_build_array(jsonb_build_object('chunk_id',c.chunk_id,
    'start',position(c.quote in cc.chunk_text)-1,'end',position(c.quote in cc.chunk_text)-1+length(c.quote),'separator','')))`;
  const bounded = `CASE WHEN jsonb_typeof(${raw})='array' THEN
    CASE WHEN jsonb_array_length(${raw}) BETWEEN 1 AND ${MAX_CUE_GROUNDING_SPANS} THEN ${raw} ELSE '[]'::jsonb END ELSE '[]'::jsonb END`;
  const integer = (field: string) => `CASE WHEN g.span->>'${field}' ~ '^[0-9]{1,10}$' THEN (g.span->>'${field}')::bigint END`;
  const start = integer('start');
  const end = integer('end');
  const filters = [`gc.page_id=p.id`, `gc.modality='text'`, `gc.chunk_source IN ('compiled_truth','timeline')`,
    `${start}>=0`, `${end}>${start}`, `${end}<=length(gc.chunk_text)`,
    `jsonb_typeof(g.span->'separator')='string'`, `g.span->>'separator' IN ('',E'\n')`,
    `(g.ordinality<>1 OR g.span->>'separator'='')`];
  const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
  if (opts.language) filters.push(`gc.language=${bind(opts.language)}`);
  if (opts.symbolKind) filters.push(`gc.symbol_type=${bind(opts.symbolKind)}`);
  if (opts.detail === 'low') filters.push("gc.chunk_source='compiled_truth'");
  const rows = `SELECT gc.id,gc.chunk_index,gc.chunk_text,gc.chunk_source,g.ordinality,g.span->>'separator' AS separator,
      CASE WHEN ${start}>=0 AND ${end}>${start} AND ${end}<=length(gc.chunk_text)
        THEN substring(gc.chunk_text FROM (${start}+1)::int FOR (${end}-${start})::int) END AS piece
    FROM jsonb_array_elements(${bounded}) WITH ORDINALITY g(span,ordinality)
    JOIN content_chunks gc ON gc.id=${integer('chunk_id')} WHERE ${filters.join(' AND ')}`;
  return {
    valid: `length(c.quote) BETWEEN 3 AND 640 AND (SELECT count(*) BETWEEN 1 AND ${MAX_CUE_GROUNDING_SPANS}
      AND count(*)=jsonb_array_length(${bounded}) AND count(DISTINCT spans.id)<=${MAX_CUE_GROUNDING_CHUNKS}
      AND (array_agg(spans.id ORDER BY spans.ordinality))[1]=c.chunk_id
      AND array_agg(spans.chunk_index ORDER BY spans.ordinality)=array_agg(spans.chunk_index ORDER BY spans.chunk_index,spans.ordinality)
      AND string_agg(spans.separator||spans.piece,'' ORDER BY spans.ordinality)=c.quote FROM (${rows}) spans) IS TRUE`,
    evidence: `(SELECT jsonb_agg(jsonb_build_object('page_id',p.id,'source_id',p.source_id,'slug',p.slug,'title',p.title,'type',p.type,
      'chunk_id',e.id,'chunk_index',e.chunk_index,'chunk_text',e.chunk_text,'chunk_source',e.chunk_source,
      'effective_date',p.effective_date,'effective_date_source',p.effective_date_source,'score',0,'stale',false) ORDER BY e.chunk_index,e.id)
      FROM (SELECT DISTINCT id,chunk_index,chunk_text,chunk_source FROM (${rows}) spans) e)`,
  };
}
