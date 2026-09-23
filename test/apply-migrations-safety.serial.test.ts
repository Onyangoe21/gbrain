import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import type { CompletedMigrationEntry } from '../src/core/preferences.ts';

const root = resolve(import.meta.dir, '..');

async function fixture(run: (home: string, ledger: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-migration-safety-'));
  const dir = join(home, '.gbrain');
  mkdirSync(join(dir, 'migrations'), { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(dir, 'brain') }));
  try {
    await run(home, join(dir, 'migrations/completed.jsonl'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function entries(ledger: string): CompletedMigrationEntry[] {
  return readFileSync(ledger, 'utf8').trim().split('\n').map(row => JSON.parse(row));
}

describe('migration runner completion safety', () => {
  test('forced previews do not copy a legacy ledger or open a nonexistent database', async () => {
    await fixture(async (home, ledger) => {
      const relocated = join(home, 'relocated');
      mkdirSync(join(relocated, '.gbrain'), { recursive: true });
      const database = join(relocated, 'must-not-open');
      writeFileSync(join(relocated, '.gbrain/config.json'), JSON.stringify({ engine: 'pglite', database_path: database }));
      const historical = JSON.stringify({ version: '0.11.0', status: 'partial' }) + '\n';
      writeFileSync(ledger, historical.repeat(3));
      for (const flags of [['--force-retry', '0.11.0'], ['--force-orchestrator'], ['--force-schema'], ['--force-all'], ['--force']]) {
        const result = await runCli(['apply-migrations', '--dry-run', ...flags], {
          home, cwd: home, env: { GBRAIN_HOME: relocated, GBRAIN_NO_AUTOPILOT_INSTALL: '1' },
        });
        expect(result.exitCode).toBe(0);
        expect(readFileSync(ledger, 'utf8')).toBe(historical.repeat(3));
        expect(existsSync(join(relocated, '.gbrain/migrations'))).toBe(false);
        expect(existsSync(database)).toBe(false);
      }
    });
  });

  for (const result of [
    { status: 'complete', phases: [{ name: 'install', status: 'failed', detail: 'fixture install failed' }] },
    { status: 'partial', phases: [{ name: 'install', status: 'failed', detail: 'fixture install failed' }] },
    { status: 'failed', phases: [] },
  ]) {
    test(`records ${result.status} with failed work as partial and exits nonzero`, async () => {
      await fixture(async (home, ledger) => {
        const script = join(home, 'runner.ts');
        writeFileSync(script, `
import { migrations } from ${JSON.stringify(join(root, 'src/commands/migrations/index.ts'))};
import { runApplyMigrations } from ${JSON.stringify(join(root, 'src/commands/apply-migrations.ts'))};
migrations.splice(0, migrations.length, {
  version: '0.11.0', featurePitch: { headline: 'fixture migration' },
  orchestrator: async () => (${JSON.stringify({ version: '0.11.0', ...result })}),
});
await runApplyMigrations(['--yes']);
`);
        const child = Bun.spawnSync([process.execPath, '--no-env-file', script], {
          cwd: home, env: { HOME: home, GBRAIN_HOME: home, PATH: process.env.PATH ?? '' },
          stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
        });
        expect(entries(ledger).at(-1)!.status).toBe('partial');
        expect(child.exitCode).toBe(1);
        if (result.phases.length) expect(child.stderr.toString()).toContain('fixture install failed');
        expect(child.stdout.toString()).not.toContain('Migration v0.11.0 complete.');
      });
    });
  }

  test('failed real install retries, while a historical complete requires explicit force-retry', async () => {
    await fixture(async (home, ledger) => {
      const bin = join(home, 'bin');
      mkdirSync(bin);
      const calls = join(home, 'calls.log');
      const shim = join(bin, 'gbrain');
      const writeShim = (installCode: number) => writeFileSync(shim,
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nif [ "$1" = autopilot ]; then exit ${installCode}; fi\nexit 0\n`, { mode: 0o755 });
      writeShim(7);
      const env = { PATH: `${bin}:${process.env.PATH ?? ''}`, GBRAIN_NO_AUTOPILOT_INSTALL: undefined };
      const args = ['apply-migrations', '--yes', '--migration', '0.11.0'];
      const directScript = join(home, 'orchestrator.ts');
      writeFileSync(directScript, `
import { v0_11_0 } from ${JSON.stringify(join(root, 'src/commands/migrations/v0_11_0.ts'))};
const result = await v0_11_0.orchestrator({ yes: true, dryRun: false, noAutopilotInstall: false });
console.log('RESULT=' + JSON.stringify(result));
`);
      const direct = Bun.spawnSync([process.execPath, '--no-env-file', directScript], {
        cwd: home, env: { HOME: home, GBRAIN_HOME: home, PATH: env.PATH },
        stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
      });
      expect(direct.exitCode).toBe(0);
      const directResult = JSON.parse(direct.stdout.toString().split('\n').find(line => line.startsWith('RESULT='))!.slice(7));
      expect(directResult.status).toBe('partial');
      expect(directResult.phases).toContainEqual(expect.objectContaining({ name: 'install', status: 'failed' }));
      const failed = await runCli(args, { home, cwd: home, env });
      expect(entries(ledger).at(-1)!.status).toBe('partial');
      expect(entries(ledger).at(-1)!.phases).toContainEqual(expect.objectContaining({ name: 'install', status: 'failed' }));
      expect(failed.exitCode).toBe(1);
      expect(failed.stderr).toContain('install');

      writeShim(0);
      const retry = await runCli(args, { home, cwd: home, env });
      expect(retry.exitCode).toBe(0);
      expect(entries(ledger).at(-1)!.status).toBe('complete');

      const historical = JSON.stringify({ version: '0.11.0', status: 'complete', phases: [{ name: 'install', status: 'failed' }] }) + '\n';
      writeFileSync(ledger, historical);
      const callsBefore = readFileSync(calls, 'utf8');
      const noop = await runCli(args, { home, cwd: home, env });
      expect(noop.exitCode).toBe(0);
      expect(readFileSync(ledger, 'utf8')).toBe(historical);
      expect(readFileSync(calls, 'utf8')).toBe(callsBefore);
      const reset = await runCli(['apply-migrations', '--force-retry', '0.11.0'], { home, cwd: home, env });
      expect(reset.exitCode).toBe(0);
      expect(entries(ledger).at(-1)!.status).toBe('retry');
      const recovered = await runCli(args, { home, cwd: home, env });
      expect(recovered.exitCode).toBe(0);
      expect(entries(ledger).at(-1)!.status).toBe('complete');
      expect(readFileSync(calls, 'utf8')).not.toBe(callsBefore);
    });
  }, 60_000);

  for (const disable of ['flag', 'env']) {
    test(`explicit no-autopilot ${disable} completes without invoking install`, async () => {
      await fixture(async (home, ledger) => {
        const bin = join(home, 'bin');
        mkdirSync(bin);
        const calls = join(home, 'calls.log');
        writeFileSync(join(bin, 'gbrain'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nif [ "$1" = autopilot ]; then exit 99; fi\nexit 0\n`, { mode: 0o755 });
        const args = ['apply-migrations', '--yes', '--migration', '0.11.0', ...(disable === 'flag' ? ['--no-autopilot-install'] : [])];
        const result = await runCli(args, {
          home, cwd: home,
          env: { PATH: `${bin}:${process.env.PATH ?? ''}`, GBRAIN_NO_AUTOPILOT_INSTALL: disable === 'env' ? '1' : undefined },
        });
        expect(result.exitCode).toBe(0);
        expect(entries(ledger).at(-1)!.status).toBe('complete');
        expect(entries(ledger).at(-1)!.phases).toContainEqual(expect.objectContaining({ name: 'install', status: 'skipped' }));
        expect(readFileSync(calls, 'utf8')).not.toContain('autopilot');
      });
    });
  }
});
