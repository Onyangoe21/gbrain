import { expect } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ChatResult } from '../../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms, countExtractAtomsBacklog } from '../../src/core/cycle/extract-atoms.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import { sha256 } from '../../src/core/persistence/digest.ts';
import { purgeStaleCheckpoints } from '../../src/core/op-checkpoint.ts';
import { __setChatTransportForTests } from '../../src/core/ai/gateway.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { registerBuiltinHandlers } from '../../src/commands/jobs.ts';
import type { MinionJobContext } from '../../src/core/minions/types.ts';
import { withEnv } from './with-env.ts';

export const atomContractCases = ['publication', 'zero_yield', 'revision', 'removal', 'deferred', 'unavailable', 'source_replaced', 'malformed', 'malformed_retry', 'malformed_retry_failure', 'publication_retry', 'pagination', 'transcript', 'transcript_changed'] as const;
type Case = typeof atomContractCases[number];

export async function exerciseManagedAtoms(engine: BrainEngine, scenario: Case): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-atoms-'));
  const sourceId = `atoms-${scenario.replaceAll('_', '-')}`;
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      await engine.putPage('notes/example', { type: 'source', title: 'Example', compiled_truth: 'A private project record. '.repeat(40), frontmatter: { visibility: 'private' } }, { sourceId });
      const page = (await engine.getPage('notes/example', { sourceId }))!;
      const transcript = scenario.startsWith('transcript') ? join(home, 'meeting.txt') : null;
      if (transcript) writeFileSync(transcript, page.compiled_truth);
      if (scenario === 'pagination') {
        await engine.putPage('notes/second', { type: 'source', title: 'Second', compiled_truth: 'Another distinct project record. '.repeat(40) }, { sourceId });
        await engine.setConfig('cycle.extract_atoms.page_discovery_budget', '1');
      }
      let binding: Awaited<ReturnType<typeof claimWorktree>> | undefined;
      let root: string | undefined;
      if (scenario === 'deferred' || scenario === 'unavailable' || scenario === 'publication' || scenario === 'publication_retry') {
        root = join(home, 'repo');
        mkdirSync(join(root, 'notes'), { recursive: true });
        writeFileSync(join(root, 'notes/example.md'), serializePageToMarkdown(page, []));
        await engine.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', [sourceId, root]);
        await registerLocalWriter(engine, 'cli');
        binding = await claimWorktree(engine, sourceId, root);
      }
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      if (scenario === 'unavailable') await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [binding!.worktree_id]);
      let calls = 0;
      let blockedPath: string | undefined;
      let retryRecovery = false;
      const ctx = { engine, config: { engine: engine.kind }, remote: false, sourceId, dryRun: false, logger: console };
      const chat = async (): Promise<ChatResult> => {
        calls++;
        if (scenario === 'revision' || scenario === 'removal') {
          const snapshot = (await engine.readPageSnapshot(page.slug, { sourceId }))!;
          await submitPageMutation(ctx, { operation: scenario === 'removal' ? 'delete_page' : 'put_page',
            params: { slug: page.slug, expected_revision: snapshot.revision, ...(scenario === 'revision' ? { content: '# Changed\n\nA concurrent edit.' } : {}) } });
        }
        if (scenario === 'source_replaced') await engine.transaction(async tx => {
          await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
          await tx.executeRaw('UPDATE sources SET incarnation=gen_random_uuid() WHERE id=$1', [sourceId]);
        });
        if (scenario === 'deferred') await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [binding!.worktree_id]);
        if (scenario === 'transcript_changed') writeFileSync(transcript!, 'Changed while extraction was running.');
        if (scenario === 'publication_retry') {
          const path = join(root!, 'atoms', new Date().toISOString().slice(0, 10));
          mkdirSync(path, { recursive: true });
          blockedPath = join(path, `measured-progress-${sha256(`${page.slug}\0Measured progress`).slice(0, 8)}.md`);
          writeFileSync(blockedPath, 'Unindexed operator content.');
        }
        return { text: scenario === 'zero_yield' ? '[]' : scenario === 'malformed' || scenario.startsWith('malformed_retry') &&
          (calls === 1 || scenario === 'malformed_retry_failure' && !retryRecovery) ? 'not valid output' :
          '[{"title":"Measured progress","atom_type":"insight","body":"Measure progress against clear exit criteria."}]', blocks: [], stopReason: 'end',
          usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
      };
      const opts = { sourceId,
        _transcripts: transcript ? [{ filePath: transcript, content: page.compiled_truth, contentHash: sha256(page.compiled_truth) }] : [],
        _pages: transcript ? [] : scenario === 'pagination' ? undefined : [{ slug: page.slug, content: page.compiled_truth, contentHash: page.content_hash! }], _chat: chat };
      if (scenario === 'unavailable') {
        await expect(runPhaseExtractAtoms(engine, opts)).rejects.toMatchObject({ code: 'owner_unavailable' });
        expect(calls).toBe(0);
        return;
      }
      const first = await runPhaseExtractAtoms(engine, opts);
      if (scenario.startsWith('malformed_retry') || scenario === 'publication_retry') {
        expect(first.status).toBe('warn');
        expect(calls).toBe(1);
        const receipt = (first.details?.write_requests as Array<{ request_id: string }>)[0];
        expect(receipt.request_id).toBeTruthy();
        const [original] = await engine.executeRaw<{ state: string; outcome: unknown }>('SELECT state,outcome FROM persistence_requests WHERE request_id=$1::uuid', [receipt.request_id]);
        if (blockedPath) rmSync(blockedPath);
        const worker = new MinionWorker(engine, { queue: 'fixture' });
        await registerBuiltinHandlers(worker, engine, { quiet: true });
        __setChatTransportForTests(chat);
        const job: MinionJobContext = { id: 944, name: 'extract-atoms-drain', data: { sourceId, retryRequestId: receipt.request_id }, attempts_made: 0,
          signal: new AbortController().signal, deadlineAtMs: null, shutdownSignal: new AbortController().signal,
          updateProgress: async () => {}, updateTokens: async () => {}, log: async () => {}, isActive: async () => true, readInbox: async () => [] };
        if (scenario === 'malformed_retry_failure') {
          await expect(worker.getHandler('extract-atoms-drain')!(job)).rejects.toMatchObject({ code: 'extraction_failed' });
          expect(calls).toBe(2);
          await disposePersistenceConsumer(engine);
          await expect(worker.getHandler('extract-atoms-drain')!(job)).rejects.toMatchObject({ code: 'extraction_failed' });
          expect(calls).toBe(2);
          retryRecovery = true;
          job.id = 945;
        }
        const retried = await worker.getHandler('extract-atoms-drain')!(job) as Record<string, unknown>;
        expect(retried.model_rerun).toBe(scenario.startsWith('malformed_retry'));
        const expectedCalls = scenario === 'malformed_retry_failure' ? 3 : scenario === 'malformed_retry' ? 2 : 1;
        expect(calls).toBe(expectedCalls);
        await disposePersistenceConsumer(engine);
        expect(await worker.getHandler('extract-atoms-drain')!(job)).toMatchObject({ replayed: true, model_rerun: false });
        await runPhaseExtractAtoms(engine, opts);
        expect(calls).toBe(expectedCalls);
        expect(await engine.executeRaw("SELECT id FROM pages WHERE source_id=$1 AND type='atom'", [sourceId])).toHaveLength(1);
        const [unchanged] = await engine.executeRaw<{ state: string; outcome: unknown }>('SELECT state,outcome FROM persistence_requests WHERE request_id=$1::uuid', [receipt.request_id]);
        expect(unchanged).toEqual(original);
        return;
      }
      if (scenario === 'revision' || scenario === 'removal' || scenario === 'source_replaced' || scenario === 'transcript_changed') {
        expect(calls).toBe(1);
        expect(first.status).toBe('warn');
        expect(first.details?.atoms_extracted).toBe(0);
        expect(await engine.executeRaw("SELECT id FROM pages WHERE source_id=$1 AND type='atom'", [sourceId])).toHaveLength(0);
        expect(await engine.executeRaw("SELECT fingerprint FROM op_checkpoints WHERE op='managed-atoms' AND completed_keys->0->>'sourceId'=$1", [sourceId])).toHaveLength(0);
        if (scenario === 'revision') expect((await engine.getPage(page.slug, { sourceId }))?.compiled_truth).toContain('A concurrent edit.');
        if (scenario === 'removal') expect(await engine.getPage(page.slug, { sourceId })).toBeNull();
        return;
      }
      if (scenario === 'pagination') {
        expect(first.status).toBe('ok');
        expect(calls).toBe(1);
        expect(await countExtractAtomsBacklog(engine, sourceId)).toBe(1);
        expect((await runPhaseExtractAtoms(engine, opts)).status).toBe('ok');
        expect(calls).toBe(2);
        expect(await countExtractAtomsBacklog(engine, sourceId)).toBe(0);
        await runPhaseExtractAtoms(engine, opts);
        expect(calls).toBe(2);
        expect(await engine.executeRaw("SELECT id FROM pages WHERE source_id=$1 AND type='atom'", [sourceId])).toHaveLength(2);
        return;
      }
      if (scenario === 'deferred') {
        expect(first.status).toBe('warn');
        expect(first.details?.atoms_extracted).toBe(0);
        expect(first.details?.write_requests).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'queued' })]));
        await engine.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid", [binding!.worktree_id]);
      } else expect(first.status).toBe(scenario === 'malformed' ? 'warn' : 'ok');
      if (scenario === 'zero_yield') {
        await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '30 days' WHERE op='managed-atoms' AND completed_keys->0->>'sourceId'=$1", [sourceId]);
        await purgeStaleCheckpoints(engine, 7);
      }
      const replay = await runPhaseExtractAtoms(engine, opts);
      expect(calls).toBe(1);
      expect(replay.status).toBe(scenario === 'malformed' ? 'warn' : 'ok');
      const atoms = await engine.executeRaw<{ slug: string; visibility: string }>("SELECT slug,frontmatter->>'visibility' AS visibility FROM pages WHERE source_id=$1 AND type='atom'", [sourceId]);
      expect(atoms).toHaveLength(scenario === 'zero_yield' || scenario === 'malformed' ? 0 : 1);
      if (atoms.length) {
        expect(atoms[0].visibility).toBe('private');
        expect(await engine.executeRaw('SELECT c.id FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1 AND p.slug=$2', [sourceId, atoms[0].slug])).not.toHaveLength(0);
        if (!transcript) expect(await engine.executeRaw('SELECT l.id FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.source_id=$1 AND t.source_id=$1 AND f.slug=$2 AND t.slug=$3', [sourceId, page.slug, atoms[0].slug])).toHaveLength(1);
        if (root) expect(readFileSync(join(root, `${atoms[0].slug}.md`), 'utf8')).toContain('visibility: private');
      }
      if (scenario !== 'malformed' && !transcript) expect(await countExtractAtomsBacklog(engine, sourceId)).toBe(0);
      expect((await engine.getPage(page.slug, { sourceId }))?.frontmatter).not.toHaveProperty('atoms_scan_hash');
    });
  } finally { await disposePersistenceConsumer(engine); await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1'); __setChatTransportForTests(null); rmSync(home, { recursive: true, force: true }); }
}
