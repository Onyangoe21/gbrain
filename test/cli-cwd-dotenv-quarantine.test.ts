/**
 * End-to-end: a `.env` in the CURRENT DIRECTORY must not be able to make the
 * gbrain CLI load code. Bun auto-loads cwd `.env` files (compiled binaries
 * included) and expands `${VAR}` inside them, so both the relative and the
 * `${PWD}`-expanded spellings of a code-loading variable are tried here.
 *
 * This test deliberately does NOT use test/helpers/cli-spawn.ts: that helper
 * passes `--no-env-file`, which would keep Bun from loading the hostile `.env`
 * and make every assertion below vacuous. The CLI is spawned directly with a
 * hermetic env (HOME / GBRAIN_HOME in a scratch dir) and the hostile dir as
 * cwd. The quarantine warning on stderr only appears when Bun really loaded
 * the file, so it doubles as the harness self-check.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';

function findRepoRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, 'src', 'cli.ts'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no src/cli.ts above ${from}`);
    dir = parent;
  }
}
const REPO_ROOT = findRepoRoot(import.meta.dir);
const CLI_PATH = join(REPO_ROOT, 'src', 'cli.ts');
const COMPILED_BIN = join(REPO_ROOT, 'bin', 'gbrain');

const EXPECTED_WARNING =
  '[env] Ignoring GBRAIN_GUARDRAILS_MODULE because a .env file in the current directory ' +
  'assigns it — cwd .env files are untrusted for security settings. Export it from your ' +
  'shell or set it in ~/.gbrain/.env.';

const scratch: string[] = [];
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

/** A cloned-repo lookalike: `.env` naming a module inside the repo whose top level drops a marker. */
function hostileRepo(envLine: (dir: string) => string): { dir: string; marker: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-hostile-repo-'));
  scratch.push(dir);
  const marker = join(dir, 'PROBE_RAN');
  mkdirSync(join(dir, 'tooling'));
  writeFileSync(
    join(dir, 'tooling', 'probe.ts'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nexport default undefined;\n`,
  );
  writeFileSync(join(dir, '.env'), envLine(dir) + '\n');
  return { dir, marker };
}

function hermeticEnv(cwd: string, extra: Record<string, string> = {}): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-hostile-home-'));
  scratch.push(home);
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    GBRAIN_HOME: home,
    PWD: cwd, // what a shell would set; feeds Bun's ${PWD} expansion
    GBRAIN_SKIP_STARTUP_HOOKS: '1',
    ...extra,
  };
}

// Reap a hung child before bun's per-test ceiling fires. Named (not a trailing
// numeric literal) so the run-unit-shard timeout-pin lint reads it as a kill
// timer, not a hand-pinned test timeout; the test itself inherits the bunfig default.
const CHILD_KILL_AFTER_MS = 55_000;

async function runCli(cmd: string[], cwd: string, env: Record<string, string>) {
  const proc = Bun.spawn(cmd, { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => { try { proc.kill(); } catch { /* exited */ } }, CHILD_KILL_AFTER_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
}

describe('cwd .env cannot drive GBRAIN_GUARDRAILS_MODULE (advisory PoC)', () => {
  const cases: Array<[string, (dir: string) => string]> = [
    ['relative spec', () => 'GBRAIN_GUARDRAILS_MODULE=./tooling/probe.ts'],
    ['${PWD}-expanded absolute spec', () => 'GBRAIN_GUARDRAILS_MODULE=${PWD}/tooling/probe.ts'],
  ];

  for (const [label, envLine] of cases) {
    test(`${label}: gbrain --version from the hostile dir runs no code and warns`, async () => {
      const { dir, marker } = hostileRepo(envLine);
      const r = await runCli([process.execPath, CLI_PATH, '--version'], dir, hermeticEnv(dir));
      expect(existsSync(marker)).toBe(false);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/^gbrain \d/);
      expect(r.stderr).toContain(EXPECTED_WARNING);
    });
  }

  test('control: the same module exported from the shell (absolute path) IS loaded', async () => {
    const { dir, marker } = hostileRepo(() => 'UNRELATED=1');
    const clean = mkdtempSync(join(tmpdir(), 'gbrain-clean-cwd-'));
    scratch.push(clean);
    const env = hermeticEnv(clean, { GBRAIN_GUARDRAILS_MODULE: join(dir, 'tooling', 'probe.ts') });
    const r = await runCli([process.execPath, CLI_PATH, '--version'], clean, env);
    expect(existsSync(marker)).toBe(true); // operator-provided → loader ran the module
    expect(r.exitCode).toBe(1); // …and fail-closed on "registered no guardrail provider"
    expect(r.stderr).toContain('registered no guardrail provider');
    expect(r.stderr).not.toContain('[env] Ignoring');
  });

  const compiledTest = existsSync(COMPILED_BIN) ? test : test.skip;
  compiledTest('compiled binary: same quarantine (bin/gbrain present)', async () => {
    const { dir, marker } = hostileRepo(() => 'GBRAIN_GUARDRAILS_MODULE=./tooling/probe.ts');
    const r = await runCli([COMPILED_BIN, '--version'], dir, hermeticEnv(dir));
    expect(existsSync(marker)).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain(EXPECTED_WARNING);
  });
});
