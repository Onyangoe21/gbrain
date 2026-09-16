/**
 * delete_page purge — the markdown artifact must be GONE before the row is.
 *
 * O4-2 (v0.50.2.0 security wave, review cycle 4): `purge: true` on a page
 * that was already soft-deleted used to skip file removal outright
 * (`{ removed: false, skipped: 'already_soft_deleted' }`) and hard-delete the
 * row. If the earlier soft-delete's unlink had FAILED (permissions, read-only
 * mount), the credential-bearing `.md` survived on disk and the next
 * `gbrain sync` re-imported it — a "purge" that resurrected the secret.
 *
 * Contract pinned here:
 *   - the tombstone path resolves the page's recorded file from the
 *     soft-deleted row itself and RETRIES the removal before dropping the row;
 *   - `write_through` reports the real outcome (`removed: true` / `removed:
 *     false, error` / `skipped: 'file_not_present'`), never a fabricated skip;
 *   - a removal ERROR fails closed: `OperationError('storage_error')` naming
 *     the path, the row stays (soft-deleted) so the operator can fix the
 *     cause and re-run — a purge that leaves the file is not a purge. This
 *     applies to the live-row purge too (the soft-delete lands, the
 *     hard-delete does not).
 *
 * Two ways to make the artifact undeletable:
 *   - `chmod 0555` on its directory (the realistic permissions case) — only
 *     bites for a caller without CAP_DAC_OVERRIDE, so those tests probe once
 *     at load and skip (with the reason in the name) for root / capability-
 *     bearing sandboxes / Windows;
 *   - a DIRECTORY sitting where the `.md` should be — `unlink(2)` on a
 *     directory fails for every uid (EISDIR/EPERM), so the fail-closed path
 *     is exercised unconditionally.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';

let engine: PGLiteEngine;
let tmpRoot: string;
let brainDir: string;
const delete_page = operations.find(o => o.name === 'delete_page')!;

/** Does `chmod 0555 <dir>` actually stop THIS process from unlinking inside it? */
function chmodBites(): boolean {
  if (process.platform === 'win32' || process.getuid?.() === 0) return false;
  const probe = mkdtempSync(join(tmpdir(), 'gbrain-chmod-probe-'));
  const dir = join(probe, 'd');
  const file = join(dir, 'f');
  try {
    mkdirSync(dir);
    writeFileSync(file, 'x');
    chmodSync(dir, 0o555);
    try { unlinkSync(file); return false; } catch { return true; }
  } finally {
    try { chmodSync(dir, 0o755); } catch { /* best-effort */ }
    rmSync(probe, { recursive: true, force: true });
  }
}
const CHMOD_BITES = chmodBites();
const chmodTest = CHMOD_BITES ? test : test.skip;
const CHMOD_NOTE = CHMOD_BITES ? '' : ' [skipped: chmod does not bite for this uid/capabilities/platform]';

const SLUG = 'secrets/leaked-key';
const REL_PATH = 'secrets/leaked-key.md';
const CONTENT = '---\ntitle: Leaked key\ntype: note\n---\n\n# Body\n\nAKIA-EXAMPLE-NOT-REAL\n';

function localCtx(): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
  } as OperationContext;
}

async function seedPageWithFile(rel = REL_PATH): Promise<string> {
  await importFromContent(engine, SLUG, CONTENT, { noEmbed: true, sourceId: 'default', sourcePath: rel });
  const filePath = join(brainDir, rel);
  mkdirSync(join(brainDir, rel.split('/')[0]), { recursive: true });
  writeFileSync(filePath, CONTENT);
  return filePath;
}

/** Make the artifact path undeletable for ANY uid: a non-empty directory where the file was. */
function replaceFileWithDirectory(filePath: string): void {
  rmSync(filePath);
  mkdirSync(filePath);
  writeFileSync(join(filePath, 'keep'), '');
}
/** Undo replaceFileWithDirectory: put the markdown file back. */
function restoreFile(filePath: string): void {
  rmSync(filePath, { recursive: true, force: true });
  writeFileSync(filePath, CONTENT);
}

