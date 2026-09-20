/**
 * `gbrain mcp expose` — publish `gbrain serve --http` on the user's Tailscale
 * tailnet (or, with `--funnel`, on the public internet through Tailscale
 * Funnel) and keep it running as a user service.
 *
 * Engine-free: never opens the database. Local CLI only (a `mcp`
 * subcommand). Every step is a named check in `--json`; prose goes to stderr
 * when `--json` is set so stdout carries exactly one document.
 *
 * Exit codes: 0 done · 1 failed · 2 needs confirmation (`--yes`) or a step is
 * pending (Tailscale login not completed, tailnet health still pending).
 *
 * Every side effect (exec, fetch, prompt, clock, paths) is injectable through
 * `McpExposeDeps` so the command is testable against a fake runner in a
 * tmpdir. Never mutate process.env here — read it through `deps.env`.
 */
import { existsSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { promptLineStderr } from '../core/cli-util.ts';
import { gbrainPath, isThinClient, loadConfig, type GBrainConfig } from '../core/config.ts';
import { detectExecutionEnvironment, type ExecutionEnvironment } from '../core/execution-env.ts';
import { validateHarnessArguments } from '../core/harness/arguments.ts';
import {
  classifyTailscaleError, defaultCommandRunner, findProxiedHandler, findRootHandlers, findTailscaleBinary,
  parseServeStatus, parseTailscaleStatus, publicUrlFromDnsName, tailscaleDaemonStartHint, tailscaleInstallPlan,
  tailscaleLoginArgv, tailscaleServeArgv, tailscaleServeOffArgv, tailscaleSetOperatorCommand, TAILSCALE_ADMIN_ACL_URL,
  TAILSCALE_ADMIN_DNS_URL, TAILSCALE_FUNNEL_KB_URL, TAILSCALE_SERVE_STATUS_ARGV, TAILSCALE_STATUS_ARGV,
  type CommandRunner, type ServeHandler, type ServeStatusView, type TailscaleStatus,
} from '../core/tailscale.ts';
import {
  adminTokenPath as adminTokenPathFor, detectServiceTarget, ensureAdminToken, installServeService, launchdPlistPath,
  readExposeReceipt, receiptPath as receiptPathFor, renderServeWrapper, resolveServeGbrainCommand, serveCommandArgv,
  serveDir as defaultServeDir, serveErrPath, serveLogPath, serveServiceState, systemdUnitPath, SYSTEMCTL_USER_BUS_PROBE_ARGV,
  SERVE_LAUNCHD_LABEL, SERVE_SYSTEMD_UNIT, uninstallServeService, wrapperPath as wrapperPathFor, writeExposeReceipt,
  type ExposeReceipt, type ServiceState, type ServiceTarget,
} from '../core/serve-service.ts';
import { shellQuote } from '../core/mcp-registration.ts';

export const MCP_EXPOSE_HELP = `gbrain mcp expose — publish the MCP server on your Tailscale tailnet and keep it running

gbrain mcp expose [--port N] [--funnel] [--surface verbs|starter|full] [--enable-dcr]
                  [--no-tailscale] [--no-service] [--no-install] [--force]
                  [--dry-run] [--yes] [--json]
gbrain mcp expose --status [--json]
gbrain mcp expose --remove [--yes] [--json]

Steps (each a named check in --json): plan, consent, tailscale.binary, tailscale.login,
tailscale.identity, tailscale.publish, admin_token, service, verify.local, verify.tailnet, receipt.
Nothing is published until Tailscale reports HTTPS certificates (and, with --funnel, the Funnel
node attribute) enabled — otherwise exit 2 with the admin URL to fix it.

--port N          Local port for the gbrain HTTP server (default: 3131)
--funnel          Publish on the public internet via Tailscale Funnel (cloud agents:
                  Grok Bot, Muse, ChatGPT). Default is tailnet-only — your own devices.
--surface X       MCP tool surface: verbs | starter | full (default: full)
--enable-dcr      Allow OAuth Dynamic Client Registration on the server
--no-tailscale    Skip every Tailscale step (you publish the port yourself)
--no-service      Publish only; do not install or start the user service
--no-install      Never install Tailscale; exit 1 with the install plan when it is missing
--force           Take over a foreign tailscale serve handler on :443; with --remove also
                  delete the admin token file
--dry-run         Print the plan and stop (exit 0, no changes)
--yes             Skip the confirmation prompt (required when not on a TTY)
--status          Re-probe the published server, the service and both health URLs
--remove          Stop the service, clear our serve/funnel handler, delete wrapper + receipt
--json            One JSON document on stdout; prose moves to stderr

Exit codes: 0 done · 1 failed · 2 confirmation needed or a step is pending (re-run).
Env: GBRAIN_TAILSCALE_LOGIN_TIMEOUT_MS bounds the wait for \`tailscale up\` (default 300000).

Next: gbrain mcp grant NAME --harness ID --profile memory-writer --source default --url URL/mcp \\
        --admin-token-file ~/.gbrain/serve/admin-token --credentials-out /private/NAME.json
`;

export const MCP_EXPOSE_ARGUMENTS = {
  values: ['--port', '--surface'],
  flags: ['--funnel', '--enable-dcr', '--no-tailscale', '--no-service', '--no-install', '--force', '--dry-run', '--yes', '--json', '--status', '--remove', '--help', '-h'],
  exclusive: [['--status', '--remove'], ['--funnel', '--no-tailscale'], ['--dry-run', '--status'], ['--dry-run', '--remove']],
} as const;

export const DEFAULT_EXPOSE_PORT = 3131;
const SURFACES = ['verbs', 'starter', 'full'] as const;
type Surface = (typeof SURFACES)[number];

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface McpExposeDeps {
  platform?: string;
  /** Read-only view of the environment (USER, HOME, GBRAIN_HOME, GBRAIN_TAILSCALE_LOGIN_TIMEOUT_MS). */
  env?: Record<string, string | undefined>;
  home?: string;
  user?: string;
  uid?: number;
  serveDir?: string;
  gbrainEnvFile?: string;
  plistPath?: string;
  unitPath?: string;
  loadConfig?: () => GBrainConfig | null;
  executionEnv?: ExecutionEnvironment;
  run?: CommandRunner;
  which?: (name: string) => string | null;
  fileExists?: (path: string) => boolean;
  fetch?: (url: string, init?: { signal?: AbortSignal; redirect?: 'manual' | 'error' | 'follow' }) => Promise<{ ok: boolean; status: number }>;
  isTTY?: boolean;
  prompt?: (question: string) => Promise<string | null>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  gbrainCommand?: string[];
  runtimeDir?: string;
  randomHex?: () => string;
  /** Health polling budget (ms). Tests shrink these. */
  localHealthMs?: number;
  tailnetHealthMs?: number;
  healthIntervalMs?: number;
  /** Seconds/ms the login step waits for `tailscale up` (default from env, 300000). */
  loginTimeoutMs?: number;
}

interface Check { name: string; status: 'ok' | 'warn' | 'fail' | 'skipped' | 'pending' | 'planned'; detail: string }

type ExposeStatus = 'exposed' | 'pending' | 'planned' | 'error' | 'removed' | 'not_exposed';

interface Resolved {
  platform: string;
  env: Record<string, string | undefined>;
  home: string;
  user: string;
  uid: number | undefined;
  serveDir: string;
  gbrainEnvFile: string;
  plistPath: string;
  unitPath: string;
  run: CommandRunner;
  which: (name: string) => string | null;
  fileExists: (path: string) => boolean;
  fetch: NonNullable<McpExposeDeps['fetch']>;
  isTTY: boolean;
  prompt: (question: string) => Promise<string | null>;
  out: (line: string) => void;
  err: (line: string) => void;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  executionEnv: ExecutionEnvironment;
  loadConfig: () => GBrainConfig | null;
  gbrainCommand: () => string[];
  runtimeDir: string;
  randomHex?: () => string;
  localHealthMs: number;
  tailnetHealthMs: number;
  healthIntervalMs: number;
  loginTimeoutMs: number;
}

function resolveDeps(deps: McpExposeDeps): Resolved {
  const env = deps.env ?? process.env;
  const home = deps.home ?? env.HOME ?? homedir();
  const which = deps.which ?? ((name: string) => { try { return Bun.which(name, { PATH: env.PATH ?? process.env.PATH ?? '' }); } catch { return null; } });
  const loginEnv = Number(env.GBRAIN_TAILSCALE_LOGIN_TIMEOUT_MS);
  return {
    platform: deps.platform ?? process.platform,
    env,
    home,
    user: deps.user ?? env.USER ?? (() => { try { return userInfo().username; } catch { return 'user'; } })(),
    uid: deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined),
    serveDir: deps.serveDir ?? defaultServeDir(),
    gbrainEnvFile: deps.gbrainEnvFile ?? gbrainPath('env'),
    plistPath: deps.plistPath ?? launchdPlistPath(home),
    unitPath: deps.unitPath ?? systemdUnitPath(home),
    run: deps.run ?? defaultCommandRunner,
    which,
    fileExists: deps.fileExists ?? existsSync,
    fetch: deps.fetch ?? ((url, init) => fetch(url, init as RequestInit)),
    isTTY: deps.isTTY ?? (process.stdin.isTTY === true && process.stderr.isTTY === true),
    prompt: deps.prompt ?? ((q: string) => promptLineStderr(q)),
    out: deps.stdout ?? ((line: string) => { process.stdout.write(`${line}\n`); }),
    err: deps.stderr ?? ((line: string) => { process.stderr.write(`${line}\n`); }),
    now: deps.now ?? (() => new Date()),
    sleep: deps.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms))),
    executionEnv: deps.executionEnv ?? detectExecutionEnvironment({ env }),
    loadConfig: deps.loadConfig ?? loadConfig,
    gbrainCommand: () => deps.gbrainCommand ?? resolveServeGbrainCommand({ which }),
    runtimeDir: deps.runtimeDir ?? dirname(process.execPath || ''),
    randomHex: deps.randomHex,
    localHealthMs: deps.localHealthMs ?? 20_000,
    tailnetHealthMs: deps.tailnetHealthMs ?? 30_000,
    healthIntervalMs: deps.healthIntervalMs ?? 1_000,
    loginTimeoutMs: deps.loginTimeoutMs ?? (Number.isFinite(loginEnv) && loginEnv > 0 ? loginEnv : 300_000),
  };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ExposeOptions {
  port: number;
  funnel: boolean;
  surface: Surface;
  enableDcr: boolean;
  noTailscale: boolean;
  noService: boolean;
  noInstall: boolean;
  force: boolean;
  dryRun: boolean;
  yes: boolean;
  json: boolean;
  status: boolean;
  remove: boolean;
  help: boolean;
}

