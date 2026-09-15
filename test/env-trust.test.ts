/**
 * cwd `.env` quarantine for security-relevant GBRAIN_* variables.
 *
 * Bun auto-loads `.env` from the process cwd (compiled binaries included), so
 * a `.env` committed into a cloned repository lands in process.env before any
 * gbrain code runs. The #427 DATABASE_URL guard matches VALUES, but Bun also
 * expands `${VAR}` inside .env values, so a value-match guard can never
 * recognise `KEY=${PWD}/x` — the quarantine therefore works on KEY PRESENCE:
 * a protected key that any cwd .env file assigns is dropped from the env,
 * whatever its value.
 *
 * The dir is injected instead of process.chdir'd so these tests stay safe in
 * the parallel shard runner (pattern: test/config-env-hijack.test.ts).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, test } from 'bun:test';
import {
  CWD_DOTENV_FILES,
  CWD_DOTENV_PROTECTED_KEYS,
  cwdDotenvAssignsKey,
  dotenvValuesForKey,
  quarantineCwdDotenv,
} from '../src/core/env-trust.ts';
import { withEnv } from './helpers/with-env.ts';

const dirs: string[] = [];
function tmpProject(envFiles: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-env-trust-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(envFiles)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}
process.on('exit', () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('cwdDotenvAssignsKey', () => {
  test('true when any auto-loaded .env variant assigns the key, regardless of value', () => {
    const dir = tmpProject({
      '.env': 'UNRELATED=1\n',
      '.env.production.local': 'GBRAIN_GUARDRAILS_MODULE=${PWD}/tooling/probe.ts\n',
    });
    expect(cwdDotenvAssignsKey('GBRAIN_GUARDRAILS_MODULE', dir)).toBe(true);
    expect(cwdDotenvAssignsKey('UNRELATED', dir)).toBe(true);
    expect(cwdDotenvAssignsKey('GBRAIN_HOME', dir)).toBe(false);
  });

  test('accepts export prefix, quoting, and an EMPTY value (presence, not value)', () => {
    const dir = tmpProject({
      '.env': ['# comment', 'export GBRAIN_ALLOW_SHELL_JOBS="1"', 'GBRAIN_HOME=', ''].join('\n'),
    });
    expect(cwdDotenvAssignsKey('GBRAIN_ALLOW_SHELL_JOBS', dir)).toBe(true);
    // An empty assignment still shadows the key in Bun's loader.
    expect(cwdDotenvAssignsKey('GBRAIN_HOME', dir)).toBe(true);
    // A commented-out assignment is not an assignment.
    expect(cwdDotenvAssignsKey('comment', dir)).toBe(false);
  });

  test('false when no .env file exists, or the name is outside the auto-load set', () => {
    const none = tmpProject({});
    expect(cwdDotenvAssignsKey('GBRAIN_GUARDRAILS_MODULE', none)).toBe(false);
    const staging = tmpProject({ '.env.staging': 'GBRAIN_GUARDRAILS_MODULE=/x\n' });
    expect(cwdDotenvAssignsKey('GBRAIN_GUARDRAILS_MODULE', staging)).toBe(false);
    expect(CWD_DOTENV_FILES).toContain('.env');
    expect(CWD_DOTENV_FILES).not.toContain('.env.staging');
  });

  test('dotenvValuesForKey (moved from config.ts) still collects values', () => {
    const dir = tmpProject({ '.env': 'DATABASE_URL=postgres://app.example.test/db\n' });
    expect(dotenvValuesForKey('DATABASE_URL', dir).has('postgres://app.example.test/db')).toBe(true);
  });
});

describe('CWD_DOTENV_PROTECTED_KEYS', () => {
  test('covers the code-loading, exec-target, redirect and posture-widening keys', () => {
    for (const k of [
      'GBRAIN_GUARDRAILS_MODULE', 'GBRAIN_PLUGIN_PATH',
      'GBRAIN_CLAUDE_CLI_BIN', 'GBRAIN_CLAUDE_CLI_HERMETIC_CONFIG', 'GBRAIN_JOB_CHILD_CLI', 'GBRAIN_BIN_OVERRIDE',
      'GBRAIN_HOME', 'GBRAIN_MOUNTS_PATH',
      'GBRAIN_ALLOW_SHELL_JOBS', 'GBRAIN_ALLOW_PRIVATE_REMOTES', 'GBRAIN_ALLOW_UNVERIFIED_REMOTE',
      'GBRAIN_GIT_ALLOW_FILE_TRANSPORT', 'GBRAIN_ALLOW_MASS_RECONCILE', 'GBRAIN_ALLOW_DEFAULT_WRITE',
      'GBRAIN_NO_SANITY', 'GBRAIN_REMOTE_PRIVATE_PAGES',
    ]) {
      expect(CWD_DOTENV_PROTECTED_KEYS).toContain(k);
    }
    // Deliberately NOT protected (documented service deployments co-locate them).
    for (const k of ['GBRAIN_ADMIN_BOOTSTRAP_TOKEN', 'GBRAIN_HTTP_CORS_ORIGIN', 'GBRAIN_HTTP_TRUST_PROXY', 'GBRAIN_DATABASE_URL']) {
      expect(CWD_DOTENV_PROTECTED_KEYS).not.toContain(k);
    }
  });
});

describe('quarantineCwdDotenv', () => {
  test('drops a protected key the cwd .env assigns — including the ${PWD}-expanded case', () => {
    const dir = tmpProject({ '.env': 'GBRAIN_GUARDRAILS_MODULE=${PWD}/tooling/probe.ts\n' });
    // What Bun actually puts in process.env after expansion: an ABSOLUTE path
    // that no value-match against the literal file text could recognise.
    const env: Record<string, string | undefined> = {
      GBRAIN_GUARDRAILS_MODULE: `${dir}/tooling/probe.ts`,
      GBRAIN_UNRELATED_THING: 'kept',
      PATH: '/usr/bin',
    };
    const warnings: string[] = [];
    const dropped = quarantineCwdDotenv(env, dir, { warn: (m) => warnings.push(m) });
    expect(dropped).toEqual(['GBRAIN_GUARDRAILS_MODULE']);
    expect('GBRAIN_GUARDRAILS_MODULE' in env).toBe(false);
    expect(env.GBRAIN_UNRELATED_THING).toBe('kept');
    expect(env.PATH).toBe('/usr/bin');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe(
      '[env] Ignoring GBRAIN_GUARDRAILS_MODULE because a .env file in the current directory ' +
      'assigns it — cwd .env files are untrusted for security settings. Export it from your ' +
      'shell or set it in ~/.gbrain/.env.',
    );
  });

  test('several protected keys → ONE warning naming all of them; unprotected assigned keys untouched', () => {
    const dir = tmpProject({
      '.env': 'GBRAIN_ALLOW_SHELL_JOBS=1\nGBRAIN_SOURCE=wiki\n',
      '.env.local': 'GBRAIN_HOME=/tmp/elsewhere\n',
    });
    const env: Record<string, string | undefined> = {
      GBRAIN_ALLOW_SHELL_JOBS: '1',
      GBRAIN_HOME: '/tmp/elsewhere',
      GBRAIN_SOURCE: 'wiki',
    };
    const warnings: string[] = [];
    const dropped = quarantineCwdDotenv(env, dir, { warn: (m) => warnings.push(m) });
    expect(dropped.sort()).toEqual(['GBRAIN_ALLOW_SHELL_JOBS', 'GBRAIN_HOME']);
    expect(env.GBRAIN_ALLOW_SHELL_JOBS).toBeUndefined();
    expect(env.GBRAIN_HOME).toBeUndefined();
    expect(env.GBRAIN_SOURCE).toBe('wiki'); // not a protected key
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('GBRAIN_ALLOW_SHELL_JOBS');
    expect(warnings[0]).toContain('GBRAIN_HOME');
  });

  test('a protected key that is set in env but NOT assigned by any cwd .env is honored', () => {
    const dir = tmpProject({ '.env': 'SOMETHING_ELSE=1\n' });
    const env: Record<string, string | undefined> = { GBRAIN_ALLOW_SHELL_JOBS: '1' };
    const warnings: string[] = [];
    expect(quarantineCwdDotenv(env, dir, { warn: (m) => warnings.push(m) })).toEqual([]);
    expect(env.GBRAIN_ALLOW_SHELL_JOBS).toBe('1');
    expect(warnings).toHaveLength(0);
  });

  test('no .env files → no-op, no warning; assigned-but-unset key → nothing to drop', () => {
    const none = tmpProject({});
    const env: Record<string, string | undefined> = { GBRAIN_HOME: '/tmp/x' };
    const warnings: string[] = [];
    expect(quarantineCwdDotenv(env, none, { warn: (m) => warnings.push(m) })).toEqual([]);
    expect(env.GBRAIN_HOME).toBe('/tmp/x');
    // Assigned in .env but absent from env (e.g. a `--no-env-file` run): nothing to report.
    const dir = tmpProject({ '.env': 'GBRAIN_HOME=/tmp/y\n' });
    expect(quarantineCwdDotenv({}, dir, { warn: (m) => warnings.push(m) })).toEqual([]);
    expect(warnings).toHaveLength(0);
  });

  test('quarantining process.env is visible to a child spawned with env: process.env', async () => {
    const dir = tmpProject({ '.env': 'GBRAIN_ALLOW_SHELL_JOBS=1\n' });
    await withEnv({ GBRAIN_ALLOW_SHELL_JOBS: '1' }, async () => {
      const dropped = quarantineCwdDotenv(process.env, dir, { warn: () => {} });
      expect(dropped).toEqual(['GBRAIN_ALLOW_SHELL_JOBS']);
      expect(process.env.GBRAIN_ALLOW_SHELL_JOBS).toBeUndefined();
      const proc = Bun.spawn(
        [process.execPath, '--no-env-file', '-e', 'process.stdout.write(String(process.env.GBRAIN_ALLOW_SHELL_JOBS ?? "<unset>"))'],
        { cwd: tmpProject({}), env: process.env as Record<string, string>, stdout: 'pipe', stderr: 'pipe' },
      );
      const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(out).toBe('<unset>');
    });
  });
});
