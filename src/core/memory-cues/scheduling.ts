import type { BrainEngine } from '../engine.ts';
import { enqueueCueBuild, assertCueBuildAuthority, type CueBuildRow } from './builds.ts';

export async function cueSchedulingEnabled(engine: BrainEngine, sourceId: string): Promise<boolean> {
  if (await engine.getConfig('memory.cues.generation_enabled') !== 'true') return false;
  let sourceIds: unknown;
  try { sourceIds = JSON.parse(await engine.getConfig('memory.cues.sources') ?? '[]'); } catch { return false; }
  if (!Array.isArray(sourceIds) || !sourceIds.includes(sourceId)) return false;
  const [schema] = await engine.executeRaw<{ present: boolean }>("SELECT to_regclass('memory_cue_builds') IS NOT NULL AS present");
  if (!schema?.present) return false;
  const rows = await engine.executeRaw(`SELECT 1 FROM memory_cue_builds b JOIN minion_jobs j ON j.id=b.owner_job_id
    JOIN sources s ON s.id=$1 WHERE $1=ANY(b.source_ids) AND b.source_incarnations->>$1=s.incarnation::text
    AND b.status<>'cancelled' AND j.budget_remaining_cents>0 LIMIT 1`, [sourceId]);
  return rows.length > 0;
}

export async function scheduleMemoryCuePage(engine: BrainEngine, sourceId: string, pageId: number): Promise<{ reason: string }> {
  return engine.transaction(async tx => {
    const [build] = await tx.executeRaw<CueBuildRow>(`SELECT b.* FROM memory_cue_builds b JOIN sources s ON s.id=$1
      WHERE $1=ANY(b.source_ids) AND b.source_incarnations->>$1=s.incarnation::text AND b.status<>'cancelled'
      ORDER BY b.created_at DESC LIMIT 1 FOR UPDATE OF b`, [sourceId]);
    if (!build) return { reason: 'no_approved_build' };
    try { await assertCueBuildAuthority(tx, build); }
    catch { return { reason: 'approval_inactive' }; }
    const [page] = await tx.executeRaw('SELECT id FROM pages WHERE id=$1 AND source_id=$2 AND deleted_at IS NULL', [pageId, sourceId]);
    if (!page) return { reason: 'page_ineligible' };
    const [count] = await tx.executeRaw<{ count: number }>('SELECT count(*)::int AS count FROM memory_cue_pages WHERE build_id=$1::uuid', [build.id]);
    const [existing] = await tx.executeRaw('SELECT page_id FROM memory_cue_pages WHERE build_id=$1::uuid AND page_id=$2', [build.id, pageId]);
    if (!existing && count!.count >= build.page_limit) return { reason: 'page_limit' };
    await tx.executeRaw(`INSERT INTO memory_cue_pages(build_id,page_id) VALUES($1::uuid,$2) ON CONFLICT(build_id,page_id)
      DO UPDATE SET status='pending',cursor=0,snapshot=NULL`, [build.id, pageId]);
    if (build.status !== 'running' && build.status !== 'queued') {
      await tx.executeRaw("UPDATE memory_cue_builds SET status='queued',reason=NULL WHERE id=$1::uuid", [build.id]);
      await enqueueCueBuild(tx, build);
    }
    return { reason: 'queued' };
  });
}
