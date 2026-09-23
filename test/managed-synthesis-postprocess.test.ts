import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseSynthesize } from '../src/core/cycle/synthesize.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const engines: BrainEngine[] = [];
let dataDir: string;
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-postprocess-db-'));
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  const engine = new PGLiteEngine();
  await engine.connect({ database_path: dataDir });
  await engine.initSchema();
  engines.push(engine);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine);
    closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  resetGateway();
  rmSync(dataDir, { recursive: true, force: true });
});

const laterQuote = 'a legitimate later quotation from a completely different interview';

async function fixture(run: (f: {
  engine: BrainEngine; sourceId: string; root: string;
  opts: { brainDir: string; sourceId: string; dryRun: boolean; inputFile: string; date: string };
  calls: () => number; edit: (slug: string) => Promise<void>;
}) => Promise<void>) {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-synth-postprocess-'));
    const root = join(dir, 'brain');
    mkdirSync(root);
    const sourceId = `synthesis-${randomUUID().slice(0, 8)}`;
    let calls = 0;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home'), ANTHROPIC_API_KEY: 'sk-test-synthesis' }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        const ctx = { engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
          dryRun: false, logger: { info() {}, warn() {}, error() {} } };
        await submitPageMutation(ctx, { operation: 'put_page', params: {
          slug: 'people/example', content: '---\ntitle: Example\ntype: note\n---\nExample evidence.', request_id: randomUUID(),
        } });
        const inputFile = join(root, '2026-09-20-session.txt');
        const quote = 'we charge for durability because reliable memories should survive every tool';
        writeFileSync(inputFile, `User: ${quote}.\n${'Assistant: Discuss the long term roadmap.\n'.repeat(15)}`);
        for (const [key, value] of Object.entries({
          'dream.synthesize.enabled': 'true', 'dream.synthesize.cooldown_hours': '0',
          'dream.synthesize.min_chars': '100', 'dream.synthesize.link_manifest': 'false',
          'dream.synthesize.mode': 'oneshot', 'dream.synthesize.quote_verify': 'true',
          'models.dream.synthesize': 'anthropic:claude-sonnet-4-6',
          'models.dream.triage': 'anthropic:claude-sonnet-4-6',
        })) await engine.setConfig(key, value);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        __setChatTransportForTests(async opts => {
          calls++;
          const hash = /hash suffix \(USE THIS in slugs\): ([a-z0-9-]+)/i.exec(String(opts.messages?.[0]?.content ?? ''))?.[1] ?? 'missing';
          const text = (opts.system ?? '').startsWith('You triage a conversation transcript')
            ? JSON.stringify({ score: 0.9, content_type: 'reflection', segments: [{ quote, note: 'evidence' }], entities: [], reasons: ['durable insight'] })
            : JSON.stringify({ pages: [{ slug: `wiki/personal/reflections/session-${hash}`, title: 'Session', type: 'note',
              body: 'A memory strategy with [[people/example]]. Allegedly: "an entirely invented quotation that should lose its marks".' }], skipped: false });
          return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
            usage: { input_tokens: 100, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 },
            model: opts.model!, providerId: 'anthropic' };
        });
        await run({ engine, sourceId, root, opts: { brainDir: root, sourceId, dryRun: false, inputFile, date: '2026-09-20' },
          calls: () => calls, edit: async slug => {
            const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
            await submitPageMutation(ctx, { operation: 'put_page', params: { slug,
              content: `---\ntitle: User revision\ntype: note\n---\nUser evidence: "${laterQuote}".`,
              expected_revision: snapshot.revision, request_id: randomUUID() } });
          } });
      });
    } finally {
      __setChatTransportForTests(null);
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

async function outputSlug(engine: BrainEngine, sourceId: string): Promise<string> {
  const [row] = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id=$1 AND slug LIKE 'wiki/personal/reflections/session-%'", [sourceId]);
  return row.slug;
}

async function interruptAfterChild(engine: BrainEngine, sourceId: string, opts: Parameters<typeof runPhaseSynthesize>[1]) {
  const controller = new AbortController();
  const result = await runPhaseSynthesize(engine, { ...opts, signal: controller.signal, yieldDuringPhase: async () => {
    const rows = await engine.executeRaw("SELECT id FROM minion_jobs WHERE status='completed' AND data->>'source_id'=$1", [sourceId]);
    if (rows.length) controller.abort();
  } });
  expect(result.status).toBe('fail');
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('DELETE FROM dream_verdicts');
}

test('finalized synthesis never rewrites a later user quotation on same-transcript replay', async () => {
  await fixture(async ({ engine, sourceId, root, opts, calls, edit }) => {
    const first = await runPhaseSynthesize(engine, opts);
    expect(first.status).toBe('ok');
    expect(first.details.pages_written).toBe(1);
    const slug = await outputSlug(engine, sourceId);
    await edit(slug);
    const before = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const path = join(root, `${slug}.md`);
    const bytes = readFileSync(path, 'utf8');
    const mtime = statSync(path).mtimeMs;
    const spent = calls();
    const receipts = await engine.executeRaw('SELECT id,state,outcome FROM persistence_requests WHERE source_id=$1 AND slug=$2 ORDER BY sequence', [sourceId, slug]);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('DELETE FROM dream_verdicts');
    const replay = await runPhaseSynthesize(engine, opts);
    expect(replay.status).toBe('ok');
    expect(calls()).toBe(spent);
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.revision).toBe(before.revision);
    expect(readFileSync(path, 'utf8')).toBe(bytes);
    expect(statSync(path).mtimeMs).toBe(mtime);
    expect(await engine.executeRaw('SELECT id,state,outcome FROM persistence_requests WHERE source_id=$1 AND slug=$2 ORDER BY sequence', [sourceId, slug])).toEqual(receipts);
    expect(replay.details.pages_written).toBe(0);
  });
}, 120_000);