async function rowState(): Promise<'absent' | 'live' | 'tombstone'> {
  const rows = await engine.executeRaw<{ deleted_at: string | null }>(
    `SELECT deleted_at FROM pages WHERE source_id = 'default' AND slug = $1`, [SLUG],
  );
  if (rows.length === 0) return 'absent';
  return rows[0].deleted_at === null ? 'live' : 'tombstone';
}

async function softDelete(): Promise<Record<string, any>> {
  return await delete_page.handler(localCtx(), { slug: SLUG }) as Record<string, any>;
}
async function purge(): Promise<Record<string, any>> {
  return await delete_page.handler(localCtx(), { slug: SLUG, purge: true }) as Record<string, any>;
}
async function purgeError(): Promise<OperationError> {
  try {
    await purge();
  } catch (e) {
    expect(e).toBeInstanceOf(OperationError);
    return e as OperationError;
  }
  throw new Error('expected purge to throw storage_error while the file could not be removed');
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  _resetWriteThroughCacheForTest();
  tmpRoot = mkdtempSync(join(tmpdir(), 'gbrain-purge-artifact-'));
  brainDir = join(tmpRoot, 'brain');
  mkdirSync(brainDir, { recursive: true });
  await engine.setConfig('sync.repo_path', brainDir);
});

