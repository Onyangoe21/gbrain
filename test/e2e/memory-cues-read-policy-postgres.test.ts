import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { BrainEngine } from '../../src/core/engine.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { cueEvidence, cueProviders, cueVector, enrollCues } from '../helpers/memory-cues.ts';
import { memoryCueColumn, recallMemoryCues, revalidateMemoryCueCandidates, runMemoryCueBuild, submitMemoryCueBuild } from '../../src/core/memory-cues/index.ts';
import type { MemoryCueCandidate } from '../../src/core/memory-cues/types.ts';

const suite = process.env.DATABASE_URL ? describe : describe.skip;

suite('memory cue reads under real PostgreSQL roles and forced row security', () => {
  const suffix = randomUUID().replaceAll('-', '');
  const reader = `cue_reader_${suffix}`;
  const owner = `cue_owner_${suffix}`;
  const anonymous = `cue_anon_${suffix}`;
  let engine: BrainEngine;
  let close: (() => Promise<void>) | undefined;
  let admin: ReturnType<typeof postgres>;

  beforeAll(async () => {
    ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    admin = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
    await engine.executeRaw(`CREATE ROLE ${reader} NOLOGIN NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE ${anonymous} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await engine.setConfig('chat_model', 'openai:gpt-4o-mini');
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('visible-example','Visible fixture'),('foreign-example','Foreign fixture')");
    for (const [sourceId, slug, marker, hidden] of [
      ['visible-example', 'notes/constraint-example', 'VISIBLE_EVIDENCE', false],
      ['foreign-example', 'notes/constraint-example', 'FOREIGN_EVIDENCE_SENTINEL', false],
      ['visible-example', 'notes/private-example', 'PRIVATE_EVIDENCE_SENTINEL', true],
    ] as const) {
      const text = `${cueEvidence} ${marker}`;
      await engine.putPage(slug, { type: 'note', title: marker, compiled_truth: text, timeline: '',
        frontmatter: { visibility: hidden ? 'private' : 'world' } }, { sourceId });
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth' }], { sourceId });
    }
    await enrollCues(engine, ['visible-example', 'foreign-example']);
    const build = await submitMemoryCueBuild(engine, { sourceIds: ['visible-example', 'foreign-example'], trustedLocal: true, maxUsd: 2 });
    expect(await runMemoryCueBuild(engine, { buildId: build.buildId, providers: cueProviders })).toMatchObject({ status: 'complete' });
    await engine.executeRaw(`GRANT USAGE ON SCHEMA public TO ${reader},${owner},${anonymous};
      GRANT SELECT ON config,sources,pages,content_chunks,memory_cues,memory_cue_windows,memory_cue_indexes TO ${reader},${owner};
      GRANT SELECT ON memory_cues,memory_cue_windows,memory_cue_indexes,memory_cue_builds,memory_cue_pages,memory_cue_attempts TO ${anonymous};
      CREATE POLICY cue_runtime_config ON config FOR SELECT TO ${reader},${owner}
        USING (key LIKE 'memory.cues.%' OR key IN ('embedding_model','embedding_dimensions','embedding_columns','search_embedding_column','chat_model'));
      CREATE POLICY cue_runtime_sources ON sources FOR SELECT TO ${reader},${owner} USING (id='visible-example');
      CREATE POLICY cue_runtime_chunks ON content_chunks FOR SELECT TO ${reader},${owner}
        USING (EXISTS (SELECT 1 FROM pages p WHERE p.id=content_chunks.page_id));
      CREATE POLICY cue_runtime_cues ON memory_cues FOR SELECT TO ${reader},${owner}
        USING (EXISTS (SELECT 1 FROM pages p WHERE p.id=memory_cues.page_id));
      CREATE POLICY cue_runtime_windows ON memory_cue_windows FOR SELECT TO ${reader},${owner}
        USING (EXISTS (SELECT 1 FROM pages p WHERE p.id=memory_cue_windows.page_id));
      CREATE POLICY cue_runtime_indexes ON memory_cue_indexes FOR SELECT TO ${reader},${owner} USING (true);
      ALTER TABLE pages OWNER TO ${owner};
      ALTER TABLE pages ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pages FORCE ROW LEVEL SECURITY;
      CREATE POLICY cue_visible_source ON pages FOR SELECT TO ${reader},${owner} USING (source_id='visible-example')`);
  }, 120_000);

  afterAll(async () => {
    try { await close?.(); }
    finally {
      if (admin) {
        try { await admin.unsafe(`DROP ROLE IF EXISTS ${reader}; DROP ROLE IF EXISTS ${owner}; DROP ROLE IF EXISTS ${anonymous}`); }
        finally { await admin.end(); }
      }
    }
  }, 60_000);

  const asRole = <T>(role: string, run: (tx: BrainEngine) => Promise<T>) => engine.transaction(async tx => {
    await tx.executeRaw(`SET LOCAL ROLE ${role}`);
    return run(tx);
  });

  test('new derived tables retain default-deny RLS even when a role has SELECT grants', async () => {
    const tables = ['memory_cues', 'memory_cue_windows', 'memory_cue_indexes', 'memory_cue_builds', 'memory_cue_pages', 'memory_cue_attempts'];
    const flags = await engine.executeRaw<{ relname: string; relrowsecurity: boolean }>(
      'SELECT relname,relrowsecurity FROM pg_class WHERE oid=ANY($1::regclass[])', [tables]);
    expect(flags).toHaveLength(tables.length);
    expect(flags.every(row => row.relrowsecurity)).toBe(true);
    await asRole(anonymous, async tx => {
      for (const table of tables) expect(await tx.executeRaw(`SELECT * FROM ${table}`)).toEqual([]);
    });
  });

  test('the reader is not an owner/superuser shortcut and cannot mutate configuration', async () => {
    await asRole(reader, async tx => {
      const [role] = await tx.executeRaw<{ role: string; rolsuper: boolean; rolbypassrls: boolean }>(
        'SELECT current_user AS role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
      expect(role).toEqual({ role: reader, rolsuper: false, rolbypassrls: false });
      const rows = await tx.executeRaw<{ source_id: string }>('SELECT DISTINCT source_id FROM pages');
      expect(rows).toEqual([{ source_id: 'visible-example' }]);
    });
    await expect(asRole(reader, tx => tx.executeRaw('UPDATE config SET value=value WHERE false'))).rejects.toMatchObject({ code: '42501' });
  });

  test('reader and forced-RLS table owner return only scoped, public source evidence', async () => {
    for (const role of [reader, owner]) {
      await asRole(role, async tx => {
        const column = await memoryCueColumn(tx);
        const result = await recallMemoryCues(tx, cueVector(column.dimensions), {
          embeddingColumn: column, sourceIds: ['visible-example', 'foreign-example'], excludePrivate: true, requireSafeChunks: true,
        });
        expect(result.status, result.reason).toBe('ready');
        expect(result.candidates).toHaveLength(1);
        expect(result.candidates[0].result).toMatchObject({ source_id: 'visible-example', slug: 'notes/constraint-example' });
        expect(JSON.stringify(result)).not.toContain('FOREIGN_EVIDENCE_SENTINEL');
        expect(JSON.stringify(result)).not.toContain('PRIVATE_EVIDENCE_SENTINEL');
        expect(await revalidateMemoryCueCandidates(tx, result.candidates, {
          sourceIds: ['visible-example', 'foreign-example'], excludePrivate: true, requireSafeChunks: true,
        })).toHaveLength(1);
      });
    }
  });

  test('private filtering is independently effective inside an otherwise authorized source', async () => {
    await asRole(reader, async tx => {
      const column = await memoryCueColumn(tx);
      const local = await recallMemoryCues(tx, cueVector(column.dimensions), {
        embeddingColumn: column, sourceIds: ['visible-example'], excludePrivate: false,
      });
      expect(local.candidates).toHaveLength(2);
      expect(JSON.stringify(local)).toContain('PRIVATE_EVIDENCE_SENTINEL');
      const remote = await recallMemoryCues(tx, cueVector(column.dimensions), {
        embeddingColumn: column, sourceIds: ['visible-example'], excludePrivate: true,
      });
      expect(remote.candidates).toHaveLength(1);
      expect(JSON.stringify(remote)).not.toContain('PRIVATE_EVIDENCE_SENTINEL');
      expect((await recallMemoryCues(tx, cueVector(column.dimensions), {
        embeddingColumn: column, sourceIds: ['foreign-example'], excludePrivate: true,
      })).candidates).toEqual([]);
    });
  });

  test('a stricter row policy revokes previously read candidates at final hydration', async () => {
    const candidates = await asRole(reader, async tx => {
      const column = await memoryCueColumn(tx);
      return (await recallMemoryCues(tx, cueVector(column.dimensions), {
        embeddingColumn: column, sourceIds: ['visible-example'], excludePrivate: true,
      })).candidates;
    });
    expect(candidates).toHaveLength(1);
    await engine.executeRaw('ALTER POLICY cue_visible_source ON pages USING (false)');
    try {
      const hydrated: MemoryCueCandidate[] = await asRole(reader, tx => revalidateMemoryCueCandidates(tx, candidates, {
        sourceIds: ['visible-example'], excludePrivate: true, requireSafeChunks: true,
      }));
      expect(hydrated).toEqual([]);
    } finally {
      await engine.executeRaw("ALTER POLICY cue_visible_source ON pages USING (source_id='visible-example')");
    }
  });
});
