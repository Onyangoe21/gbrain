/**
 * End-to-end: a `.env` in the CURRENT DIRECTORY must not be able to make the
 * gbrain CLI load code. Bun auto-loads cwd `.env` files (compiled binaries
 * included) and expands `${VAR}` inside them, so both the relative and the
 * `${PWD}`-expanded spellings of a code-loading variable are tried here.
 *
 * This test deliberately does NOT use the shared `cli-spawn.ts` helper under
 * test/helpers/: that helper passes `--no-env-file`, which would keep Bun from loading the hostile `.env`
 * and make every assertion below vacuous. The CLI is spawned directly with a
 * hermetic env (HOME / GBRAIN_HOME in a scratch dir) and the hostile dir as
 * cwd. The quarantine warning on stderr only appears when Bun really loaded
 * the file, so it doubles as the harness self-check.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
// The compiled case must RUN where a binary exists: `bun build --compile --no-compile-autoload-bunfig --outfile bin/gbrain src/cli.ts`
// (bin/ is gitignored); GBRAIN_COMPILED_BIN points at a binary built elsewhere.
const COMPILED_BIN = process.env.GBRAIN_COMPILED_BIN ?? join(REPO_ROOT, 'bin', 'gbrain');
const PREFLIGHT_MODULE = join(REPO_ROOT, 'src', 'core', 'cli-preflight.ts');

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
    // A3-3: a cwd .env assigning a non-empty GBRAIN_GUARDRAILS_MODULE now fails
    // CLOSED — the module still never runs (marker absent), but instead of
    // quarantining + re-running (the old exit 0) preflight refuses (exit 1), so
    // the process never continues without the firewall the assignment implied.
    test(`${label}: gbrain --version from the hostile dir runs no code and refuses (fail-closed)`, async () => {
      const { dir, marker } = hostileRepo(envLine);
      const r = await runCli([process.execPath, CLI_PATH, '--version'], dir, hermeticEnv(dir));
      expect(existsSync(marker)).toBe(false);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain(EXPECTED_WARNING); // the quarantine warning still prints …
      expect(r.stderr).toContain("refusing to run without the operator's firewall"); // … then the refusal
      expect(r.stdout).not.toMatch(/^gbrain \d/);
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

  // A3-3: fail-CLOSED when a cwd .env assigns GBRAIN_GUARDRAILS_MODULE. Key
  // presence, not value: Bun merges the file before gbrain starts and never
  // overrides a live variable, so an operator-exported module cannot be told
  // apart from the file's. Dropping it and re-running would leave the child
  // with NO firewall (the #3688 contract is fail-closed), so preflight refuses
  // to run at all rather than silently downgrade.
  test('fail-closed: a cwd .env assigning GBRAIN_GUARDRAILS_MODULE (operator also exported one) refuses to run — exit 1, module NOT loaded', async () => {
    const { dir, marker } = hostileRepo(() => 'GBRAIN_GUARDRAILS_MODULE=./tooling/probe.ts');
    const env = hermeticEnv(dir, { GBRAIN_GUARDRAILS_MODULE: join(dir, 'tooling', 'probe.ts') });
    const r = await runCli([process.execPath, CLI_PATH, '--version'], dir, env);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("refusing to run without the operator's firewall");
    expect(existsSync(marker)).toBe(false); // the module never imported
    expect(r.stdout).not.toMatch(/^gbrain \d/);
  });

  test('control: an exported GBRAIN_GUARDRAILS_MODULE survives when the cwd .env assigns a DIFFERENT protected key — the re-run still loads it', async () => {
    const { dir, marker } = hostileRepo(() => 'GBRAIN_ALLOW_SHELL_JOBS=1'); // a different protected key
    const env = hermeticEnv(dir, { GBRAIN_GUARDRAILS_MODULE: join(dir, 'tooling', 'probe.ts') });
    const r = await runCli([process.execPath, CLI_PATH, '--version'], dir, env);
    // The other key is quarantined and the process re-runs; the exported module
    // rides the sanitized env and the loader still imports it (marker written),
    // then fail-closes on the probe registering zero providers.
    expect(existsSync(marker)).toBe(true);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('registered no guardrail provider');
    expect(r.stderr).not.toContain("refusing to run without the operator's firewall");
  });

  const compiledTest = existsSync(COMPILED_BIN) ? test : test.skip;
  compiledTest('compiled binary: same fail-closed refusal (bin/gbrain present)', async () => {
    const { dir, marker } = hostileRepo(() => 'GBRAIN_GUARDRAILS_MODULE=./tooling/probe.ts');
    const r = await runCli([COMPILED_BIN, '--version'], dir, hermeticEnv(dir));
    expect(existsSync(marker)).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(EXPECTED_WARNING);
    expect(r.stderr).toContain("refusing to run without the operator's firewall");
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

// ── Descendants: the sanitized re-run from a neutral cwd (A2) ────────────────
//
// Removing a key from the parent environment is invisible to children spawned
// without an explicit `env` — Bun hands them its startup environ snapshot,
// cwd-.env values included. Preflight therefore re-runs gbrain once from a
// fresh EMPTY temp dir with the sanitized environment whenever the quarantine
// dropped anything, and the re-run chdirs back in its own preflight
// (cli-preflight.ts). The entry script below stands in for any gbrain command
// that shells out from the cwd: real preflight, then `git status --porcelain`
// with NO env/cwd option — the exact spawn shape the snapshot would poison —
// plus a `sh` PRESENCE probe: `GIT_SSL_NO_VERIFY=` (empty) still disables TLS
// verification in git, so a dropped key must be ABSENT, not ''.
const GIT_BIN = Bun.which('git');
// util-linux `script` gives the wrapper a real pty so process.stdin.isTTY is
// true — the only way to exercise the tty (ignore-only) SIGINT branch faithfully.
const SCRIPT_BIN = Bun.which('script');

const HOSTILE_ENV_LINES = [
  'GBRAIN_ALLOW_SHELL_JOBS=1',
  'GIT_CONFIG_COUNT=1',
  'GIT_CONFIG_KEY_0=core.fsmonitor',
  'GIT_CONFIG_VALUE_0=./tooling/evil.sh',
  'GIT_SSL_NO_VERIFY=1', // presence-checked by git: must end up unset, never ''
  'PROJECT_NAME=demo', // an ordinary project variable: must keep loading
];
const HOSTILE_WARNING_KEYS =
  'GBRAIN_ALLOW_SHELL_JOBS, GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0, GIT_SSL_NO_VERIFY';

/** The default entry body: git probe + presence probe + a one-line report, exit 7. */
const PROBE_BODY = [
  `const r = Bun.spawnSync(['git', 'status', '--porcelain']); // no env/cwd option: inherits the startup snapshot, runs in process.cwd()`,
  `const sh = Bun.spawnSync(['sh', '-c', 'echo "GIT_SSL_NO_VERIFY=[\${GIT_SSL_NO_VERIFY-unset}]"']);`,
  'process.stdout.write(`GIT_EXIT=${r.exitCode} GIT_CONFIG_COUNT=${JSON.stringify(process.env.GIT_CONFIG_COUNT ?? null)} ' +
    'PROJECT_NAME=${process.env.PROJECT_NAME ?? ""} CWD=${process.cwd()} ' +
    'MARKER=${JSON.stringify(process.env.GBRAIN_CWD_ENV_QUARANTINED ?? null)} ' +
    'ARGS=${JSON.stringify(process.argv.slice(2))} ${sh.stdout.toString().trim()}\\n`);',
  `process.exit(7);`,
].join('\n');

