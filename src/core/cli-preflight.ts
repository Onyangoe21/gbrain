/**
 * CLI startup preflight — the FIRST statement of `cli.ts:main()`, before
 * global-flag parsing and any command dispatch. Ordered steps:
 *
 *   0. Sanitized re-run detection. When this process IS the re-run described
 *      in step 1b (verified, never trusted on the marker's say-so — see
 *      "Loop guard"), switch back to the caller's directory and skip step 1:
 *      the parent already quarantined and warned.
 *   1. `quarantineCwdDotenv()` — drop every protected key (env-trust.ts: the
 *      security-relevant GBRAIN_* keys plus the loader / git / node / XDG /
 *      TLS-trust / proxy / AI-endpoint hijack families) that a `.env` in the
 *      cwd assigns. GBRAIN_HOME is on that list, so it is quarantined BEFORE
 *      step 2 resolves the config dir. The 8 cwd .env files are parsed ONCE
 *      here and the parse is shared with the cwd == config dir check.
 *   1b. Re-run gbrain with the sanitized environment whenever anything was
 *      dropped (see "Why the re-run" below).
 *   2. `loadGbrainEnvFile(configDir)` — fill process.env from `~/.gbrain/.env`
 *      (never overriding an exported variable). `loadConfig()` does this too,
 *      but the guardrails loader in step 3 runs before any `loadConfig()`;
 *      without this step `~/.gbrain/.env` could not be the operator's home
 *      for GBRAIN_GUARDRAILS_MODULE.
 *   3. The #3688 guardrails loader (moved from cli.ts; now passes
 *      `skipCwdCheck`). Fail-closed: set-but-broken aborts rather than
 *      silently running without the operator's firewall; unset costs nothing.
 *
 * Every runtime entry — commands, `hook *`, `serve` (stdio and --http),
 * `mcp`, the supervisor-spawned `jobs work`, the per-job `jobs run-child` —
 * dispatches through `main()`, so this one call covers every gbrain process.
 * (`src/commands/auth.ts`'s `import.meta.main` seam is a dev-only
 * direct-script entry.)
 *
 * ## Why the re-run (step 1b)
 *
 * Deleting a key from process.env changes only THIS process's view. Bun hands
 * every child spawned without an explicit `env` option the environ snapshot
 * it took at startup — cwd-.env values included — so git, the claude CLI and
 * workers would still see the planted keys (verified on Bun 1.3.13: a `.env`
 * carrying `GIT_CONFIG_COUNT=1 / GIT_CONFIG_KEY_0=core.fsmonitor /
 * GIT_CONFIG_VALUE_0=./x.sh` runs x.sh from a plain `git status`). When the
 * quarantine dropped anything, preflight therefore spawns gbrain again with
 * an explicit, sanitized environment and exits with the re-run's status;
 * every descendant of the re-run inherits the clean view.
 *
 * The re-run starts in a NEUTRAL cwd: a fresh, empty `mkdtemp` directory that
 * is ours and by construction holds none of the `.env` family. Bun loads
 * `.env` from the process cwd only (no parent walk — verified on 1.3.13), so
 * the re-run's Bun never sees the hostile file and its environ simply LACKS
 * the dropped keys. They are deleted, never carried as empty strings: git and
 * the dynamic loader PRESENCE-check some of them (`GIT_SSL_NO_VERIFY=`
 * disables TLS verification, `LD_TRACE_LOADED_OBJECTS=` turns every
 * dynamically linked child into ldd, `GIT_DIR=` / `GIT_AUTHOR_NAME=` are hard
 * errors), so `''` would not have been neutral. Preflight in the re-run then
 * `chdir`s back to the caller's directory before anything else runs, so
 * relative arguments resolve exactly as typed. Nothing in cli.ts's import
 * graph captures `process.cwd()` at module-evaluation time (audited); every
 * read happens after this chdir.
 *
 * ## Loop guard
 *
 * The re-run carries `GBRAIN_CWD_ENV_QUARANTINED=<JSON {cwd, neutral}>`. The
 * marker is NOT trusted by itself — a hostile .env could plant one (the key is
 * also on the protected list, so a planted copy is dropped and named in the
 * warning). It is honoured only when ALL of: it parses to two strings, this
 * process's startup cwd IS `neutral` (realpath-compared), and `neutral`
 * contains none of the `.env` family. A process started from a hostile
 * directory fails the second check (its startup cwd has a `.env`) and the
 * third if it names its own directory — so it ignores the marker entirely
 * and never chdirs on one. Termination is structural: the re-run's startup
 * cwd has no `.env`, so it never drops anything and never re-runs. gbrain
 * self-spawns (supervisor → worker, hook → detached push, worker →
 * run-child) that start in the hostile cwd reload the file and perform the
 * hop once for their own subtree — accepted; one warning per subtree.
 *
 * ## Signals
 *
 * The re-run shares the wrapper's foreground process group, so the terminal
 * delivers Ctrl-C to it directly; the wrapper does NOT forward SIGINT (a
 * second delivery would consume a `once('SIGINT')` graceful-shutdown handler
 * such as serve-http's and turn Ctrl-C into an abrupt kill). The wrapper
 * ignores SIGINT itself so it survives to relay the re-run's exit status.
 * SIGTERM and SIGHUP — which a supervisor sends to the wrapper pid alone —
 * ARE forwarded. Exit status: the re-run's code, or 128+signal when a signal
 * killed it (shell convention).
 *
 * Zero cost on the normal path: no .env in the cwd, or nothing protected
 * assigned there, means no spawn.
 *
 * ## cwd == config dir
 *
 * Running gbrain from INSIDE `~/.gbrain` (or `$GBRAIN_HOME/.gbrain`) makes Bun
 * load the operator's own `.env` as a "cwd .env". That file is operator-owned,
 * so the quarantine and the guardrails loader's cwd check are skipped when
 * `realpath(cwd) === realpath(configDir())` — but ONLY when no cwd .env file
 * assigns GBRAIN_HOME (a hostile checkout could otherwise point GBRAIN_HOME at
 * itself to manufacture the collision).
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { constants as osConstants, homedir, tmpdir } from 'os';
import { join } from 'path';
import {
  CWD_DOTENV_FILES,
  cwdDotenvAssignsKey,
  parseCwdDotenv,
  quarantineCwdDotenv,
  type DotenvAssignment,
} from './env-trust.ts';
import { loadGbrainEnvFile } from './gbrain-env-file.ts';
import { configDir } from './config.ts';

/**
 * Set on the sanitized re-run to `JSON {cwd, neutral}` (see "Loop guard").
 * Internal — not a setting; verified against the startup cwd, never trusted.
 */
