/**
 * oauth_client_scope_health (cathedral-6) — scoped-client grant hygiene.
 *
 * - (a) a federated read grant naming a nonexistent source (federated_read
 *   is a TEXT[] with no FK) → warn naming the client + the missing id.
 * - (b) an empty auto-created '<name>-workspace' source with no live client
 *   referencing it (the post-failure / post-revoke residue from
 *   `gbrain agent register`) → warn naming the source.
 * - A pages-bearing non-default source is NEVER flagged (that shape is
 *   every ordinary local brain, not residue).
 * - An empty workspace still referenced by a live client is NOT residue.
 * - Deleted clients (deleted_at set) don't produce dangling-grant warns.
 *
 * Hermetic via PGLite. Imports from doctor.ts (the façade re-export), same
 * as the sibling routing-federation check tests.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkOauthClientScopeHealth } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function truncate(): Promise<void> {
  for (const t of ['pages', 'facts', 'oauth_tokens', 'oauth_codes', 'oauth_clients']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
  await (engine as any).db.exec(`DELETE FROM sources WHERE id <> 'default'`);
}

describe('checkOauthClientScopeHealth', () => {
  beforeEach(truncate);

  test('clean brain → ok', async () => {
    const r = await checkOauthClientScopeHealth(engine);
    expect(r.status).toBe('ok');
    expect(r.message).toMatch(/consistent/i);
  });

  test('dangling federated grant + orphaned empty workspace → both warn', async () => {
    // (a) live client granted a read on a source that no longer exists.
    await engine.executeRaw(
      `INSERT INTO oauth_clients (client_id, client_name, scope, federated_read)
       VALUES ('c-dangler', 'nova-daily', 'read write', $1)`,
      [['default', 'ghost-source']],
    );
    // (b) empty derived workspace, DB-only, referenced by no live client.
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('aurora-coder-workspace', 'aurora-coder-workspace')`,
    );
    const r = await checkOauthClientScopeHealth(engine);
    expect(r.status).toBe('warn');
    // Arm (a): names the client and the missing grant id, with the rescope hint.
    expect(r.message).toMatch(/nova-daily/);
    expect(r.message).toMatch(/ghost-source/);
    expect(r.message).toMatch(/rescope-client/);
    // Arm (b): names the orphaned workspace, with the removal hint.
    expect(r.message).toMatch(/aurora-coder-workspace/);
    expect(r.message).toMatch(/gbrain sources remove/);
  });

  test('zero-page workspace WITH facts → NOT flagged (revoked agent memory, not residue)', async () => {
    // A revoked agent's workspace: the client row is gone, no pages were ever
    // written, but FACTS exist (the primary agent write lane). Recommending
    // `gbrain sources remove` here would cascade the facts away.
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('revoked-agent-workspace', 'revoked-agent-workspace')`,
    );
    await engine.executeRaw(
      `INSERT INTO facts (source_id, fact, source)
       VALUES ('revoked-agent-workspace', 'agent memory row', 'test')`,
    );
    const r = await checkOauthClientScopeHealth(engine);
    expect(r.status).toBe('ok');
    expect(r.message).not.toMatch(/revoked-agent-workspace/);
  });

  test('pages-bearing non-default source → NOT flagged', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('proj-widget-workspace', 'proj-widget-workspace')`,
    );
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES ('p1', 'proj-widget-workspace', 'note', 'p1', '', '')`,
    );
    const r = await checkOauthClientScopeHealth(engine);
    expect(r.status).toBe('ok');
  });

  test('empty workspace referenced by a live client → NOT flagged', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('aurora-coder-workspace', 'aurora-coder-workspace')`,
    );
    await engine.executeRaw(
      `INSERT INTO oauth_clients (client_id, client_name, scope, source_id, federated_read)
       VALUES ('c-live', 'aurora-coder', 'read write', 'aurora-coder-workspace', $1)`,
      [['aurora-coder-workspace', 'default']],
    );
    const r = await checkOauthClientScopeHealth(engine);
    expect(r.status).toBe('ok');
  });

  test('deleted client with a dangling grant → NOT flagged', async () => {
    await engine.executeRaw(
      `INSERT INTO oauth_clients (client_id, client_name, scope, federated_read, deleted_at)
       VALUES ('c-deleted', 'retired-agent', 'read', $1, now())`,
      [['ghost-source']],
    );
    const r = await checkOauthClientScopeHealth(engine);
    expect(r.status).toBe('ok');
  });

  // (c) Privileged self-registered clients. A row created through the
  // anonymous DCR path carries grant_revision = 0 and no oauth_grant_audit
  // 'register' row (operator paths write one). Rows that hold a scope beyond
  // the DCR ceiling with that signature predate the ceiling (or predate the
  // grant audit log) and deserve an operator look — advisory WARN with the
  // rescope / revoke remedy.
  describe('privileged self-registered (DCR-signature) clients', () => {
    async function seedClient(id: string, scope: string, opts: { audited?: boolean; revision?: number; deleted?: boolean } = {}): Promise<void> {
      await engine.executeRaw(
        `INSERT INTO oauth_clients (client_id, client_name, scope, source_id, federated_read, grant_revision, deleted_at)
         VALUES ($1, $2, $3, 'default', $4, $5, ${opts.deleted ? 'now()' : 'NULL'})`,
        [id, `${id}-name`, scope, ['default'], opts.revision ?? 0],
      );
      if (opts.audited) {
        await engine.executeRaw(
          `INSERT INTO oauth_grant_audit (client_id, actor, action, revision, before_grant, after_grant)
           VALUES ($1, 'operator', 'register', 0, NULL, '{}'::jsonb)`,
          [id],
        );
      }
    }

    beforeEach(async () => {
      await (engine as any).db.exec('DELETE FROM oauth_grant_audit');
    });

    test('admin-scoped DCR-signature row → warn naming the client + rescope/revoke remedy', async () => {
      await seedClient('c-dcr-admin', 'read admin');
      const r = await checkOauthClientScopeHealth(engine);
      expect(r.status).toBe('warn');
      expect(r.message).toMatch(/c-dcr-admin/);
      expect(r.message).toMatch(/admin/);
      expect(r.message).toMatch(/rescope-client <client_id> --scopes read,write|rescope-client .*--scopes/);
      expect(r.message).toMatch(/revoke-client/);
    });

    test('sources_admin and users_admin also trip the arm; the client name is shown', async () => {
      await seedClient('c-dcr-sources', 'sources_admin');
      await seedClient('c-dcr-users', 'read users_admin');
      const r = await checkOauthClientScopeHealth(engine);
      expect(r.status).toBe('warn');
      expect(r.message).toMatch(/c-dcr-sources-name/);
      expect(r.message).toMatch(/c-dcr-users-name/);
    });

    test('read/write DCR-signature rows are within the ceiling → NOT flagged', async () => {
      await seedClient('c-dcr-rw', 'read write');
      await seedClient('c-dcr-empty', '');
      const r = await checkOauthClientScopeHealth(engine);
      expect(r.status).toBe('ok');
    });

    test('operator-registered admin client (audit register row) → NOT flagged', async () => {
      await seedClient('c-op-admin', 'admin', { audited: true });
      const r = await checkOauthClientScopeHealth(engine);
      expect(r.status).toBe('ok');
    });

    test('rescoped admin client (grant_revision > 0) → NOT flagged', async () => {
      await seedClient('c-rescoped-admin', 'admin', { revision: 2 });
      const r = await checkOauthClientScopeHealth(engine);
      expect(r.status).toBe('ok');
    });

    test('revoked (deleted_at) DCR-signature admin row → NOT flagged', async () => {
      await seedClient('c-dcr-revoked', 'admin', { deleted: true });
      const r = await checkOauthClientScopeHealth(engine);
      expect(r.status).toBe('ok');
    });

    test('grant audit table missing → arm skipped with an explicit note, other arms intact', async () => {
      await seedClient('c-dcr-admin-noaudit', 'admin');
      await (engine as any).db.exec('DROP TABLE oauth_grant_audit');
      try {
        const r = await checkOauthClientScopeHealth(engine);
        // Fail-open: cannot tell operator rows from self-registered ones
        // without the audit log, so the arm reports unknown instead of
        // guessing — and says so.
        expect(r.status).toBe('ok');
        expect(r.message).toMatch(/self-registered.*(skipped|unknown)|(skipped|unknown).*self-registered/i);
      } finally {
        const { GRANT_AUDIT_SCHEMA_SQL } = await import('../src/core/grants/schema.ts');
        await (engine as any).db.exec(GRANT_AUDIT_SCHEMA_SQL);
      }
    });
  });
});
