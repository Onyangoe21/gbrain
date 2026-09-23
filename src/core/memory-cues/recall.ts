import type { BrainEngine } from '../engine.ts';
import type { ResolvedColumn, SearchOpts, SearchResult } from '../types.ts';
import { loadMemoryCueSettings, memoryCueColumn, cueSignature, unsupportedCueColumn, missingCueSchema } from './settings.ts';
import { cueIndexExists, cueReadPredicate, cueVectorExpression, cueReadConfigurationStamp } from './storage.ts';
import type { MemoryCueCandidate, MemoryCueRecall } from './types.ts';
import { cueGenerationModel } from './providers.ts';
import { supportsHnswIterativeScan } from '../vector-index.ts';
import { withVectorSettings } from '../search/vector-settings.ts';
import { cueGroundingReadSql } from './grounding-sql.ts';

interface CueRow extends SearchResult {
  source_id: string;
  cue_id: string;
  family: MemoryCueCandidate['family'];
  cue_text: string;
  generation: string;
  similarity: number;
  supporting_chunks: SearchResult[];
}
const projection = `c.id AS cue_id,c.family,c.cue_text,w.id AS generation,p.id AS page_id,p.source_id,p.slug,p.title,p.type,
  cc.id AS chunk_id,cc.chunk_index,cc.chunk_text,cc.chunk_source,p.effective_date,p.effective_date_source`;
const joins = `JOIN memory_cue_windows w ON w.id=c.window_id JOIN pages p ON p.id=c.page_id
  JOIN sources s ON s.id=p.source_id JOIN content_chunks cc ON cc.id=c.chunk_id`;

function candidate(row: CueRow): MemoryCueCandidate {
  return { cueId: row.cue_id, family: row.family, cueText: row.cue_text, generation: row.generation, similarity: Number(row.similarity),
    ...(row.supporting_chunks?.length > 1 ? { evidence: row.supporting_chunks } : {}),
    result: row.supporting_chunks?.[0] ?? { page_id: row.page_id, source_id: row.source_id, slug: row.slug, title: row.title, type: row.type,
      chunk_id: row.chunk_id, chunk_index: row.chunk_index, chunk_text: row.chunk_text, chunk_source: row.chunk_source,
      effective_date: row.effective_date, effective_date_source: row.effective_date_source, score: 0, stale: false } };
}