export const CWD_ENV_QUARANTINED_MARKER = 'GBRAIN_CWD_ENV_QUARANTINED';

interface HopMarker {
  /** The caller's directory the re-run must switch back to. */
  cwd: string;
  /** The fresh empty directory the re-run was started in. */
  neutral: string;
}

function parseHopMarker(raw: string | undefined): HopMarker | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (
      v !== null && typeof v === 'object' &&
      typeof (v as HopMarker).cwd === 'string' && (v as HopMarker).cwd !== '' &&
      typeof (v as HopMarker).neutral === 'string' && (v as HopMarker).neutral !== ''
    ) {
      return { cwd: (v as HopMarker).cwd, neutral: (v as HopMarker).neutral };
    }
  } catch {
    // not JSON — a planted or foreign value; ignored
  }
  return null;
}

/**
 * The marker, but ONLY when this process provably is the re-run: it started
 * inside the neutral dir the marker names, and that dir holds no .env family
 * member. Anything else (absent, malformed, planted from a hostile cwd) → null.
 */
function verifiedHop(startupCwd: string): HopMarker | null {
  const marker = parseHopMarker(process.env[CWD_ENV_QUARANTINED_MARKER]);
  if (!marker) return null;
  try {
    if (realpathSync(startupCwd) !== realpathSync(marker.neutral)) return null;
  } catch {
    return null;
  }
  for (const name of CWD_DOTENV_FILES) {
    if (existsSync(join(marker.neutral, name))) return null;
  }
  return marker;
}

function cwdIsOperatorConfigDir(cwd: string, assignments: readonly DotenvAssignment[]): boolean {
  if (cwdDotenvAssignsKey('GBRAIN_HOME', assignments)) return false;
  try {
    return realpathSync(cwd) === realpathSync(configDir());
  } catch {
    return false; // invalid GBRAIN_HOME or a config dir that does not exist yet — no collision
  }
}