interface HostileGitRepo { dir: string; evilMarker: string; entry: string; ready: string }

/**
 * Hostile checkout: a git repo whose .env plants a git config injection
 * (core.fsmonitor → marker script) next to a GBRAIN_* opt-in. `envLines`
 * replaces the default .env body (a function of the dir for absolute paths);
 * `entryBody` replaces the probe that runs after preflight.
 */
function hostileGitRepo(opts: { envLines?: (dir: string) => string[]; entryBody?: string } = {}): HostileGitRepo {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-hostile-git-'));
  scratch.push(dir);
  Bun.spawnSync([GIT_BIN!, 'init', '-q'], { cwd: dir });
  mkdirSync(join(dir, 'tooling'));
  const evilMarker = join(dir, 'EVIL_RAN');
  writeFileSync(join(dir, 'tooling', 'evil.sh'), `#!/bin/sh\ntouch ${JSON.stringify(evilMarker)}\n`, { mode: 0o755 });
  writeFileSync(join(dir, '.env'), [...(opts.envLines ?? (() => HOSTILE_ENV_LINES))(dir), ''].join('\n'));
  const entry = join(dir, 'tooling', 'entry.ts');
  const ready = join(dir, 'READY');
  writeFileSync(entry, [
    `import { writeFileSync, renameSync } from 'node:fs';`,
    `import { runCliPreflight } from ${JSON.stringify(PREFLIGHT_MODULE)};`,
    `const READY = ${JSON.stringify(ready)};`,
    // Atomic READY write: a plain writeFileSync can be observed mid-write and
    // `Number('')` reads back 0 — write a .tmp then renameSync (atomic on the
    // same fs) so waitReady never sees a partial file.
    `const writeReady = (v) => { writeFileSync(READY + '.tmp', String(v)); renameSync(READY + '.tmp', READY); };`,
    `if (process.argv.includes('--preflight')) await runCliPreflight();`,
    opts.entryBody ?? PROBE_BODY,
    '',
  ].join('\n'));
  return { dir, evilMarker, entry, ready };
}