afterEach(() => {
  // Restore the write bit first so the temp tree can actually be removed.
  try { chmodSync(join(brainDir, 'secrets'), 0o755); } catch { /* may not exist */ }
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('delete_page purge — artifact retry on the tombstone path', () => {
  test('soft-delete whose unlink FAILED (undeletable artifact), then purge: storage_error naming the path, row + file stay; once removable → purged, removed: true, file gone', async () => {
    const filePath = await seedPageWithFile();
    replaceFileWithDirectory(filePath);

    // The earlier soft-delete is best-effort: the row tombstones, the unlink
    // fails, the artifact survives — the setup the resurrection needs.
    const soft = await softDelete();
    expect(soft.status).toBe('soft_deleted');
    expect(soft.write_through.removed).toBe(false);
    expect(typeof soft.write_through.error).toBe('string');
    expect(existsSync(filePath)).toBe(true);
    expect(await rowState()).toBe('tombstone');

    // Purge while the artifact still cannot be removed: fail closed. The row
    // is NOT dropped — dropping it would orphan the file for sync to re-import.
    const err = await purgeError();
    expect(err.code).toBe('storage_error');
    expect(err.message).toContain(filePath);
    expect(String(err.suggestion)).toContain('--purge');
    expect(await rowState()).toBe('tombstone');
    expect(existsSync(filePath)).toBe(true);

    // Operator fixes the cause and re-runs: the retry removes the real
    // artifact and only then does the hard-delete land.
    restoreFile(filePath);
    const res = await purge();
    expect(res.status).toBe('purged');
    expect(res.write_through).toMatchObject({ removed: true, path: filePath });
    expect(res.write_through).not.toHaveProperty('skipped');
    expect(existsSync(filePath)).toBe(false);
    expect(await rowState()).toBe('absent');
    expect(String(res.residuals)).toContain('git history');
  });

  chmodTest(`permissions case: soft-delete under a read-only directory, purge → storage_error until chmod is fixed${CHMOD_NOTE}`, async () => {
    const filePath = await seedPageWithFile();
    chmodSync(join(brainDir, 'secrets'), 0o555);

    const soft = await softDelete();
    expect(soft.status).toBe('soft_deleted');
    expect(soft.write_through.removed).toBe(false);
    expect(String(soft.write_through.error)).toMatch(/EACCES|EPERM/);
    expect(existsSync(filePath)).toBe(true);

    const err = await purgeError();
    expect(err.code).toBe('storage_error');
    expect(err.message).toContain(filePath);
    expect(await rowState()).toBe('tombstone');
    expect(existsSync(filePath)).toBe(true);

    chmodSync(join(brainDir, 'secrets'), 0o755);
    const res = await purge();
    expect(res.status).toBe('purged');
    expect(res.write_through).toMatchObject({ removed: true, path: filePath });
    expect(existsSync(filePath)).toBe(false);
    expect(await rowState()).toBe('absent');
  });

  test('tombstone whose file is STILL on disk (unlink never ran): purge removes the file, reports removed: true, never a fabricated skip', async () => {
    const filePath = await seedPageWithFile();
    // Soft-delete at the engine layer — no write-through ran, so the artifact
    // is exactly what a failed/absent unlink leaves behind.
    expect(await engine.softDeletePage(SLUG, { sourceId: 'default' })).not.toBeNull();
    expect(existsSync(filePath)).toBe(true);

    const res = await purge();
    expect(res.status).toBe('purged');
    expect(res.write_through).toMatchObject({ removed: true, path: filePath });
    expect(res.write_through.skipped).toBeUndefined();
    expect(existsSync(filePath)).toBe(false);
    expect(await rowState()).toBe('absent');
  });

  test('tombstone whose file is already gone: purge reports the real no-op (skipped: file_not_present) and drops the row', async () => {
    const filePath = await seedPageWithFile();
    rmSync(filePath);
    expect(await engine.softDeletePage(SLUG, { sourceId: 'default' })).not.toBeNull();

    const res = await purge();
    expect(res.status).toBe('purged');
    expect(res.write_through).toEqual({ removed: false, path: filePath, skipped: 'file_not_present' });
    expect(await rowState()).toBe('absent');
  });

  test('the tombstone retry resolves the RECORDED source_path, not a slug-derived twin', async () => {
    // Human-authored vault layout: the on-disk name is not the slug.
    const filePath = await seedPageWithFile('Secrets/Leaked Key.md');
    expect(await engine.softDeletePage(SLUG, { sourceId: 'default' })).not.toBeNull();

    const res = await purge();
    expect(res.status).toBe('purged');
    expect(res.write_through).toMatchObject({ removed: true, path: filePath });
    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(join(brainDir, `${SLUG}.md`))).toBe(false);
    expect(await rowState()).toBe('absent');
  });
});

describe('delete_page purge — live-row path fails closed too', () => {
  test('live row whose artifact cannot be removed: storage_error, the row is soft-deleted (not dropped); once removable → second purge completes', async () => {
    const filePath = await seedPageWithFile();
    replaceFileWithDirectory(filePath);

    const err = await purgeError();
    expect(err.code).toBe('storage_error');
    expect(err.message).toContain(filePath);
    // The soft-delete landed (hidden from reads, recoverable), the hard
    // primitive did not run — a re-run resumes on the tombstone path.
    expect(await rowState()).toBe('tombstone');
    expect(existsSync(filePath)).toBe(true);

    restoreFile(filePath);
    const res = await purge();
    expect(res.status).toBe('purged');
    expect(res.write_through).toMatchObject({ removed: true, path: filePath });
    expect(existsSync(filePath)).toBe(false);
    expect(await rowState()).toBe('absent');
  });

  chmodTest(`permissions case: live-row purge under a read-only directory → storage_error, tombstone kept${CHMOD_NOTE}`, async () => {
    const filePath = await seedPageWithFile();
    chmodSync(join(brainDir, 'secrets'), 0o555);
    const err = await purgeError();
    expect(err.code).toBe('storage_error');
    expect(await rowState()).toBe('tombstone');
    expect(existsSync(filePath)).toBe(true);
    chmodSync(join(brainDir, 'secrets'), 0o755);
    expect((await purge()).status).toBe('purged');
    expect(existsSync(filePath)).toBe(false);
  });

  test('a plain (non-purge) soft-delete stays best-effort: an unlink failure is reported, never thrown', async () => {
    const filePath = await seedPageWithFile();
    replaceFileWithDirectory(filePath);
    const res = await softDelete();
    expect(res.status).toBe('soft_deleted');
    expect(res.write_through.removed).toBe(false);
    expect(typeof res.write_through.error).toBe('string');
    expect(existsSync(filePath)).toBe(true);
    expect(await rowState()).toBe('tombstone');
  });
});