/**
 * argv (after execPath) that runs THIS gbrain again. A compiled Bun binary
 * reports its virtual entrypoint as argv[1] (`/$bunfs/root/...`; `~BUN` on
 * Windows) and execPath IS gbrain, so the user args are the whole argv;
 * `bun src/cli.ts` needs the runtime flags (`--inspect`, `--preload`, … from
 * process.execArgv) and the entry file re-inserted — Bun reports the entry as
 * an absolute path, so it survives the neutral-cwd start (cli.ts computes
 * rawArgs as `process.argv.slice(2)` in both modes). null when there is no
 * re-runnable entry (`bun -e`).
 */
function selfArgv(): string[] | null {
  const entry = process.argv[1];
  const userArgs = process.argv.slice(2);
  const bunfsEntry = entry !== undefined && (/^\/\$bunfs\//.test(entry) || /[\\/]~BUN[\\/]/.test(entry));
  const devRuntime = /[/\\](bun|node)(\.exe)?$/.test(process.execPath);
  if (bunfsEntry || !devRuntime) return userArgs;
  if (!entry || entry.startsWith('-')) return null;
  return [...process.execArgv, entry, ...userArgs];
}

/**
 * A fresh, empty directory that is ours. `tmpdir()` first; the home dir when
 * TMPDIR (unprotected, so a cwd .env may point it anywhere) is unusable. A
 * mkdtemp dir is new by definition, so neither can hold a .env.
 */
function makeNeutralDir(): string {
  try {
    return mkdtempSync(join(tmpdir(), 'gbrain-hop-'));
  } catch {
    return mkdtempSync(join(homedir(), '.gbrain-hop-'));
  }
}

async function reexecSanitized(originalCwd: string): Promise<void> {
  const argv = selfArgv();
  if (!argv) return; // in-process view is clean; nothing re-runnable for the descendants' sake
  const neutral = makeNeutralDir();
  // The quarantine already deleted the dropped keys from process.env; they are
  // NOT added back (not even empty — see "Why the re-run").
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env[CWD_ENV_QUARANTINED_MARKER] = JSON.stringify({ cwd: originalCwd, neutral } satisfies HopMarker);
  let code: number;
  let signalCode: string | null;
  try {
    const child = Bun.spawn([process.execPath, ...argv], {
      cwd: neutral,
      env,
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    // See "Signals": the tty delivers Ctrl-C to the child itself; the wrapper
    // only has to outlive it to relay the exit status.
    process.on('SIGINT', () => {});
    const forward = (sig: NodeJS.Signals) => () => {
      try { child.kill(sig); } catch { /* already exited */ }
    };
    process.on('SIGTERM', forward('SIGTERM'));
    process.on('SIGHUP', forward('SIGHUP'));
    code = await child.exited;
    signalCode = child.signalCode;
  } finally {
    rmSync(neutral, { recursive: true, force: true });
  }
  if (signalCode) {
    const signals = osConstants.signals as Record<string, number | undefined>;
    process.exit(128 + (signals[signalCode] ?? 1)); // shell convention for a signal death
  }
  process.exit(code);
}

export async function runCliPreflight(): Promise<void> {
  const hop = verifiedHop(process.cwd());
  if (hop) {
    delete process.env[CWD_ENV_QUARANTINED_MARKER]; // never inherited further: a later self-spawn decides for itself
    try {
      process.chdir(hop.cwd);
    } catch (err) {
      console.error(`[env] cannot return to ${hop.cwd} after the sanitized re-run: ${(err as Error)?.message ?? String(err)}`);
      process.exit(1);
    }
  }
  const cwd = process.cwd();
  const assignments = parseCwdDotenv(cwd);
  const collision = cwdIsOperatorConfigDir(cwd, assignments);
  if (!hop && !collision) {
    const dropped = quarantineCwdDotenv(process.env, cwd, { assignments });
    if (dropped.length > 0) await reexecSanitized(cwd);
  }
  loadGbrainEnvFile(configDir);
  if (process.env.GBRAIN_GUARDRAILS_MODULE) {
    try {
      const { loadGuardrailProvidersFromEnv } = await import('./guardrails.ts');
      await loadGuardrailProvidersFromEnv(process.env, { skipCwdCheck: collision });
    } catch (err) {
      console.error(`guardrails: ${(err as Error)?.message ?? String(err)}`);
      process.exit(1);
    }
  }
}
