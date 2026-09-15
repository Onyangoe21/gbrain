/**
 * CLI startup preflight — the FIRST statement of `cli.ts:main()`, before
 * global-flag parsing and any command dispatch. Ordered steps:
 *
 *   1. `quarantineCwdDotenv()` — drop every protected key (env-trust.ts: the
 *      security-relevant GBRAIN_* keys plus the loader / git / node / proxy /
 *      AI-CLI hijack families) that a `.env` in the cwd assigns. GBRAIN_HOME
 *      is on that list, so it is quarantined BEFORE step 2 resolves the
 *      config dir.
 *   1b. Re-exec gbrain with the sanitized environment when anything was
 *      dropped (see "Why the re-exec" below).
 *   2. `loadGbrainEnvFile(configDir)` — fill process.env from `~/.gbrain/.env`
 *      (never overriding an exported variable). `loadConfig()` does this too,
 *      but the guardrails loader in step 3 runs before any `loadConfig()`;
 *      without this step `~/.gbrain/.env` could not be the operator's home
 *      for GBRAIN_GUARDRAILS_MODULE.
 *   3. The #3688 guardrails loader (moved verbatim from cli.ts). Fail-closed:
 *      set-but-broken aborts rather than silently running without the
 *      operator's firewall; unset costs nothing.
 *
 * Every runtime entry — commands, `hook *`, `serve` (stdio and --http),
 * `mcp`, the supervisor-spawned `jobs work`, the per-job `jobs run-child` —
 * dispatches through `main()`, so this one call covers every gbrain process.
 * (`src/commands/auth.ts`'s `import.meta.main` seam is a dev-only
 * direct-script entry.)
 *
 * ## Why the re-exec (step 1b)
 *
 * `delete process.env.X` changes only THIS process's view. Bun hands every
 * child spawned without an explicit `env` option the environ snapshot it took
 * at startup — cwd-.env values included — so git, the claude CLI and workers
 * would still see the planted keys (verified on Bun 1.3.13: a `.env` carrying
 * `GIT_CONFIG_COUNT=1 / GIT_CONFIG_KEY_0=core.fsmonitor / GIT_CONFIG_VALUE_0=
 * ./x.sh` runs x.sh from a plain `git status`). When the quarantine dropped
 * anything, preflight therefore spawns gbrain again with an explicit,
 * sanitized environment, forwards SIGINT/SIGTERM/SIGHUP, and exits with the
 * child's status; every descendant of the child inherits the clean view.
 * Two details make the hop terminate:
 *
 *   - A Bun child launched from the same cwd loads the very same .env files
 *     again for any key ABSENT from its environ, but a key that is PRESENT —
 *     even empty — wins over the file (`BUN_OPTIONS=--no-env-file` is ignored
 *     by compiled binaries, so that is not an option). The re-exec therefore
 *     carries each dropped key as an EMPTY STRING: neutral for every listed
 *     family (`GIT_CONFIG_COUNT=` is count zero, `LD_PRELOAD=` preloads
 *     nothing, an empty proxy / URL / module path reads as unset), and it
 *     stops Bun re-reading the file. The child's own quarantine then deletes
 *     those empty keys from ITS process.env — in-process reads see
 *     `undefined`, exactly as before — silently.
 *   - `GBRAIN_CWD_ENV_QUARANTINED=<pid of the re-exec parent>`: a process
 *     whose PARENT pid matches never re-execs or warns again (loop guard; one
 *     warning per invocation). A gbrain descendant spawned later by that
 *     child (supervisor → worker, hook → detached push, worker → run-child)
 *     has a different ppid and — when its spawn site passed `env:
 *     process.env`, where the keys are deleted — reloaded values, so it
 *     performs the sanitizing hop for its own subtree. A process whose
 *     dropped keys were ALL already empty has nothing live to sanitize and
 *     does not re-exec.
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
import { realpathSync } from 'fs';
import { constants as osConstants } from 'os';
import { cwdDotenvAssignsKey, quarantineCwdDotenv } from './env-trust.ts';
import { loadGbrainEnvFile } from './gbrain-env-file.ts';
import { configDir } from './config.ts';

/** Set on the re-exec'd child to the re-exec parent's pid (see module doc). */
export const CWD_ENV_QUARANTINED_MARKER = 'GBRAIN_CWD_ENV_QUARANTINED';

function cwdIsOperatorConfigDir(cwd: string): boolean {
  if (cwdDotenvAssignsKey('GBRAIN_HOME', cwd)) return false;
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
 * `bun src/cli.ts` needs the entry file re-inserted (cli.ts computes rawArgs as
 * `process.argv.slice(2)` in both modes). null when there is no re-runnable
 * entry (`bun -e`).
 */
function selfArgv(): string[] | null {
  const entry = process.argv[1];
  const userArgs = process.argv.slice(2);
  const bunfsEntry = entry !== undefined && (/^\/\$bunfs\//.test(entry) || /[\\/]~BUN[\\/]/.test(entry));
  const devRuntime = /[/\\](bun|node)(\.exe)?$/.test(process.execPath);
  if (bunfsEntry || !devRuntime) return userArgs;
  if (!entry || entry.startsWith('-')) return null;
  return [entry, ...userArgs];
}

async function reexecSanitized(dropped: readonly string[]): Promise<void> {
  const argv = selfArgv();
  if (!argv) return; // in-process view is clean; nothing re-runnable for the descendants' sake
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  for (const k of dropped) env[k] = ''; // present-but-empty: Bun will not re-read the .env for it
  env[CWD_ENV_QUARANTINED_MARKER] = String(process.pid);
  const child = Bun.spawn([process.execPath, ...argv], {
    cwd: process.cwd(),
    env,
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  const forward = (sig: NodeJS.Signals) => () => {
    try { child.kill(sig); } catch { /* already exited */ }
  };
  const handlers: Array<[NodeJS.Signals, () => void]> = [
    ['SIGINT', forward('SIGINT')], ['SIGTERM', forward('SIGTERM')], ['SIGHUP', forward('SIGHUP')],
  ];
  for (const [sig, h] of handlers) process.on(sig, h);
  const code = await child.exited;
  for (const [sig, h] of handlers) process.off(sig, h);
  if (child.signalCode) {
    const signals = osConstants.signals as Record<string, number | undefined>;
    process.exit(128 + (signals[child.signalCode] ?? 1)); // shell convention for a signal death
  }
  process.exit(code);
}

export async function runCliPreflight(): Promise<void> {
  const cwd = process.cwd();
  const collision = cwdIsOperatorConfigDir(cwd);
  if (!collision) {
    const hoppedByParent = process.env[CWD_ENV_QUARANTINED_MARKER] === String(process.ppid);
    const before: Record<string, string | undefined> = { ...process.env };
    let warning: string | null = null;
    const dropped = quarantineCwdDotenv(process.env, cwd, { warn: (line) => { warning = line; } });
    // Keys that still carried a value: the re-exec'd child sees '' for all of
    // them (nothing live), so it stays silent and never hops again.
    const live = dropped.filter((k) => before[k] !== '');
    if (warning !== null && (!hoppedByParent || live.length > 0)) console.error(warning);
    if (live.length > 0 && !hoppedByParent) await reexecSanitized(dropped);
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