test('interrupted synthesis postprocessing resumes once without rerunning either provider', async () => {
  await fixture(async ({ engine, sourceId, root, opts, calls }) => {
    await interruptAfterChild(engine, sourceId, opts);
    const slug = await outputSlug(engine, sourceId);
    expect((await engine.getPage(slug, { sourceId }))!.compiled_truth).toContain('"an entirely invented');
    const spent = calls();
    const recovered = await runPhaseSynthesize(engine, opts);
    expect(recovered.status).toBe('ok');
    expect(calls()).toBe(spent);
    expect(recovered.details.pages_written).toBe(1);
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
    expect(snapshot.page.compiled_truth).not.toContain('"an entirely invented');
    expect(snapshot.page.frontmatter.dream_generated).toBe(true);
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('dream_generated: true');
    await disposePersistenceConsumer(engine);
    const replay = await runPhaseSynthesize(engine, opts);
    expect(replay.status).toBe('ok');
    expect(replay.details.pages_written).toBe(0);
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.revision).toBe(snapshot.revision);
    expect(calls()).toBe(spent);
  });
}, 120_000);

test('unfinished synthesis refuses an intervening user revision rather than adopting it', async () => {
  await fixture(async ({ engine, sourceId, root, opts, calls, edit }) => {
    await interruptAfterChild(engine, sourceId, opts);
    const slug = await outputSlug(engine, sourceId);
    await edit(slug);
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const path = join(root, `${slug}.md`);
    const bytes = readFileSync(path, 'utf8');
    const spent = calls();
    const replay = await runPhaseSynthesize(engine, opts);
    expect(replay.status).toBe('fail');
    expect(calls()).toBe(spent);
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.revision).toBe(snapshot.revision);
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  });
}, 120_000);

test('synthesis postprocessing refuses a concurrent edit after checking the child revision', async () => {
  await fixture(async ({ engine, sourceId, root, opts, calls, edit }) => {
    await interruptAfterChild(engine, sourceId, opts);
    const slug = await outputSlug(engine, sourceId);
    const read = engine.readPageSnapshot;
    let changed = false;
    const spy = spyOn(engine, 'readPageSnapshot').mockImplementation(async function (this: BrainEngine, target, options) {
      const snapshot = await read.call(this, target, options);
      if (this === engine && !changed && target === slug && options?.sourceId === sourceId) {
        changed = true;
        await edit(slug);
      }
      return snapshot;
    });
    const spent = calls();
    try {
      const result = await runPhaseSynthesize(engine, opts);
      expect(changed).toBe(true);
      expect(result.status).toBe('fail');
    } finally { spy.mockRestore(); }
    expect(calls()).toBe(spent);
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.page.compiled_truth).toContain(`"${laterQuote}"`);
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain(`"${laterQuote}"`);
  });
}, 120_000);

test('a committed postprocessing receipt survives interruption before the phase finishes', async () => {
  await fixture(async ({ engine, sourceId, root, opts, calls, edit }) => {
    await interruptAfterChild(engine, sourceId, opts);
    const slug = await outputSlug(engine, sourceId);
    const read = engine.readPageSnapshot;
    let interrupted = false;
    const spy = spyOn(engine, 'readPageSnapshot').mockImplementation(async function (this: BrainEngine, target, options) {
      if (this === engine && target.includes('dream-cycle-summaries/') && options?.sourceId === sourceId) {
        interrupted = true;
        throw new Error('simulated phase interruption after postprocessing commit');
      }
      return read.call(this, target, options);
    });
    const spent = calls();
    try {
      const result = await runPhaseSynthesize(engine, opts);
      expect(result.status).toBe('fail');
      expect(interrupted).toBe(true);
    } finally { spy.mockRestore(); }
    const processed = (await engine.readPageSnapshot(slug, { sourceId }))!;
    expect(processed.page.frontmatter.dream_generated).toBe(true);
    expect(processed.page.compiled_truth).not.toContain('"an entirely invented');
    await edit(slug);
    const edited = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const bytes = readFileSync(join(root, `${slug}.md`), 'utf8');
    await disposePersistenceConsumer(engine);
    const replay = await runPhaseSynthesize(engine, opts);
    expect(replay.status).toBe('ok');
    expect(replay.details.pages_written).toBe(0);
    expect(calls()).toBe(spent);
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.revision).toBe(edited.revision);
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toBe(bytes);
  });
}, 120_000);