/** Throws with a one-line message on any shape error (unknown flag, bad value, conflict). */
export function parseExposeArgs(args: string[]): ExposeOptions {
  validateHarnessArguments(args, MCP_EXPOSE_ARGUMENTS);
  const value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const rawPort = value('--port');
  let port = DEFAULT_EXPOSE_PORT;
  if (rawPort !== undefined) {
    const n = Number(rawPort);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new Error(`invalid --port '${rawPort}' (1-65535)`);
    port = n;
  }
  const rawSurface = value('--surface');
  if (rawSurface !== undefined && !(SURFACES as readonly string[]).includes(rawSurface)) throw new Error(`invalid --surface '${rawSurface}' — pass verbs, starter or full`);
  return {
    port,
    funnel: args.includes('--funnel'),
    surface: (rawSurface as Surface | undefined) ?? 'full',
    enableDcr: args.includes('--enable-dcr'),
    noTailscale: args.includes('--no-tailscale'),
    noService: args.includes('--no-service'),
    noInstall: args.includes('--no-install'),
    force: args.includes('--force'),
    dryRun: args.includes('--dry-run'),
    yes: args.includes('--yes'),
    json: args.includes('--json'),
    status: args.includes('--status'),
    remove: args.includes('--remove'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

// ---------------------------------------------------------------------------
// Session: check ledger + output routing
// ---------------------------------------------------------------------------

class Session {
  readonly checks: Check[] = [];
  readonly nextActions: string[] = [];
  constructor(private readonly d: Resolved, readonly json: boolean) {}
  /** Prose: stderr under --json, stdout otherwise. */
  say(line = ''): void { (this.json ? this.d.err : this.d.out)(line); }
  check(name: string, status: Check['status'], detail: string): Check {
    const c = { name, status, detail };
    this.checks.push(c);
    return c;
  }
  finish(status: ExposeStatus, code: number, extra: { receipt?: ExposeReceipt | null; reason?: string; message?: string; plan?: string[] } = {}): number {
    if (extra.message) this.say(`${status === 'error' ? 'error' : status}: ${extra.message}`);
    if (this.json) {
      this.d.out(JSON.stringify({
        status, receipt: extra.receipt ?? null, checks: this.checks, next_actions: this.nextActions,
        ...(extra.reason ? { reason: extra.reason } : {}), ...(extra.message ? { message: extra.message } : {}), ...(extra.plan ? { plan: extra.plan } : {}),
      }));
    }
    return code;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function engineKind(cfg: GBrainConfig | null): ExposeReceipt['engine'] {
  if (!cfg) return 'unknown';
  if (cfg.database_path && !cfg.database_url) return 'pglite';
  if (cfg.database_url || cfg.engine === 'postgres') return 'postgres';
  if (cfg.engine === 'pglite') return 'pglite';
  return 'unknown';
}

async function probeHealth(d: Resolved, url: string, timeoutMs = 1_500): Promise<boolean> {
  try {
    const res = await d.fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Poll until `budgetMs` of wall-clock time (from `d.now()`) has elapsed; each
 * probe's timeout is sized to `min(1500, remaining)` so the last attempt never
 * overruns the budget. Always probes at least once. The attempt cap is a
 * backstop for a clock that does not advance (tests inject a frozen `now`).
 */
async function pollHealth(d: Resolved, url: string, budgetMs: number): Promise<boolean> {
  const deadline = d.now().getTime() + Math.max(0, budgetMs);
  const maxAttempts = Math.max(1, Math.ceil(budgetMs / Math.max(1, d.healthIntervalMs)));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const remaining = deadline - d.now().getTime();
    if (attempt > 0 && remaining <= 0) return false;
    if (await probeHealth(d, url, Math.max(1, Math.min(1_500, remaining)))) return true;
    const left = deadline - d.now().getTime();
    if (left <= 0) return false;
    await d.sleep(Math.min(d.healthIntervalMs, left));
  }
  return false;
}

async function readServeView(d: Resolved, binary: string): Promise<ServeStatusView> {
  const r = await d.run([binary, ...TAILSCALE_SERVE_STATUS_ARGV], { timeoutMs: 15_000 });
  return parseServeStatus(r.stdout);
}

async function readStatus(d: Resolved, binary: string): Promise<{ status: TailscaleStatus | null; stderr: string; exit: number | null }> {
  const r = await d.run([binary, ...TAILSCALE_STATUS_ARGV], { timeoutMs: 15_000 });
  return { status: parseTailscaleStatus(r.stdout), stderr: r.stderr, exit: r.status };
}

async function probeServiceTarget(d: Resolved): Promise<ServiceTarget> {
  let userBus: { status: number | null; stdout: string } | null = null;
  if (d.platform === 'linux' && d.executionEnv === 'local' && d.which('systemctl')) {
    const r = await d.run([...SYSTEMCTL_USER_BUS_PROBE_ARGV], { timeoutMs: 3_000 });
    userBus = { status: r.status, stdout: `${r.stdout}\n${r.stderr}` };
  }
  return detectServiceTarget({ platform: d.platform, executionEnv: d.executionEnv, userBus });
}

function tildify(path: string, home: string): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function serviceLabel(target: ServiceTarget, state: ServiceState | 'skipped', d: Resolved): string {
  if (target === 'macos') return `launchd ${SERVE_LAUNCHD_LABEL}, ${state}   (log: ${tildify(serveLogPath(d.serveDir), d.home)})`;
  if (target === 'linux-systemd') return `systemd (user) ${SERVE_SYSTEMD_UNIT}, ${state}   (log: ${tildify(serveLogPath(d.serveDir), d.home)})`;
  return `manual (no supervisor here) — wrapper: ${tildify(wrapperPathFor(d.serveDir), d.home)}`;
}

function manualCommands(d: Resolved, wrapper: string): { foreground: string; background: string } {
  const w = shellQuote(wrapper);
  return { foreground: w, background: `nohup ${w} >> ${shellQuote(serveLogPath(d.serveDir))} 2>> ${shellQuote(serveErrPath(d.serveDir))} &` };
}

function describeHandler(h: ServeHandler): string {
  const target = h.proxy ?? (h.tcpForward ? `raw TCP forward ${h.tcpForward}` : '(non-proxy handler)');
  return `${h.host || '*'}:443/ -> ${target}${h.foreground ? ' (foreground session in another terminal)' : ''}`;
}

/**
 * How LOCAL agents (Claude Code / Codex / opencode on this machine) get wired.
 * Postgres mints fine while the serve runs. PGLite is single-writer: a live
 * serve holds the lock, so `bootstrap harness` refuses to mint (`live_serve`)
 * unless the operator pre-minted a token or provisions a scoped client
 * through the running server's admin API.
 */
function localAgentGuidance(engine: ExposeReceipt['engine'], port: number, tokenHint: string): { lines: string[]; nextActions: string[] } {
  const plain = `gbrain bootstrap harness --yes --port ${port}`;
  if (engine !== 'pglite') return { lines: [plain], nextActions: [plain] };
  const localUrl = `http://127.0.0.1:${port}/mcp`;
  const grant = `gbrain mcp grant local-agents --harness <id> --profile memory-writer --source default --url ${localUrl} --admin-token-file ${tokenHint} --credentials-out /private/local-agents.json`;
  const connect = `gbrain connect ${localUrl} --harness <id> --credentials-file /private/local-agents.json --install`;
  return {
    lines: [
      'PGLite is single-writer, so `gbrain bootstrap harness` cannot mint while this server runs. Either:',
      `(a) mint while the service is stopped — \`gbrain auth create local-agents --scopes read,write\` — then`,
      `    ${plain} --token <value>`,
      `(b) or grant a scoped client through the running server: ${grant}`,
      `    then ${connect}`,
    ],
    nextActions: [
      'gbrain auth create local-agents --scopes read,write   # PGLite: run while the service is stopped, then pass --token',
      `${plain} --token <value>`,
      grant,
      connect,
    ],
  };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function runMcpExpose(args: string[], deps: McpExposeDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  let opts: ExposeOptions;
  try {
    opts = parseExposeArgs(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args.includes('--json')) d.out(JSON.stringify({ status: 'error', reason: 'invalid_arguments', message, checks: [], next_actions: [], receipt: null }));
    d.err(`gbrain mcp expose: ${message}`);
    d.err('Run: gbrain mcp expose --help');
    return 1;
  }
  if (opts.help) { d.out(MCP_EXPOSE_HELP); return 0; }
  const s = new Session(d, opts.json);
  try {
    if (opts.status) return await runStatus(d, s);
    if (opts.remove) return await runRemove(d, s, opts);
    return await runPublish(d, s, opts);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    s.check('internal', 'fail', message);
    return s.finish('error', 1, { reason: 'mcp_expose_failed', message });
  }
}

// ---------------------------------------------------------------------------
// Publish (the default path)
// ---------------------------------------------------------------------------

async function runPublish(d: Resolved, s: Session, opts: ExposeOptions): Promise<number> {
  // 1. plan ------------------------------------------------------------------
  let cfg: GBrainConfig | null = null;
  try { cfg = d.loadConfig(); } catch { cfg = null; }
  if (isThinClient(cfg)) {
    s.check('plan', 'fail', 'this machine is a thin client (remote_mcp configured); run gbrain mcp expose on the brain host');
    return s.finish('error', 1, { reason: 'thin_client', message: 'This is a thin client. Run `gbrain mcp expose` on the machine that hosts the brain.' });
  }
  const engine = engineKind(cfg);
  const receiptPath = receiptPathFor(d.serveDir);
  const existing = readExposeReceipt(receiptPath);
  const tailscaleBinary = opts.noTailscale ? null : findTailscaleBinary({ which: d.which, fileExists: d.fileExists });
  const hasBrew = !!d.which('brew');
  const installPlan = tailscaleInstallPlan(d.platform, hasBrew);
  const target = opts.noService ? 'none' : await probeServiceTarget(d);
  const mode: ExposeReceipt['mode'] = opts.funnel ? 'funnel' : 'tailnet';
  // A service block from an earlier full run survives a `--no-service` re-run
  // untouched (the wrapper is not rewritten either).
  const keptService = opts.noService && existing && existing.service.state !== 'skipped' ? existing.service : null;
  const localHealthUrl = `http://127.0.0.1:${opts.port}/health`;
  const plan: string[] = [];
  plan.push(`Server    gbrain serve (HTTP) on 127.0.0.1:${opts.port} (surface ${opts.surface}${opts.enableDcr ? ', DCR on' : ''}); engine ${engine}`);
  if (opts.noTailscale) plan.push('Tailscale skipped (--no-tailscale): you publish the port yourself');
  else if (tailscaleBinary) plan.push(`Tailscale ${tailscaleBinary} — sign in if needed, then \`tailscale ${tailscaleServeArgv(opts.port, { funnel: opts.funnel }).join(' ')}\``);
  else if (opts.noInstall) plan.push(`Tailscale NOT installed and --no-install set — would stop with: ${installPlan.command}`);
  else plan.push(`Tailscale not installed — would run: ${installPlan.command}`);
  plan.push(`Reach     ${mode === 'funnel' ? 'PUBLIC internet via Tailscale Funnel (cloud agents); gbrain OAuth/bearer + grants protect it' : 'tailnet only — your devices; cloud agents need --funnel'}`);
  plan.push(`Token     ${tildify(adminTokenPathFor(d.serveDir), d.home)} (0600; created or reused; never printed)`);
  if (keptService) plan.push(`Service   kept as is (--no-service): ${serviceLabel(keptService.target, keptService.state, d)}`);
  else if (opts.noService) plan.push('Service   skipped (--no-service): publish only');
  else if (target === 'macos') plan.push(`Service   launchd user agent ${tildify(d.plistPath, d.home)} (RunAtLoad, KeepAlive)`);
  else if (target === 'linux-systemd') plan.push(`Service   systemd user unit ${tildify(d.unitPath, d.home)} (enabled + started, linger)`);
  else plan.push(`Service   manual — no user supervisor in this ${d.executionEnv === 'local' ? 'environment (no user bus)' : d.executionEnv}; you get a foreground command + nohup line`);
  plan.push(`Receipt   ${tildify(receiptPath, d.home)}${existing ? ' (updates the existing receipt)' : ''}`);
  s.check('plan', opts.dryRun ? 'planned' : 'ok', plan.join(' | '));
  s.say('Plan');
  for (const line of plan) s.say(`  ${line}`);
  if (opts.dryRun) {
    s.say('');
    s.say('Dry run: nothing changed. Re-run without --dry-run (add --yes to skip the prompt).');
    return s.finish('planned', 0, { receipt: existing, plan });
  }
  // Probe the local port NOW so a foreign listener is refused before anything
  // is published or installed (never after `tailscale serve --bg`). A receipt
  // for the same port claims the listener (it is our own server).
  const listeningBefore = await probeHealth(d, localHealthUrl);
  if (listeningBefore && !opts.noService && (!existing || existing.port !== opts.port)) {
    s.check('service', 'fail', `something already answers ${localHealthUrl} and no expose receipt claims it`);
    s.nextActions.push(`gbrain mcp expose${args2(opts)} --yes --no-service`);
    return s.finish('error', 1, { reason: 'foreign_listener', message: `A server already listens on 127.0.0.1:${opts.port}. Stop it, or pass --no-service to only publish it.` });
  }

  // 2. consent -------------------------------------------------------------
  if (!opts.yes) {
    if (!d.isTTY) {
      s.check('consent', 'pending', 'not a TTY and --yes not passed');
      s.nextActions.push(`gbrain mcp expose${args2(opts)} --yes`);
      return s.finish('pending', 2, { reason: 'confirmation_required', message: 'These are system-state changes (Tailscale, serve config, a user service). Pass --yes to confirm.' });
    }
    const answer = await d.prompt('Proceed with the plan above? [y/N] ');
    if (!answer || !/^y(es)?$/i.test(answer.trim())) {
      s.check('consent', 'pending', 'declined');
      return s.finish('pending', 2, { reason: 'declined', message: 'Nothing changed. Re-run with --yes to confirm.' });
    }
    s.check('consent', 'ok', 'confirmed interactively');
  } else {
    s.check('consent', 'ok', '--yes');
  }

  // 3-6. tailscale ---------------------------------------------------------
  let publicUrl: string | null = null;
  let binary = tailscaleBinary;
  let tsStatus: TailscaleStatus | null = null;
  if (opts.noTailscale) {
    for (const name of ['tailscale.binary', 'tailscale.login', 'tailscale.identity', 'tailscale.publish']) s.check(name, 'skipped', '--no-tailscale');
    publicUrl = `http://127.0.0.1:${opts.port}`;
    s.say('Tailscale skipped: the server stays on loopback until you publish it yourself.');
  } else {
    if (!binary) {
      if (opts.noInstall || !installPlan.argv) {
        s.check('tailscale.binary', 'fail', `not installed; ${installPlan.command}`);
        s.say('Tailscale is not installed.');
        s.say(`  Install: ${installPlan.command}`);
        s.say(`  ${installPlan.note}`);
        s.nextActions.push(installPlan.command);
        return s.finish('error', 1, { reason: opts.noInstall ? 'tailscale_missing' : 'tailscale_unsupported_platform', message: opts.noInstall ? 'Tailscale is missing and --no-install was set.' : installPlan.note });
      }
      s.say(`Installing Tailscale: ${installPlan.command}`);
      const inst = await d.run(installPlan.argv, { inherit: true, stdoutToStderr: opts.json, timeoutMs: 15 * 60_000 });
      binary = findTailscaleBinary({ which: d.which, fileExists: d.fileExists });
      if (inst.status !== 0 || !binary) {
        s.check('tailscale.binary', 'fail', `install ${inst.status === 0 ? 'finished but no binary was found' : `exited ${inst.status ?? 'null'}`}`);
        return s.finish('error', 1, { reason: 'tailscale_install_failed', message: `Tailscale install did not complete. Install it from ${installPlan.command === installPlan.note ? installPlan.command : 'https://tailscale.com/download'} and re-run.` });
      }
      if (installPlan.kind === 'brew-cask') {
        // The app bundle's CLI talks to the app's daemon, which only runs once
        // the app has been opened. Best effort; give it a moment to come up.
        await d.run(['open', '-a', 'Tailscale'], { inherit: true, stdoutToStderr: opts.json, timeoutMs: 30_000 });
        await d.sleep(5_000);
      }
      s.check('tailscale.binary', 'ok', `installed: ${binary}`);
    } else {
      s.check('tailscale.binary', 'ok', binary);
    }

    // 4. login
    let st = await readStatus(d, binary);
    if (!st.status) {
      const cls = classifyTailscaleError(st.stderr, { platform: d.platform, user: d.user });
      if (cls.kind === 'daemon_not_running' || st.exit === null) {
        s.check('tailscale.login', 'pending', `daemon not running: ${cls.raw || 'no output'}`);
        s.nextActions.push(tailscaleDaemonStartHint(d.platform), `gbrain mcp expose${args2(opts)} --yes`);
        return s.finish('pending', 2, { reason: 'tailscale_daemon_not_running', message: `The Tailscale daemon is not running. ${cls.fix}` });
      }
      s.check('tailscale.login', 'fail', cls.raw || 'tailscale status printed no JSON');
      return s.finish('error', 1, { reason: `tailscale_${cls.kind}`, message: cls.fix });
    }
    if (st.status.backendState !== 'Running') {
      const login = tailscaleLoginArgv(d.platform, d.user, binary);
      if (login.setOperator) {
        // Set the operator FIRST (so `serve` works without sudo later); a
        // failure is a note, not a stop — `up --operator=` is avoided because
        // it trips the CLI's settings-revert check on a node with custom prefs.
        s.say(`Tailscale is ${st.status.backendState}. Letting ${d.user} manage serve: ${login.setOperator.join(' ')}`);
        const so = await d.run(login.setOperator, { inherit: true, stdoutToStderr: opts.json, timeoutMs: 120_000 });
        if (so.status !== 0) s.say(`Note: ${login.setOperator.join(' ')} exited ${so.status ?? 'null'}; run \`${tailscaleSetOperatorCommand(d.user)}\` later so \`tailscale serve\` works without sudo.`);
      }
      s.say(`Signing in: ${login.up.join(' ')}`);
      s.say('  Open the URL it prints, approve the device, and come back.');
      const upResult = await d.run(login.up, { inherit: true, stdoutToStderr: opts.json, timeoutMs: d.loginTimeoutMs });
      st = await readStatus(d, binary);
      if (!st.status || st.status.backendState !== 'Running') {
        s.check('tailscale.login', 'pending', `BackendState ${st.status?.backendState ?? 'unknown'} after tailscale up (exit ${upResult.status ?? 'null'})`);
        const rerun = `gbrain mcp expose${args2(opts)} --yes`;
        s.nextActions.push(d.platform === 'darwin' ? 'Open the Tailscale app and sign in' : login.up.join(' '), rerun);
        return s.finish('pending', 2, { reason: 'tailscale_login_pending', message: d.platform === 'darwin' ? `Open the Tailscale app and sign in, then re-run: ${rerun}` : `Complete the login, then re-run: ${rerun}` });
      }
      s.check('tailscale.login', 'ok', 'Running (signed in just now)');
    } else {
      s.check('tailscale.login', 'ok', 'Running');
    }
    tsStatus = st.status;

    // 5. identity
    if (!tsStatus.dnsName) {
      s.check('tailscale.identity', 'fail', 'Self.DNSName is empty — MagicDNS is off for this tailnet');
      s.nextActions.push(`Enable MagicDNS + HTTPS Certificates at ${TAILSCALE_ADMIN_DNS_URL}`);
      return s.finish('error', 1, { reason: 'tailscale_no_dns_name', message: `Your node has no MagicDNS name. Enable MagicDNS and HTTPS Certificates at ${TAILSCALE_ADMIN_DNS_URL}, then re-run.` });
    }
    publicUrl = publicUrlFromDnsName(tsStatus.dnsName);
    // Pre-checks. `tailscale serve/funnel --bg` do NOT fail when the feature
    // is off — they print an enablement URL and wait for the operator — so
    // never start them blind.
    const rerun = `gbrain mcp expose${args2(opts)} --yes`;
    if (tsStatus.certDomains.length === 0) {
      s.check('tailscale.identity', 'pending', `${tsStatus.dnsName}; CertDomains empty — HTTPS certificates are not enabled for this tailnet (${TAILSCALE_ADMIN_DNS_URL})`);
      s.nextActions.push(`Enable MagicDNS + HTTPS Certificates at ${TAILSCALE_ADMIN_DNS_URL}`, rerun);
      return s.finish('pending', 2, { reason: 'tailscale_https_not_enabled', message: `HTTPS certificates are not enabled for your tailnet, so nothing was published. Enable MagicDNS + HTTPS Certificates at ${TAILSCALE_ADMIN_DNS_URL}, then re-run: ${rerun}` });
    }
    if (opts.funnel && tsStatus.funnelCapable === false) {
      s.check('tailscale.identity', 'pending', `${tsStatus.dnsName}; this node lacks the Funnel capability (${TAILSCALE_ADMIN_ACL_URL})`);
      s.nextActions.push(`Enable the funnel node attribute at ${TAILSCALE_ADMIN_ACL_URL} (see ${TAILSCALE_FUNNEL_KB_URL})`, rerun);
      return s.finish('pending', 2, { reason: 'tailscale_funnel_not_enabled', message: `Tailscale Funnel is not enabled for this node, so nothing was published. Enable the \`funnel\` node attribute in your tailnet policy at ${TAILSCALE_ADMIN_ACL_URL} (see ${TAILSCALE_FUNNEL_KB_URL}), then re-run: ${rerun}` });
    }
    s.check('tailscale.identity', 'ok', `${tsStatus.dnsName}${opts.funnel && tsStatus.funnelCapable === null ? ' (Funnel capability not reported by this CLI; the publish step decides)' : ''}`);

    // 6. publish
    const before = await readServeView(d, binary);
    const ours = findProxiedHandler(before, opts.port);
    const foreign = findRootHandlers(before).filter(h => h.proxyPort !== opts.port);
    const claimed = existing !== null && foreign.some(h => h.proxyPort === existing.port);
    const foregroundForeign = foreign.filter(h => h.foreground);
    if (foreign.length > 0 && !claimed && (!opts.force || foregroundForeign.length > 0)) {
      const desc = foreign.map(describeHandler).join(', ');
      s.check('tailscale.publish', 'fail', `someone else's serve config on :443: ${desc}`);
      s.nextActions.push('tailscale serve status');
      const message = foregroundForeign.length > 0
        ? `tailscale serve already proxies :443 to ${desc}. A foreground \`tailscale serve\` session in another terminal owns it — --force cannot overwrite it; stop it there (Ctrl-C), then re-run.`
        : `tailscale serve already proxies :443 to ${desc}. Re-run with --force to take it over, or pick another local port for that service.`;
      return s.finish('error', 1, { reason: 'foreign_serve_config', message });
    }
    if (ours && ours.funnel !== opts.funnel) {
      // Switching tailnet <-> funnel for our own handler: turn the old shape off first.
      await d.run([binary, ...tailscaleServeOffArgv({ funnel: ours.funnel })], { timeoutMs: 30_000 });
    }
    const publishArgv = tailscaleServeArgv(opts.port, { funnel: opts.funnel });
    const pub = await d.run([binary, ...publishArgv], { timeoutMs: 60_000 });
    if (pub.status !== 0) {
      if (pub.status === null) {
        // Killed at the 60s deadline: most likely the CLI was waiting for an
        // enablement step the pre-checks could not see. Say so, never guess.
        const hint = `\`tailscale ${publishArgv.join(' ')}\` did not finish within 60s (it may be waiting for you to enable a feature). Run it by hand to see what it prints, then re-run: ${rerun}`;
        s.check('tailscale.publish', 'fail', `unknown: timed out after 60s`);
        s.nextActions.push(`tailscale ${publishArgv.join(' ')}`);
        return s.finish('error', 1, { reason: 'tailscale_unknown', message: hint });
      }
      const cls = classifyTailscaleError(pub.stderr || pub.stdout, { platform: d.platform, user: d.user });
      s.check('tailscale.publish', 'fail', `${cls.kind}: ${cls.raw || `exit ${pub.status}`}`);
      s.nextActions.push(cls.fix);
      return s.finish('error', 1, { reason: `tailscale_${cls.kind}`, message: cls.fix });
    }
    const after = await readServeView(d, binary);
    const confirmed = findProxiedHandler(after, opts.port);
    if (!confirmed) {
      s.check('tailscale.publish', 'fail', `tailscale ${publishArgv.join(' ')} exited 0 but serve status shows no / handler for port ${opts.port}`);
      return s.finish('error', 1, { reason: 'tailscale_publish_unconfirmed', message: 'Tailscale accepted the command but does not show the handler. Run `tailscale serve status` to inspect.' });
    }
    if (confirmed.funnel !== opts.funnel) {
      s.check('tailscale.publish', 'warn', `handler present but funnel=${confirmed.funnel} (wanted ${opts.funnel})`);
      s.say(`Warning: Funnel is ${confirmed.funnel ? 'ON' : 'OFF'} for this handler but you asked for ${opts.funnel ? 'Funnel' : 'tailnet-only'}. Fix: tailscale ${tailscaleServeOffArgv({ funnel: confirmed.funnel }).join(' ')}, then re-run.`);
    } else {
      s.check('tailscale.publish', 'ok', `${confirmed.host}:443/ -> ${confirmed.proxy}${opts.funnel ? ' (funnel)' : ''}`);
    }
  }

  // 7. admin token -----------------------------------------------------------
  const tokenPath = adminTokenPathFor(d.serveDir);
  const token = ensureAdminToken(tokenPath, { randomHex: d.randomHex });
  s.check('admin_token', 'ok', `${token.action}: ${tokenPath}`);
  if (token.action === 'regenerated') s.say(`Note: ${tildify(tokenPath, d.home)} did not look like a valid admin token and was regenerated.`);

  // 8. service ---------------------------------------------------------------
  const wrapper = wrapperPathFor(d.serveDir);
  let serviceReceipt: ExposeReceipt['service'] = { target, unit_path: null, plist_path: null, wrapper_path: wrapper, state: 'skipped' };
  const buildReceipt = (): ExposeReceipt => {
    const nowIso = d.now().toISOString();
    return {
      version: 1,
      created_at: existing?.created_at ?? nowIso,
      updated_at: nowIso,
      port: opts.port,
      public_url: publicUrl!,
      mcp_url: `${publicUrl}/mcp`,
      admin_url: `${publicUrl}/admin`,
      mode,
      surface: opts.surface,
      enable_dcr: opts.enableDcr,
      tailscale: { binary, dns_name: tsStatus?.dnsName ?? null, tailscale_version: tsStatus?.version ?? null },
      service: serviceReceipt,
      admin_token_file: tokenPath,
      engine,
    };
  };
  if (keptService) {
    serviceReceipt = keptService;
    s.check('service', 'skipped', `--no-service: existing ${serviceLabel(keptService.target, keptService.state, d)} kept as is`);
  } else if (opts.noService) {
    s.check('service', 'skipped', '--no-service');
  } else {
    // (a foreign listener was already refused in the plan step, before publishing)
    const content = renderServeWrapper({
      gbrainCommand: d.gbrainCommand(), adminTokenPath: tokenPath, gbrainEnvFile: d.gbrainEnvFile, gbrainHome: d.env.GBRAIN_HOME,
      runtimeDir: d.runtimeDir, port: opts.port, publicUrl: publicUrl!, surface: opts.surface, enableDcr: opts.enableDcr,
    });
    const installed = await installServeService({
      target, wrapperPath: wrapper, wrapperContent: content, home: d.home, logPath: serveLogPath(d.serveDir), errPath: serveErrPath(d.serveDir),
      run: d.run, plistPath: d.plistPath, unitPath: d.unitPath,
    });
    serviceReceipt.plist_path = installed.plist_path;
    serviceReceipt.unit_path = installed.unit_path;
    for (const note of installed.notes) s.say(`Note: ${note}`);
    if (installed.error) {
      s.check('service', 'fail', installed.error);
      // Keep a receipt so `--status` / `--remove` can still see and clean up
      // the handler that WAS published.
      serviceReceipt.state = 'stopped';
      const partial = buildReceipt();
      writeExposeReceipt(receiptPath, partial);
      s.check('receipt', 'ok', `${receiptPath} (service stopped)`);
      s.nextActions.push('gbrain mcp expose --status', 'gbrain mcp expose --remove --yes');
      return s.finish('error', 1, { receipt: partial, reason: 'service_install_failed', message: installed.error });
    }
    if (target === 'none') {
      serviceReceipt.state = 'manual';
      const cmds = manualCommands(d, wrapper);
      s.check('service', 'ok', `manual: wrapper written to ${wrapper}`);
      s.say('No user supervisor is available here, so the server is not auto-started. Run it yourself:');
      s.say(`  Foreground   ${cmds.foreground}`);
      s.say(`  Background   ${cmds.background}`);
      s.nextActions.push(cmds.foreground);
    } else {
      serviceReceipt.state = await serveServiceState({ target, run: d.run, uid: d.uid });
      s.check('service', serviceReceipt.state === 'running' || serviceReceipt.state === 'loaded' ? 'ok' : 'warn', serviceLabel(target, serviceReceipt.state, d));
    }
  }

  // 9. verify ----------------------------------------------------------------
  let localHealth: 'ok' | 'timeout' | 'skipped' = 'skipped';
  if (opts.noService && !listeningBefore && !keptService) {
    s.check('verify.local', 'skipped', `--no-service and nothing listens on ${localHealthUrl} yet`);
    s.say(`Nothing listens on 127.0.0.1:${opts.port} yet — start the server: ${['gbrain', ...serveCommandArgv({ port: opts.port, publicUrl: publicUrl!, surface: opts.surface, enableDcr: opts.enableDcr })].join(' ')}`);
  } else if (target === 'none' && !opts.noService && !listeningBefore) {
    s.check('verify.local', 'skipped', 'manual service: start the wrapper, then run --status');
  } else {
    localHealth = (await pollHealth(d, localHealthUrl, d.localHealthMs)) ? 'ok' : 'timeout';
    s.check('verify.local', localHealth === 'ok' ? 'ok' : 'warn', `${localHealthUrl}: ${localHealth}`);
  }
  let tailnetHealth: 'ok' | 'pending' | 'skipped' = 'skipped';
  if (!opts.noTailscale && localHealth === 'ok') {
    tailnetHealth = (await pollHealth(d, `${publicUrl}/health`, d.tailnetHealthMs)) ? 'ok' : 'pending';
    s.check('verify.tailnet', tailnetHealth === 'ok' ? 'ok' : 'pending', `${publicUrl}/health: ${tailnetHealth}${tailnetHealth === 'pending' ? ' (first certificate issuance can take a minute)' : ''}`);
  } else {
    s.check('verify.tailnet', 'skipped', opts.noTailscale ? '--no-tailscale' : 'local server not confirmed yet');
  }

  // 10. receipt --------------------------------------------------------------
  const receipt = buildReceipt();
  writeExposeReceipt(receiptPath, receipt);
  s.check('receipt', 'ok', receiptPath);

  // Human summary -----------------------------------------------------------
  const tokenHint = tildify(tokenPath, d.home);
  s.say('');
  s.say(opts.noTailscale ? 'GBrain MCP server configured (not published — --no-tailscale)' : `GBrain MCP server published on ${mode === 'funnel' ? 'the public internet via Tailscale Funnel' : 'your tailnet'}`);
  s.say(`  MCP URL   ${receipt.mcp_url}`);
  s.say(`  Admin     ${receipt.admin_url}   (token: ${tokenHint})`);
  s.say(`  Reach     ${mode === 'funnel' ? 'public (Funnel) — cloud agents can connect; gbrain OAuth/bearer + scoped grants protect it.' : 'tailnet only — your devices. Cloud agents (Grok Bot, Muse, ChatGPT) need `--funnel`.'}`);
  s.say(`  Service   ${keptService ? `${serviceLabel(keptService.target, keptService.state, d)} (kept, --no-service)` : opts.noService ? 'skipped (--no-service)' : serviceLabel(target, serviceReceipt.state, d)}`);
  if (engine === 'pglite') {
    s.say('  Engine    PGLite (single-writer): host-side commands that open the database fail with `live_serve` —');
    s.say('            administer through the running server (--admin-token-file; `gbrain sync` delegates to it),');
    s.say('            or move to Postgres for concurrent local use.');
  } else {
    s.say(`  Engine    ${engine === 'postgres' ? 'Postgres' : 'unknown (no brain config found — run gbrain init on this host)'}`);
  }
  if (localHealth === 'timeout') s.say(`  Health    local ${localHealthUrl} did not answer within ${Math.round(d.localHealthMs / 1000)}s — check ${tildify(serveErrPath(d.serveDir), d.home)}`);
  if (tailnetHealth === 'pending') s.say(`  Health    ${publicUrl}/health still pending — re-run \`gbrain mcp expose --status\` in a minute.`);
  s.say('');
  s.say('Next');
  s.say(`  Grant a client   gbrain mcp grant <name> --harness <id> --profile memory-writer --source default \\`);
  s.say(`                     --url ${receipt.mcp_url} \\`);
  s.say(`                     --admin-token-file ${tokenHint} --credentials-out /private/<name>.json`);
  s.say(`  Then inside it   gbrain connect ${receipt.mcp_url} --harness <id> --credentials-file /private/<name>.json --install`);
  const local = localAgentGuidance(engine, opts.port, tokenHint);
  s.say(`  Local agents     ${local.lines[0]}`);
  for (const line of local.lines.slice(1)) s.say(`                   ${line}`);
  s.say('  Check            gbrain mcp expose --status');
  s.nextActions.push(
    `gbrain mcp grant <name> --harness <id> --profile memory-writer --source default --url ${receipt.mcp_url} --admin-token-file ${tokenHint} --credentials-out /private/<name>.json`,
    ...local.nextActions,
    'gbrain mcp expose --status',
  );
  const pending = tailnetHealth === 'pending' || localHealth === 'timeout';
  return s.finish(pending ? 'pending' : 'exposed', pending ? 2 : 0, { receipt, ...(pending ? { reason: tailnetHealth === 'pending' ? 'tailnet_health_pending' : 'local_health_timeout' } : {}) });
}

/** Re-render the user's publish flags for a re-run hint (never --yes/--json/--dry-run). */
function args2(opts: ExposeOptions): string {
  const parts: string[] = [];
  if (opts.port !== DEFAULT_EXPOSE_PORT) parts.push(`--port ${opts.port}`);
  if (opts.funnel) parts.push('--funnel');
  if (opts.surface !== 'full') parts.push(`--surface ${opts.surface}`);
  if (opts.enableDcr) parts.push('--enable-dcr');
  if (opts.noTailscale) parts.push('--no-tailscale');
  if (opts.noService) parts.push('--no-service');
  if (opts.noInstall) parts.push('--no-install');
  return parts.length ? ` ${parts.join(' ')}` : '';
}

// ---------------------------------------------------------------------------
// --status
// ---------------------------------------------------------------------------

async function runStatus(d: Resolved, s: Session): Promise<number> {
  const receipt = readExposeReceipt(receiptPathFor(d.serveDir));
  if (!receipt) {
    s.check('receipt', 'skipped', 'no expose receipt');
    s.say('not exposed — run: gbrain mcp expose');
    s.nextActions.push('gbrain mcp expose');
    return s.finish('not_exposed', s.json ? 2 : 0, { reason: 'not_exposed' });
  }
  s.check('receipt', 'ok', `${receipt.mode} on port ${receipt.port} since ${receipt.created_at}`);
  let allOk = true;
  let pending = false;
  // tailscale
  if (receipt.tailscale.binary || receipt.tailscale.dns_name) {
    const binary = (receipt.tailscale.binary && d.fileExists(receipt.tailscale.binary) ? receipt.tailscale.binary : null) ?? findTailscaleBinary({ which: d.which, fileExists: d.fileExists });
    if (!binary) {
      allOk = false;
      s.check('tailscale.publish', 'fail', 'tailscale binary not found');
    } else {
      const view = await readServeView(d, binary);
      const ours = findProxiedHandler(view, receipt.port);
      if (!ours) { allOk = false; s.check('tailscale.publish', 'fail', `no :443 handler proxies to port ${receipt.port}`); }
      else if (ours.funnel !== (receipt.mode === 'funnel')) { allOk = false; s.check('tailscale.publish', 'warn', `handler present but funnel=${ours.funnel}; receipt says ${receipt.mode}`); }
      else s.check('tailscale.publish', 'ok', `${ours.host}:443/ -> ${ours.proxy}${ours.funnel ? ' (funnel)' : ''}`);
    }
  } else {
    s.check('tailscale.publish', 'skipped', 'published without Tailscale');
  }
  // service
  let state: ServiceState | 'skipped' = 'skipped';
  if (receipt.service.state !== 'skipped') {
    state = await serveServiceState({ target: receipt.service.target, run: d.run, uid: d.uid });
    const good = state === 'running' || state === 'loaded' || state === 'manual';
    if (!good) allOk = false;
    s.check('service', good ? 'ok' : 'fail', serviceLabel(receipt.service.target, state, d));
  } else {
    s.check('service', 'skipped', 'installed with --no-service');
  }
  // health
  const localUrl = `http://127.0.0.1:${receipt.port}/health`;
  const localOk = await probeHealth(d, localUrl, 3_000);
  if (!localOk) allOk = false;
  s.check('verify.local', localOk ? 'ok' : 'fail', `${localUrl}: ${localOk ? 'ok' : 'no answer'}`);
  if (receipt.public_url.startsWith('https://')) {
    const tailnetOk = await probeHealth(d, `${receipt.public_url}/health`, 8_000);
    if (!tailnetOk) pending = true;
    s.check('verify.tailnet', tailnetOk ? 'ok' : 'pending', `${receipt.public_url}/health: ${tailnetOk ? 'ok' : 'pending'}`);
  } else {
    s.check('verify.tailnet', 'skipped', 'no https public URL');
  }
  s.say(`GBrain MCP server (${receipt.mode}) — ${receipt.mcp_url}`);
  for (const c of s.checks) s.say(`  ${c.status.padEnd(8)} ${c.name.padEnd(18)} ${c.detail}`);
  if (!allOk) s.nextActions.push('gbrain mcp expose --yes');
  if (!allOk) return s.finish('error', 1, { receipt, reason: 'status_unhealthy' });
  // Spec: --status exits 0 only when EVERYTHING verifies. A pending tailnet
  // certificate is reported as `pending` (not `error`) so callers can tell
  // "wait a minute" from "broken", but it is still a non-zero exit.
  if (pending) { s.nextActions.push('gbrain mcp expose --status'); return s.finish('pending', 1, { receipt, reason: 'tailnet_health_pending', message: 'tailnet health still pending (first certificate issuance can take a minute) — re-run --status shortly.' }); }
  return s.finish('exposed', 0, { receipt });
}

// ---------------------------------------------------------------------------
// --remove
// ---------------------------------------------------------------------------

async function runRemove(d: Resolved, s: Session, opts: ExposeOptions): Promise<number> {
  const receiptPath = receiptPathFor(d.serveDir);
  const receipt = readExposeReceipt(receiptPath);
  if (!receipt) {
    s.check('receipt', 'skipped', 'no expose receipt; nothing to remove');
    s.say('not exposed — nothing to remove');
    return s.finish('not_exposed', 0, { reason: 'not_exposed' });
  }
  const plan = [
    receipt.service.state === 'skipped' ? 'Service   none installed' : `Service   stop + remove ${receipt.service.target === 'macos' ? `launchd ${SERVE_LAUNCHD_LABEL}` : receipt.service.target === 'linux-systemd' ? `systemd (user) ${SERVE_SYSTEMD_UNIT}` : 'manual wrapper'}`,
    receipt.tailscale.binary ? `Tailscale turn off OUR :443 handler${receipt.mode === 'funnel' ? ' (funnel first)' : ''} — Tailscale stays installed and signed in` : 'Tailscale nothing to undo',
    `Files     delete ${tildify(receipt.service.wrapper_path, d.home)} and ${tildify(receiptPath, d.home)}`,
    opts.force ? `Token     delete ${tildify(receipt.admin_token_file, d.home)} (--force)` : `Token     keep ${tildify(receipt.admin_token_file, d.home)} (dashboard session may still use it; --force deletes)`,
  ];
  s.check('plan', 'ok', plan.join(' | '));
  s.say('Remove plan');
  for (const line of plan) s.say(`  ${line}`);
  if (!opts.yes) {
    if (!d.isTTY) {
      s.check('consent', 'pending', 'not a TTY and --yes not passed');
      return s.finish('pending', 2, { receipt, reason: 'confirmation_required', message: 'Pass --yes to confirm the removal.' });
    }
    const answer = await d.prompt('Remove the published server? [y/N] ');
    if (!answer || !/^y(es)?$/i.test(answer.trim())) {
      s.check('consent', 'pending', 'declined');
      return s.finish('pending', 2, { receipt, reason: 'declined', message: 'Nothing changed. Re-run with --yes to confirm.' });
    }
  }
  s.check('consent', 'ok', opts.yes ? '--yes' : 'confirmed interactively');
  const left: string[] = [];
  // service — the receipt may say `skipped` (a `--no-service` run) while a
  // service from an earlier run still exists; probe the supervisor too.
  let serviceTarget: ServiceTarget = receipt.service.target;
  let serviceKnown = receipt.service.state !== 'skipped';
  if (!serviceKnown) {
    serviceTarget = await probeServiceTarget(d);
    if (serviceTarget !== 'none') {
      const unitFile = serviceTarget === 'macos' ? d.plistPath : d.unitPath;
      const state = await serveServiceState({ target: serviceTarget, run: d.run, uid: d.uid });
      serviceKnown = state === 'running' || state === 'loaded' || existsSync(unitFile);
      if (serviceKnown) s.say(`Note: the receipt says no service was installed, but a ${serviceLabel(serviceTarget, state, d)} exists — removing it too.`);
    }
  }
  if (serviceKnown && serviceTarget !== 'none') {
    const r = await uninstallServeService({ target: serviceTarget, home: d.home, run: d.run, plistPath: receipt.service.plist_path ?? d.plistPath, unitPath: receipt.service.unit_path ?? d.unitPath });
    for (const note of r.notes) s.say(`Note: ${note}`);
    s.check('service', 'ok', r.removed.length ? `removed ${r.removed.join(', ')}` : 'stopped (no unit file to delete)');
  } else {
    s.check('service', 'skipped', receipt.service.target === 'none' ? 'manual service: stop the wrapper process yourself if it is running' : 'none installed');
    if (receipt.service.target === 'none' && receipt.service.state !== 'skipped') left.push('a manually started server process (if any)');
  }
  // tailscale handler
  if (receipt.tailscale.binary || receipt.tailscale.dns_name) {
    const binary = (receipt.tailscale.binary && d.fileExists(receipt.tailscale.binary) ? receipt.tailscale.binary : null) ?? findTailscaleBinary({ which: d.which, fileExists: d.fileExists });
    if (!binary) {
      s.check('tailscale.publish', 'warn', 'tailscale binary not found; serve handler left as is');
      left.push('the tailscale serve handler (binary not found)');
    } else {
      const view = await readServeView(d, binary);
      const ours = findProxiedHandler(view, receipt.port);
      if (!ours) {
        s.check('tailscale.publish', 'ok', `no :443 handler proxies to port ${receipt.port}; nothing to turn off`);
      } else {
        const results: string[] = [];
        if (receipt.mode === 'funnel' || ours.funnel) {
          const off = await d.run([binary, ...tailscaleServeOffArgv({ funnel: true })], { timeoutMs: 30_000 });
          results.push(`funnel off: exit ${off.status ?? 'null'}`);
        }
        const stillThere = findProxiedHandler(await readServeView(d, binary), receipt.port);
        if (stillThere) {
          const off = await d.run([binary, ...tailscaleServeOffArgv({ funnel: false })], { timeoutMs: 30_000 });
          results.push(`serve off: exit ${off.status ?? 'null'}`);
        }
        const remaining = findProxiedHandler(await readServeView(d, binary), receipt.port);
        s.check('tailscale.publish', remaining ? 'warn' : 'ok', `${results.join(', ')}${remaining ? ' — handler still present; run `tailscale serve status`' : ''}`);
        if (remaining) left.push('the tailscale serve handler');
      }
    }
    left.push('Tailscale itself (installed and signed in)');
  } else {
    s.check('tailscale.publish', 'skipped', 'published without Tailscale');
  }
  // files
  const removed: string[] = [];
  for (const p of [receipt.service.wrapper_path, receiptPath]) {
    try { if (existsSync(p)) { unlinkSync(p); removed.push(p); } } catch (error) { s.say(`Note: could not delete ${p}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (opts.force) {
    try { if (existsSync(receipt.admin_token_file)) { unlinkSync(receipt.admin_token_file); removed.push(receipt.admin_token_file); } } catch { /* best effort */ }
  } else if (existsSync(receipt.admin_token_file)) {
    left.push(`${tildify(receipt.admin_token_file, d.home)} (admin token; pass --force to delete)`);
  }
  s.check('receipt', 'ok', `removed ${removed.map(p => tildify(p, d.home)).join(', ') || 'nothing'}`);
  s.say('');
  s.say('Removed the published MCP server.');
  s.say(`  Left in place: ${left.length ? left.join('; ') : 'nothing'}`);
  s.say(`  Log files: ${tildify(serveLogPath(d.serveDir), d.home)}, ${tildify(serveErrPath(d.serveDir), d.home)} (kept)`);
  return s.finish('removed', 0, { receipt: null });
}
