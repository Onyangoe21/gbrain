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

// ── Preflight ORDER: quarantine → $GBRAIN_HOME/.gbrain/.env → guardrails ────
//
// Step 2 of cli-preflight.ts exists so the operator-owned ~/.gbrain/.env can
// be the home for GBRAIN_GUARDRAILS_MODULE; step 1 runs first so a cwd .env
// cannot pick WHICH home that is (GBRAIN_HOME is on the protected list).
describe('cli preflight ordering: cwd quarantine → ~/.gbrain/.env → guardrails loader', () => {
  test('the operator-owned $GBRAIN_HOME/.gbrain/.env IS honored as the home for GBRAIN_GUARDRAILS_MODULE', async () => {
    const { dir, marker } = hostileRepo(() => 'UNRELATED=1'); // probe lives here; its .env is harmless
    const clean = mkdtempSync(join(tmpdir(), 'gbrain-clean-cwd-'));
    scratch.push(clean);
    const env = hermeticEnv(clean);
    // configDir() === $GBRAIN_HOME/.gbrain — the loader reads <configDir>/.env.
    mkdirSync(join(env.GBRAIN_HOME, '.gbrain'), { recursive: true });
    writeFileSync(
      join(env.GBRAIN_HOME, '.gbrain', '.env'),
      `GBRAIN_GUARDRAILS_MODULE=${join(dir, 'tooling', 'probe.ts')}\n`,
    );
    const r = await runCli([process.execPath, CLI_PATH, '--version'], clean, env);
    expect(existsSync(marker)).toBe(true); // operator home → loader ran the module …
    expect(r.exitCode).toBe(1); // … and fail-closed on "registered no guardrail provider"
    expect(r.stderr).toContain('registered no guardrail provider');
    expect(r.stderr).not.toContain('[env] Ignoring');
  });

  test('a cwd .env cannot relocate GBRAIN_HOME to smuggle in its own .gbrain/.env: quarantined BEFORE the config dir resolves', async () => {
    const { dir, marker } = hostileRepo(() => 'GBRAIN_HOME=${PWD}/evil-home');
    // The planted "home" carries a .gbrain/.env naming the probe as guardrails module.
    mkdirSync(join(dir, 'evil-home', '.gbrain'), { recursive: true });
    writeFileSync(
      join(dir, 'evil-home', '.gbrain', '.env'),
      `GBRAIN_GUARDRAILS_MODULE=${join(dir, 'tooling', 'probe.ts')}\n`,
    );
    const env = hermeticEnv(dir);
    delete env.GBRAIN_HOME; // exported vars beat .env in Bun; the attack needs the .env value to land
    const r = await runCli([process.execPath, CLI_PATH, '--version'], dir, env);
    expect(existsSync(marker)).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^gbrain \d/);
    expect(r.stderr).toContain('[env] Ignoring GBRAIN_HOME because a .env file in the current directory assigns it');
  });
});

// ── Descendants: the sanitized re-exec hop (A2) ──────────────────────────────
//
// Removing a key from the parent environment is invisible to children spawned without an explicit
// `env` — Bun hands them its startup environ snapshot, cwd-.env values
// included. Preflight therefore re-execs gbrain once with a sanitized
// environment whenever the quarantine dropped anything (cli-preflight.ts).
// The entry script below stands in for any gbrain command that shells out
// from the cwd: real preflight, then `git status --porcelain` with NO env
// option — the exact spawn shape the snapshot would otherwise poison.
const GIT_BIN = Bun.which('git');