export async function recallMemoryCues(engine: BrainEngine, queryEmbedding: Float32Array,
  opts: SearchOpts & { embeddingColumn: ResolvedColumn; minSimilarity?: number; purpose?: 'search' | 'push' }): Promise<MemoryCueRecall> {
  if (opts.sourceIds?.length === 0) return { candidates: [], status: 'skipped', reason: 'empty_source_scope' };
  const stamp = await cueReadConfigurationStamp(engine);
  const settings = await loadMemoryCueSettings(engine);
  if (!settings.sourceIds.length) return { candidates: [], status: 'skipped', reason: 'not_enrolled' };
  if (!settings.families.length) return { candidates: [], status: 'skipped', reason: 'no_families' };
  if (opts.purpose === 'push' ? !settings.pushEnabled : settings.readMode === 'off') return { candidates: [], status: 'skipped', reason: 'disabled' };
  const calibrated = opts.purpose === 'push' ? settings.pushMinSimilarity : settings.minSimilarity;
  const threshold = calibrated === null ? null : opts.minSimilarity ?? calibrated;
  if (threshold === null || !Number.isFinite(threshold) || threshold < -1 || threshold > 1) return { candidates: [], status: 'skipped', reason: 'uncalibrated' };
  const column = await memoryCueColumn(engine);
  const unsupported = unsupportedCueColumn(column);
  if (unsupported || cueSignature(column) !== cueSignature(opts.embeddingColumn)) return { candidates: [], status: 'skipped', reason: unsupported ?? 'embedding_signature_changed' };
  if (queryEmbedding.length !== column.dimensions || !queryEmbedding.every(Number.isFinite) || !queryEmbedding.some(v => v !== 0)) return { candidates: [], status: 'skipped', reason: 'invalid_query_embedding' };
  const signature = cueSignature(column);
  try {
    if (!(await cueIndexExists(engine, signature))) {
      const [schema] = await engine.executeRaw<{ missing: boolean }>("SELECT to_regclass('memory_cues') IS NULL AS missing");
      return { candidates: [], status: schema?.missing ? 'degraded' : 'skipped', reason: schema?.missing ? 'schema_missing' : 'index_not_provisioned' };
    }
    const params: unknown[] = [`[${Array.from(queryEmbedding).join(',')}]`];
    const filter = cueReadPredicate(opts, settings.sourceIds, signature, await cueGenerationModel(engine), stamp, params, settings.families);
    const evidence = cueGroundingReadSql(opts, params).evidence;
    params.push(threshold);
    const thresholdParam = `$${params.length}`;
    const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
    const vector = cueVectorExpression(column);
    const [extension] = await engine.executeRaw<{ extversion: string }>("SELECT extversion FROM pg_extension WHERE extname='vector'");
    const iterative = supportsHnswIterativeScan(extension?.extversion);
    const rows = await engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('enable_seqscan','off',true),set_config('jit','off',true),set_config('statement_timeout','250ms',true)");
      return withVectorSettings((sql, values) => tx.executeRaw(sql, values), iterative, 200, 2000, () =>
        tx.executeRaw<CueRow>(`WITH nearest AS MATERIALIZED (
          SELECT c.*,1-((${vector}) <=> $1::${column.type}(${column.dimensions})) AS similarity
          FROM memory_cues c WHERE signature='${signature}' AND EXISTS (
            SELECT 1 FROM memory_cue_windows w JOIN pages p ON p.id=c.page_id JOIN sources s ON s.id=p.source_id
            JOIN content_chunks cc ON cc.id=c.chunk_id WHERE w.id=c.window_id AND ${filter})
          ORDER BY (${vector}) <=> $1::${column.type}(${column.dimensions}) LIMIT 200),
        hosts AS (SELECT DISTINCT ON (p.source_id,p.id) ${projection},${evidence} AS supporting_chunks,c.similarity FROM nearest c ${joins} WHERE c.similarity>=${thresholdParam}
          ORDER BY p.source_id,p.id,c.similarity DESC,c.id),
        results AS (SELECT * FROM hosts ORDER BY similarity DESC,cue_id LIMIT ${limit})
        SELECT * FROM results`, params));
    });
    const candidates = rows.filter(row => row.cue_id != null).map(candidate);
    const incomplete = candidates.length < limit;
    return { candidates, status: candidates.length ? 'ready' : incomplete ? 'degraded' : 'empty',
      ...(incomplete ? { reason: iterative ? 'candidate_budget' : 'iterative_scan_unavailable' } : {}) };
  } catch (error) {
    if (missingCueSchema(error)) return { candidates: [], status: 'degraded', reason: 'schema_missing' };
    if ((error as { code?: string }).code === '57014') return { candidates: [], status: 'degraded', reason: 'deadline' };
    throw error;
  }
}

export async function revalidateMemoryCueCandidates(engine: BrainEngine, candidates: MemoryCueCandidate[], opts: SearchOpts & { purpose?: 'search' | 'push' }): Promise<MemoryCueCandidate[]> {
  if (!candidates.length || opts.sourceIds?.length === 0) return [];
  const stamp = await cueReadConfigurationStamp(engine);
  const settings = await loadMemoryCueSettings(engine);
  const threshold = opts.purpose === 'push' ? settings.pushMinSimilarity : settings.minSimilarity;
  if (!settings.sourceIds.length || !settings.families.length || threshold === null || (opts.purpose === 'push' ? !settings.pushEnabled : settings.readMode === 'off')) return [];
  const column = await memoryCueColumn(engine);
  if (unsupportedCueColumn(column)) return [];
  const params: unknown[] = [candidates.slice(0, 200).map(c => c.cueId)];
  const filter = cueReadPredicate(opts, settings.sourceIds, cueSignature(column), await cueGenerationModel(engine), stamp, params, settings.families);
  const evidence = cueGroundingReadSql(opts, params).evidence;
  try {
    const rows = await engine.executeRaw<CueRow>(`SELECT ${projection},${evidence} AS supporting_chunks,0 AS similarity FROM memory_cues c ${joins}
      WHERE c.id=ANY($1::uuid[]) AND ${filter}`, params);
    const valid = new Map(rows.map(r => [r.cue_id, r]));
    return candidates.filter(c => c.similarity >= threshold && valid.get(c.cueId)?.generation === c.generation).map(c => ({ ...candidate(valid.get(c.cueId)!), similarity: c.similarity }));
  } catch (error) { if (missingCueSchema(error)) return []; throw error; }
}
