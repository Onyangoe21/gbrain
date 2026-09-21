import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasDatabase } from './helpers.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { withEnv } from '../helpers/with-env.ts';
import { phaseCGrandfather } from '../../src/commands/migrations/v0_13_1.ts';

describe.skipIf(!hasDatabase())('Postgres grandfather migration projection publication', () => {
  test('preserves sealed duplicate slugs across sources without certifying incomplete text', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-grandfather-pg-'));
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    const engine = pg.engine;
    try {
      await engine.executeRaw("INSERT INTO sources(id,name) VALUES ('secondary','Secondary')");
      const slug = 'concepts/search-example';
      const before = new Map<string, string | undefined>();
      for (const sourceId of ['default', 'secondary']) {
        await engine.putPage(slug, {
          type: 'concept', title: 'Search Example', compiled_truth: 'amberbadger migration fixture', timeline: '', frontmatter: {},
        }, { sourceId });
        await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: 'amberbadger migration fixture', chunk_source: 'compiled_truth' }], { sourceId });
        before.set(sourceId, (await engine.getPage(slug, { sourceId }))?.knowledge_revision);
        expect(await engine.searchKeyword('amberbadger', { sourceId })).toHaveLength(1);
      }
      await engine.putPage('concepts/unsealed-example', {
        type: 'concept', title: 'Unsealed Example', compiled_truth: 'Incomplete projection.', timeline: '', frontmatter: {},
      }, { sourceId: 'default' });
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const result = await phaseCGrandfather(engine, { yes: true, dryRun: false, noAutopilotInstall: true });
        expect(result.result.status).toBe('complete');
        expect(result.detail.touched).toBe(3);
        for (const sourceId of ['default', 'secondary']) {
          const page = await engine.getPage(slug, { sourceId });
          expect(page?.knowledge_revision).not.toBe(before.get(sourceId));
          expect(page?.text_projection_revision).toBe(page?.knowledge_revision);
          expect(page?.frontmatter.validate).toBe(false);
          expect(await engine.searchKeyword('amberbadger', { sourceId })).toHaveLength(1);
        }
        expect((await engine.getPage('concepts/unsealed-example', { sourceId: 'default' }))?.text_projection_revision).toBeNull();
        expect(await engine.executeRaw('SELECT slug FROM page_projection_jobs')).toEqual([{ slug: 'concepts/unsealed-example' }]);
        expect((await phaseCGrandfather(engine, { yes: true, dryRun: false, noAutopilotInstall: true })).detail.touched).toBe(0);
      });
    } finally {
      await pg.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