describe('a cwd .env cannot reach the programs gbrain spawns (sanitized re-exec)', () => {
  /** Hostile checkout: .env plants a git config injection (core.fsmonitor → marker script) next to a GBRAIN_* opt-in. */
  function hostileGitRepo(): { dir: string; evilMarker: string; entry: string } {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-hostile-git-'));
    scratch.push(dir);
    Bun.spawnSync([GIT_BIN!, 'init', '-q'], { cwd: dir });
    mkdirSync(join(dir, 'tooling'));
    const evilMarker = join(dir, 'EVIL_RAN');
    writeFileSync(join(dir, 'tooling', 'evil.sh'), `#!/bin/sh\ntouch ${JSON.stringify(evilMarker)}\n`, { mode: 0o755 });
    writeFileSync(join(dir, '.env'), [
      'GBRAIN_ALLOW_SHELL_JOBS=1',
      'GIT_CONFIG_COUNT=1',
      'GIT_CONFIG_KEY_0=core.fsmonitor',
      'GIT_CONFIG_VALUE_0=./tooling/evil.sh',
      'PROJECT_NAME=demo', // an ordinary project variable: must keep loading
      '',
    ].join('\n'));
    const entry = join(dir, 'tooling', 'entry.ts');
    writeFileSync(entry, [
      `import { runCliPreflight } from ${JSON.stringify(join(REPO_ROOT, 'src', 'core', 'cli-preflight.ts'))};`,
      `if (process.argv.includes('--preflight')) await runCliPreflight();`,
      `const r = Bun.spawnSync(['git', 'status', '--porcelain']); // no env option: inherits the startup snapshot`,
      'process.stdout.write(`GIT_EXIT=${r.exitCode} GIT_CONFIG_COUNT=${JSON.stringify(process.env.GIT_CONFIG_COUNT ?? null)} ' +
        'PROJECT_NAME=${process.env.PROJECT_NAME ?? ""}\\n`);',
      `process.exit(7);`,
      '',
    ].join('\n'));
    return { dir, evilMarker, entry };
  }

  test.skipIf(!GIT_BIN)('control: without preflight the planted git config runs the script (the PoC is live here)', async () => {
    const { dir, evilMarker, entry } = hostileGitRepo();
    const r = await runCli([process.execPath, entry], dir, hermeticEnv(dir));
    expect(r.exitCode).toBe(7);
    expect(existsSync(evilMarker)).toBe(true);
  });

  test.skipIf(!GIT_BIN)('with preflight: git never sees the injection, exit code passes through, ONE warning names the keys', async () => {
    const { dir, evilMarker, entry } = hostileGitRepo();
    const r = await runCli([process.execPath, entry, '--preflight'], dir, hermeticEnv(dir));
    expect(existsSync(evilMarker)).toBe(false);
    expect(r.exitCode).toBe(7); // the re-exec'd child's status, not the hop's
    expect(r.stdout).toContain('GIT_EXIT=0');
    expect(r.stdout).toContain('GIT_CONFIG_COUNT=null'); // in-process view: deleted, as before
    expect(r.stdout).toContain('PROJECT_NAME=demo'); // unprotected keys still load from the cwd .env
    const warnings = r.stderr.split('\n').filter((l) => l.startsWith('[env] Ignoring'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      'Ignoring GBRAIN_ALLOW_SHELL_JOBS, GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0 because a .env file in the current directory assigns it',
    );
  });
});

// ── cwd == config dir: the operator's own .env is not a "cwd .env" (A4) ──────
describe('running gbrain from inside its own config dir', () => {
  /** A VALID provider module (registers one guardrail) that also drops a marker when imported. */
  function validProvider(): { path: string; marker: string } {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-a4-provider-'));
    scratch.push(dir);
    const marker = join(dir, 'PROVIDER_LOADED');
    const path = join(dir, 'provider.mjs');
    writeFileSync(
      path,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\n` +
      `export default { id: 'fixture-a4', classify() {} };\n`,
    );
    return { path, marker };
  }

  test('$GBRAIN_HOME/.gbrain as cwd: its .env is honored, no quarantine warning, exit 0', async () => {
    const clean = mkdtempSync(join(tmpdir(), 'gbrain-clean-cwd-'));
    scratch.push(clean);
    const env = hermeticEnv(clean);
    const cfgDir = join(env.GBRAIN_HOME, '.gbrain');
    mkdirSync(cfgDir, { recursive: true });
    const { path, marker } = validProvider();
    writeFileSync(join(cfgDir, '.env'), `GBRAIN_GUARDRAILS_MODULE=${path}\n`);
    const r = await runCli([process.execPath, CLI_PATH, '--version'], cfgDir, { ...env, PWD: cfgDir });
    expect(r.stderr).not.toContain('[env] Ignoring');
    expect(r.stderr).not.toContain('guardrails:');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^gbrain \d/);
    expect(existsSync(marker)).toBe(true); // the operator's provider loaded
  });

  test('hostile variant: a checkout whose .env assigns GBRAIN_HOME to manufacture the collision is still quarantined', async () => {
    const { dir, marker } = hostileRepo(() => 'UNRELATED=1'); // the probe module lives here
    // The checkout IS <dir>/evil-home/.gbrain and points GBRAIN_HOME at <dir>/evil-home, so configDir() === cwd.
    const fakeCfg = join(dir, 'evil-home', '.gbrain');
    mkdirSync(fakeCfg, { recursive: true });
    writeFileSync(
      join(fakeCfg, '.env'),
      `GBRAIN_HOME=${join(dir, 'evil-home')}\nGBRAIN_GUARDRAILS_MODULE=${join(dir, 'tooling', 'probe.ts')}\n`,
    );
    const env = hermeticEnv(fakeCfg);
    delete env.GBRAIN_HOME; // exported vars beat .env in Bun; the attack needs the .env value to land
    const r = await runCli([process.execPath, CLI_PATH, '--version'], fakeCfg, env);
    expect(existsSync(marker)).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^gbrain \d/);
    expect(r.stderr).toContain('[env] Ignoring GBRAIN_GUARDRAILS_MODULE, GBRAIN_HOME because a .env file in the current directory assigns it');
  });
});