const warningLines = (stderr: string) => stderr.split('\n').filter((l) => l.startsWith('[env] Ignoring'));

/** Poll for the READY file the signal-test entries write once their handlers are installed. */
async function waitReady(path: string): Promise<number> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return Number(readFileSync(path, 'utf8'));
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('entry never signalled readiness');
}

async function gone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe('a cwd .env cannot reach the programs gbrain spawns (sanitized re-run)', () => {
  test.skipIf(!GIT_BIN)('control: without preflight the planted git config runs the script and the TLS knob is live (the PoC is live here)', async () => {
    const { dir, evilMarker, entry } = hostileGitRepo();
    const r = await runCli([process.execPath, entry], dir, hermeticEnv(dir));
    expect(r.exitCode).toBe(7);
    expect(existsSync(evilMarker)).toBe(true);
    expect(r.stdout).toContain('GIT_SSL_NO_VERIFY=[1]');
  });

  test.skipIf(!GIT_BIN)('with preflight: git never sees the injection, dropped keys are ABSENT (not ""), cwd + argv restored, exit code passes through, ONE warning', async () => {
    const { dir, evilMarker, entry } = hostileGitRepo();
    const r = await runCli([process.execPath, entry, '--preflight', '--probe=./relative/thing'], dir, hermeticEnv(dir));
    expect(existsSync(evilMarker)).toBe(false);
    expect(r.exitCode).toBe(7); // the re-run's status, not the wrapper's
    expect(r.stdout).toContain('GIT_EXIT=0');
    expect(r.stdout).toContain('GIT_CONFIG_COUNT=null'); // in-process view: absent
    expect(r.stdout).toContain('GIT_SSL_NO_VERIFY=[unset]'); // presence probe: the sh child never saw the key
    expect(r.stdout).toContain('PROJECT_NAME=demo'); // unprotected keys still load from the cwd .env
    expect(r.stdout).toContain(`CWD=${realpathSync(dir)}`); // the re-run switched back to the caller's directory
    expect(r.stdout).toContain('MARKER=null'); // the internal marker is not visible to the command
    expect(r.stdout).toContain('ARGS=["--preflight","--probe=./relative/thing"]'); // relative argv preserved verbatim
    const warnings = warningLines(r.stderr);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`Ignoring ${HOSTILE_WARNING_KEYS} because a .env file in the current directory assigns it`);
  });

  // The marker that tells the re-run "you already hopped" is a plain env var,
  // so a hostile .env can plant one. It is honoured only when the process's
  // startup cwd IS the .env-free neutral dir it names — impossible from a
  // hostile checkout, whose startup cwd has a .env by construction.
  const forged: Array<[label: string, value: (dir: string) => string]> = [
    ['flag-like value', () => '1'],
    ['the real parent pid (the old ppid-shaped guard)', () => String(process.pid)],
    ['JSON naming the hostile dir as neutral', (dir) => `'${JSON.stringify({ cwd: dir, neutral: dir })}'`],
    ['JSON naming a genuine .env-free dir as neutral', (dir) => {
      const decoy = mkdtempSync(join(tmpdir(), 'gbrain-decoy-neutral-'));
      scratch.push(decoy);
      return `'${JSON.stringify({ cwd: dir, neutral: decoy })}'`;
    }],
  ];
  for (const [label, value] of forged) {
    test.skipIf(!GIT_BIN)(`forged marker (${label}) planted in the .env does not suppress the hop`, async () => {
      const { dir, evilMarker, entry } = hostileGitRepo({
        envLines: (d) => [...HOSTILE_ENV_LINES, `GBRAIN_CWD_ENV_QUARANTINED=${value(d)}`],
      });
      const r = await runCli([process.execPath, entry, '--preflight'], dir, hermeticEnv(dir));
      expect(existsSync(evilMarker)).toBe(false);
      expect(r.exitCode).toBe(7);
      expect(r.stdout).toContain('GIT_EXIT=0');
      expect(r.stdout).toContain('GIT_SSL_NO_VERIFY=[unset]');
      expect(r.stdout).toContain('MARKER=null');
      const warnings = warningLines(r.stderr);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('GBRAIN_CWD_ENV_QUARANTINED'); // planted copy: dropped and named like any protected key
    });
  }

  test.skipIf(!GIT_BIN)('harness self-check: a planted JSON marker really lands in process.env (no preflight)', async () => {
    const { dir, entry } = hostileGitRepo({
      envLines: (d) => [...HOSTILE_ENV_LINES, `GBRAIN_CWD_ENV_QUARANTINED='${JSON.stringify({ cwd: d, neutral: d })}'`],
    });
    const r = await runCli([process.execPath, entry], dir, hermeticEnv(dir));
    expect(r.stdout).toContain(`MARKER=${JSON.stringify(JSON.stringify({ cwd: dir, neutral: dir }))}`);
  });

  test.skipIf(!GIT_BIN)('depth 2: a hopped process that spawns gbrain again from the hostile cwd hops once more and stops — exit code and exactly two warnings', async () => {
    const { dir, evilMarker, entry } = hostileGitRepo({
      entryBody: [
        `if (process.argv.includes('--level1')) { Bun.spawnSync(['git', 'status', '--porcelain']); process.exit(5); }`,
        // level 0: the shape of every gbrain self-spawn — explicit env (the quarantined view), the hostile cwd.
        `const r = Bun.spawnSync([process.execPath, process.argv[1], '--preflight', '--level1'], { env: process.env, cwd: process.cwd(), stdio: ['ignore', 'inherit', 'inherit'] });`,
        `process.exit(r.exitCode ?? 1);`,
      ].join('\n'),
    });
    const r = await runCli([process.execPath, entry, '--preflight'], dir, hermeticEnv(dir));
    expect(r.exitCode).toBe(5);
    expect(existsSync(evilMarker)).toBe(false);
    expect(warningLines(r.stderr)).toHaveLength(2); // one per subtree that started in the hostile cwd; no runaway
  });

  test.skipIf(!GIT_BIN)('SIGTERM sent to the wrapper is forwarded: the re-run exits 99 by its own handler, the wrapper relays 99, the re-run is gone', async () => {
    const { dir, entry, ready } = hostileGitRepo({
      entryBody: [
        `process.on('SIGTERM', () => process.exit(99));`,
        `writeReady(process.pid);`,
        `setInterval(() => {}, 1000);`,
      ].join('\n'),
    });
    const proc = Bun.spawn([process.execPath, entry, '--preflight'], { cwd: dir, env: hermeticEnv(dir), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* exited */ } }, CHILD_KILL_AFTER_MS);
    try {
      const childPid = await waitReady(ready);
      expect(childPid).not.toBe(proc.pid); // the entry ran in the re-run, not in the wrapper
      proc.kill('SIGTERM');
      const code = await proc.exited;
      expect(code).toBe(99);
      expect(await gone(childPid)).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  test.skipIf(!GIT_BIN)('the re-run killed by SIGKILL → the wrapper exits 137 (128+signal)', async () => {
    const { dir, entry } = hostileGitRepo({ entryBody: `process.kill(process.pid, 'SIGKILL');\nsetInterval(() => {}, 1000);` });
    const r = await runCli([process.execPath, entry, '--preflight'], dir, hermeticEnv(dir));
    expect(r.exitCode).toBe(137);
  });

  // A3-5(b): with a real terminal attached the wrapper's stdin IS a tty, so it
  // takes the ignore-only SIGINT branch. `script` runs the wrapper under a pty;
  // writing \x03 to script's stdin is the terminal Ctrl-C, delivered by the pty
  // to the whole foreground process group (wrapper + re-run) exactly like a real
  // terminal. The tty wrapper does NOT forward, so the re-run receives SIGINT
  // exactly once and its once() graceful handler completes (exit 42) — a second,
  // forwarded delivery would have killed it after once() removed its listener.
  test.skipIf(!GIT_BIN || !SCRIPT_BIN)('Ctrl-C from a real terminal (pty) reaches the re-run exactly once: the tty wrapper ignores SIGINT and the once() graceful handler completes (exit 42)', async () => {
    const { dir, entry, ready } = hostileGitRepo({
      entryBody: [
        // serve-http's shape: once('SIGINT') + a graceful-shutdown delay before exit.
        `process.once('SIGINT', () => { setTimeout(() => process.exit(42), 300); });`,
        `writeReady(process.pid);`,
        `setInterval(() => {}, 1000);`,
      ].join('\n'),
    });
    const cmd = `${process.execPath} ${entry} --preflight`;
    const proc = Bun.spawn([SCRIPT_BIN!, '-qec', cmd, '/dev/null'], {
      cwd: dir, env: hermeticEnv(dir), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    const drain = (async () => { for await (const _ of proc.stdout) { /* mux pty output */ } })();
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* exited */ } }, CHILD_KILL_AFTER_MS);
    try {
      await waitReady(ready);
      proc.stdin!.write('\x03'); // terminal Ctrl-C → pty → the foreground group
      proc.stdin!.flush();
      const code = await proc.exited;
      await drain;
      expect(proc.signalCode).toBeNull();
      expect(code).toBe(42);
    } finally {
      clearTimeout(timer);
    }
  });

  // A3-5(b): the mirror case. With NO tty there is no process-group delivery, so
  // a SIGINT that reaches the wrapper pid alone (a supervisor, cron, an agent
  // harness) would orphan the re-run under ignore-only. The non-tty wrapper
  // forwards it once; the re-run's handler runs (exit 97).
  test.skipIf(!GIT_BIN)('SIGINT to a non-tty wrapper is forwarded once: the re-run receives it and exits 97', async () => {
    const { dir, entry, ready } = hostileGitRepo({
      entryBody: [
        `process.on('SIGINT', () => process.exit(97));`,
        `writeReady(process.pid);`,
        `setInterval(() => {}, 1000);`,
      ].join('\n'),
    });
    const proc = Bun.spawn([process.execPath, entry, '--preflight'], { cwd: dir, env: hermeticEnv(dir), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* exited */ } }, CHILD_KILL_AFTER_MS);
    try {
      const childPid = await waitReady(ready);
      expect(childPid).not.toBe(proc.pid); // the handler ran in the re-run
      proc.kill('SIGINT'); // wrapper pid only — no tty ⇒ no group delivery
      const code = await proc.exited;
      expect(code).toBe(97);
      expect(await gone(childPid)).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  // A3-6(iii): SIGHUP is always forwarded (a supervisor sends it to the wrapper
  // pid alone). The re-run exits 98 by its own handler; the wrapper relays it.
  test.skipIf(!GIT_BIN)('SIGHUP sent to the wrapper is forwarded: the re-run exits 98 by its own handler, the wrapper relays it', async () => {
    const { dir, entry, ready } = hostileGitRepo({
      entryBody: [
        `process.on('SIGHUP', () => process.exit(98));`,
        `writeReady(process.pid);`,
        `setInterval(() => {}, 1000);`,
      ].join('\n'),
    });
    const proc = Bun.spawn([process.execPath, entry, '--preflight'], { cwd: dir, env: hermeticEnv(dir), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* exited */ } }, CHILD_KILL_AFTER_MS);
    try {
      const childPid = await waitReady(ready);
      proc.kill('SIGHUP');
      const code = await proc.exited;
      expect(code).toBe(98);
      expect(await gone(childPid)).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  // A3-6(i): a dev-runtime re-run (`bun src/cli.ts`) must re-insert the runtime
  // flags from process.execArgv, or `--smol`/`--inspect`/`--preload` would be
  // dropped on the hop. Only the re-run reaches entryBody (the wrapper re-execs
  // and exits), so the printed execArgv is the re-run's.
  test.skipIf(!GIT_BIN)('the re-run preserves the dev-runtime execArgv (--smol) across the hop', async () => {
    const { dir, entry } = hostileGitRepo({
      entryBody: `process.stdout.write('EXECARGV=' + JSON.stringify(process.execArgv) + '\\n');\nprocess.exit(7);`,
    });
    const r = await runCli([process.execPath, '--smol', entry, '--preflight'], dir, hermeticEnv(dir));
    expect(r.exitCode).toBe(7);
    expect(r.stdout).toContain('EXECARGV=["--smol"]');
  });

  // A3-4 (red team): a relative `TMPDIR=t` in the .env would make mkdtemp return
  // a relative neutral path, breaking the re-run's realpath marker check. TMPDIR
  // is now protected, so the parent drops it BEFORE makeNeutralDir consults
  // os.tmpdir(); realpathSync then guarantees `neutral` is absolute + canonical.
  // The hop still completes: cwd restored to the caller, marker not leaked.
  test.skipIf(!GIT_BIN)('a relative TMPDIR planted by the .env is quarantined before the neutral dir is made; the hop completes and cwd is restored', async () => {
    const { dir, entry } = hostileGitRepo({
      envLines: () => ['TMPDIR=t', 'PROJECT_NAME=demo'],
      entryBody: `process.stdout.write('CWD=' + process.cwd() + ' MARKER=' + JSON.stringify(process.env.GBRAIN_CWD_ENV_QUARANTINED ?? null) + '\\n');\nprocess.exit(7);`,
    });
    const r = await runCli([process.execPath, entry, '--preflight'], dir, hermeticEnv(dir));
    expect(r.exitCode).toBe(7);
    expect(r.stdout).toContain(`CWD=${realpathSync(dir)}`); // switched back to the caller
    expect(r.stdout).toContain('MARKER=null');              // internal marker not visible
    const warnings = warningLines(r.stderr);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Ignoring TMPDIR because a .env file in the current directory assigns it');
  });

  // A2-3 (red team): git reads $XDG_CONFIG_HOME/git/config as GLOBAL config,
  // so a non-GIT_ variable carries the same core.fsmonitor RCE.
  const xdgLines = (d: string) => [`XDG_CONFIG_HOME=${d}/.xdg`, 'PROJECT_NAME=demo'];
  function plantXdgFsmonitor(dir: string): void {
    mkdirSync(join(dir, '.xdg', 'git'), { recursive: true });
    writeFileSync(join(dir, '.xdg', 'git', 'config'), '[core]\n\tfsmonitor = ./tooling/evil.sh\n');
  }

  test.skipIf(!GIT_BIN)('control: XDG_CONFIG_HOME planted by the .env makes git run the script (no preflight)', async () => {
    const { dir, evilMarker, entry } = hostileGitRepo({ envLines: xdgLines });
    plantXdgFsmonitor(dir);
    const r = await runCli([process.execPath, entry], dir, hermeticEnv(dir));
    expect(r.exitCode).toBe(7);
    expect(existsSync(evilMarker)).toBe(true);
  });

  test.skipIf(!GIT_BIN)('with preflight: XDG_CONFIG_HOME is quarantined and git from the original cwd does NOT run the planted fsmonitor', async () => {
    const { dir, evilMarker, entry } = hostileGitRepo({ envLines: xdgLines });
    plantXdgFsmonitor(dir);
    const r = await runCli([process.execPath, entry, '--preflight'], dir, hermeticEnv(dir));
    expect(existsSync(evilMarker)).toBe(false);
    expect(r.exitCode).toBe(7);
    expect(r.stdout).toContain('GIT_EXIT=0');
    expect(r.stdout).toContain(`CWD=${realpathSync(dir)}`);
    expect(r.stdout).toContain('PROJECT_NAME=demo');
    const warnings = warningLines(r.stderr);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Ignoring XDG_CONFIG_HOME because a .env file in the current directory assigns it');
  });

  const compiledTest = existsSync(COMPILED_BIN) ? test : test.skip;
  compiledTest.skipIf(!GIT_BIN)('compiled binary from the hostile git checkout: one warning, exit 0, a single stdout line, no script run', async () => {
    // `--version` itself spawns nothing, so the marker check guards the harness;
    // the re-run's argv shape (compiled: user args only, no /$bunfs entry) is
    // what the single clean stdout line + exit 0 prove.
    const { dir, evilMarker } = hostileGitRepo();
    const r = await runCli([COMPILED_BIN, '--version'], dir, hermeticEnv(dir));
    expect(existsSync(evilMarker)).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    expect(r.stdout).toMatch(/^gbrain \d/);
    const warnings = warningLines(r.stderr);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`Ignoring ${HOSTILE_WARNING_KEYS} because`);
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
    // Both keys are quarantined (one warning names them) and, because the
    // dropped set includes GBRAIN_GUARDRAILS_MODULE, preflight then fails closed.
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('[env] Ignoring GBRAIN_GUARDRAILS_MODULE, GBRAIN_HOME because a .env file in the current directory assigns it');
    expect(r.stderr).toContain("refusing to run without the operator's firewall");
    expect(r.stdout).not.toMatch(/^gbrain \d/);
  });
});


// ── A3-1: a cwd bunfig.toml cannot preload code into the COMPILED binary ─────
//
// A standalone Bun executable auto-loads a `bunfig.toml` from the process cwd
// and runs its `preload` scripts BEFORE any of the binary's own code — before
// cli-preflight, before the cwd-.env quarantine. gbrain is a global CLI that
// runs from arbitrary checkouts, so a hostile repo carrying bunfig.toml +
// `preload` would get RCE from a plain `gbrain --version`. The binary is now
// built with `--no-compile-autoload-bunfig`, which makes a cwd bunfig.toml
// inert (guarded at build time by scripts/check-compile-autoload.sh). The dev
// runtime `bun src/cli.ts` stays bun-native — a contributor's cwd is trusted —
// so this behavior is only assertable against a compiled binary.
describe('a cwd bunfig.toml cannot preload code into the compiled binary', () => {
  /** A hostile checkout: bunfig.toml whose preload script drops a marker. */
  function hostileBunfig(): { dir: string; marker: string } {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-hostile-bunfig-'));
    scratch.push(dir);
    const marker = join(dir, 'PRELOAD_RAN');
    mkdirSync(join(dir, 'tooling'));
    writeFileSync(
      join(dir, 'tooling', 'pre.ts'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\n`,
    );
    writeFileSync(join(dir, 'bunfig.toml'), 'preload = ["./tooling/pre.ts"]\n');
    return { dir, marker };
  }

  const compiledTest = existsSync(COMPILED_BIN) ? test : test.skip;
  compiledTest('the preload script does NOT run under the compiled binary', async () => {
    const { dir, marker } = hostileBunfig();
    const r = await runCli([COMPILED_BIN, '--version'], dir, hermeticEnv(dir));
    expect(existsSync(marker)).toBe(false); // --no-compile-autoload-bunfig made it inert
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^gbrain \d/);
  });
});

// ── A3-6(ii): the sanitized re-run chdirs back to the caller ─────────────────
//
// On a verified hop the re-run switches back to the caller's directory before
// anything else runs. If that directory has vanished, it aborts with a clear
// message rather than continuing from the neutral temp dir. Both branches are
// driven by planting a VALID hop marker (startup cwd IS the .env-free neutral
// dir it names) so verifiedHop honours it.
describe('sanitized re-run: chdir back to the caller', () => {
  function preflightOnlyEntry(): string {
    const d = mkdtempSync(join(tmpdir(), 'gbrain-preflight-entry-'));
    scratch.push(d);
    const p = join(d, 'entry.ts');
    writeFileSync(p, [
      `import { realpathSync } from 'node:fs';`,
      `import { runCliPreflight } from ${JSON.stringify(PREFLIGHT_MODULE)};`,
      `await runCliPreflight();`,
      `process.stdout.write('CWD=' + realpathSync(process.cwd()) + '\\n');`,
      `process.exit(3);`,
      '',
    ].join('\n'));
    return p;
  }

  test('a re-run whose original cwd vanished aborts with a clear error (exit 1)', async () => {
    const entry = preflightOnlyEntry();
    const gone = mkdtempSync(join(tmpdir(), 'gbrain-vanished-cwd-'));
    const neutral = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-neutral-'))); scratch.push(neutral);
    rmSync(gone, { recursive: true, force: true }); // the caller's dir no longer exists
    const env = { ...hermeticEnv(neutral), GBRAIN_CWD_ENV_QUARANTINED: JSON.stringify({ cwd: gone, neutral }) };
    const r = await runCli([process.execPath, entry, '--preflight'], neutral, env);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(`[env] cannot return to ${gone}`);
  });

  test('a re-run with a live original cwd chdirs back and proceeds (exit 3)', async () => {
    const entry = preflightOnlyEntry();
    const live = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-live-cwd-'))); scratch.push(live);
    const neutral = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-neutral-'))); scratch.push(neutral);
    const env = { ...hermeticEnv(neutral), GBRAIN_CWD_ENV_QUARANTINED: JSON.stringify({ cwd: live, neutral }) };
    const r = await runCli([process.execPath, entry, '--preflight'], neutral, env);
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toContain(`CWD=${live}`);
    expect(r.stderr).not.toContain('cannot return');
  });
});
