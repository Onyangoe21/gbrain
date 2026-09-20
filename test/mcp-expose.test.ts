/**
 * `gbrain mcp expose` end-to-end against a stateful fake tailnet: a recording
 * runner stands in for tailscale/systemctl/launchctl, fetch is injected, every
 * path lives in a tmpdir. No network, no real supervisor, no process.env writes.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpNeedsEngine, runMcp } from '../src/commands/mcp.ts';
import { runMcpExpose, parseExposeArgs, MCP_EXPOSE_HELP, type McpExposeDeps } from '../src/commands/mcp-expose.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { TAILSCALE_ADMIN_ACL_URL, TAILSCALE_ADMIN_DNS_URL, TAILSCALE_FUNNEL_KB_URL, type CommandRunner, type CommandRunOptions } from '../src/core/tailscale.ts';
import { adminTokenPath, readExposeReceipt, receiptPath, wrapperPath, writeExposeReceipt, type ExposeReceipt } from '../src/core/serve-service.ts';

const roots: string[] = [];
const temp = () => { const p = mkdtempSync(join(tmpdir(), 'gbrain-mcp-expose-')); roots.push(p); return p; };
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });

const DNS = 'your-machine.your-tailnet.ts.net';
const TS = '/usr/bin/tailscale';
const APP_TS = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const TOKEN = 'f'.repeat(64);

interface TailnetOpts {
  /** Path the fake tailscale answers under (default /usr/bin/tailscale; darwin runs use the app bundle). */
  binary?: string;
  backendState?: string;
  /** BackendState after `tailscale up` ran (default: Running). */
  afterUp?: string;
  certDomains?: string[];
  dnsName?: string | null;
  /** Self.CapMap: true → carries the Funnel capability, false → CapMap without it, undefined → no CapMap field. */
  funnelCapable?: boolean;
  /** Pre-existing root handlers: port → funnel flag. */
  existingHandlers?: Record<number, boolean>;
  publishStatus?: number | null;
  publishStderr?: string;
  /** `--bg` exits 0 but registers nothing (the CLI lied). */
  publishNoop?: boolean;
  /** Register the handler with THIS funnel flag regardless of the subcommand (mismatch drill). */
  publishedFunnel?: boolean;
  statusStderr?: string;
  statusStdoutOverride?: string;
  userBusStatus?: number;
  serviceActive?: string;
  /** Exit status of `sudo tailscale set --operator=…` (default 0). */
  setOperatorStatus?: number;
  /** Local health answers before anything is installed (a foreign listener). */
  localListeningBefore?: boolean;
  tailnetHealthy?: boolean;
  localHealthyAfterStart?: boolean;
}

interface Fake {
  run: CommandRunner;
  calls: string[][];
  /** Every runner invocation with the opts the command passed (inherit / stdoutToStderr / timeoutMs). */
  recorded: { argv: string[]; opts: CommandRunOptions | undefined }[];
  fetches: string[];
  stdout: string[];
  stderr: string[];
  deps: McpExposeDeps;
  home: string;
  serveDir: string;
  /** Flip the fake service off (as if the supervisor stopped it). */
  stopService: () => void;
}

function fakeTailnet(o: TailnetOpts = {}): Fake {
  const home = temp();
  const ts = o.binary ?? TS;
  const serveDir = join(home, '.gbrain', 'serve');
  const handlers: Record<number, boolean> = { ...(o.existingHandlers ?? {}) };
  let state = o.backendState ?? 'Running';
  let serviceStarted = false;
  const calls: string[][] = [];
  const recorded: Fake['recorded'] = [];
  const fetches: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const statusDoc = () => JSON.stringify({
    Version: '1.80.0', BackendState: state,
    Self: {
      DNSName: o.dnsName === undefined ? `${DNS}.` : (o.dnsName ?? ''), TailscaleIPs: ['100.64.0.1'],
      ...(o.funnelCapable === undefined ? {} : { CapMap: o.funnelCapable ? { 'https://tailscale.com/cap/funnel': [] } : { 'https://tailscale.com/cap/is-admin': [] } }),
    },
    CurrentTailnet: { MagicDNSEnabled: true }, CertDomains: o.certDomains ?? [DNS],
  });
  const serveDoc = () => {
    const web: Record<string, unknown> = {};
    const allow: Record<string, boolean> = {};
    for (const [port, funnel] of Object.entries(handlers)) {
      web[`${DNS}:443`] = { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } };
      if (funnel) allow[`${DNS}:443`] = true;
    }
    return JSON.stringify({ TCP: { '443': { HTTPS: true } }, Web: web, AllowFunnel: allow });
  };
  const run: CommandRunner = async (argv, runOpts) => {
    calls.push(argv);
    recorded.push({ argv, opts: runOpts });
    const joined = argv.join(' ');
    if (joined === `${ts} status --json`) {
      // `status --json` exits 0 in every BackendState (only the human form exits 1 when logged out).
      if (o.statusStdoutOverride !== undefined) return { status: 1, stdout: o.statusStdoutOverride, stderr: o.statusStderr ?? '' };
      return { status: 0, stdout: statusDoc(), stderr: o.statusStderr ?? '' };
    }
    if (joined === `${ts} serve status --json`) return { status: 0, stdout: serveDoc(), stderr: '' };
    if (argv[0] === 'sudo' && argv[1] === ts && argv[2] === 'set') return { status: o.setOperatorStatus ?? 0, stdout: '', stderr: o.setOperatorStatus ? 'set: permission denied' : '' };
    if ((argv[0] === 'sudo' && argv[1] === ts && argv[2] === 'up') || (argv[0] === ts && argv[1] === 'up')) { state = o.afterUp ?? 'Running'; return { status: 0, stdout: '', stderr: '' }; }
    if (argv[0] === ts && (argv[1] === 'serve' || argv[1] === 'funnel') && argv[2] === '--bg') {
      if (o.publishStatus !== undefined && o.publishStatus !== 0) return { status: o.publishStatus, stdout: '', stderr: o.publishStderr ?? 'boom' };
      if (o.publishNoop) return { status: 0, stdout: '', stderr: '' };
      for (const k of Object.keys(handlers)) delete handlers[Number(k)];
      handlers[Number(argv[3])] = o.publishedFunnel ?? (argv[1] === 'funnel');
      return { status: 0, stdout: '', stderr: '' };
    }
    if (argv[0] === ts && argv[2] === '--https=443' && argv[3] === 'off') {
      for (const k of Object.keys(handlers)) delete handlers[Number(k)];
      return { status: 0, stdout: '', stderr: '' };
    }
    if (argv[0] === 'open') return { status: 0, stdout: '', stderr: '' };
    // systemd (user)
    if (joined === 'systemctl --user is-system-running') return { status: o.userBusStatus ?? 0, stdout: o.userBusStatus === undefined ? 'running\n' : '', stderr: '' };
    if (joined.startsWith('systemctl --user restart')) { serviceStarted = true; return { status: 0, stdout: '', stderr: '' }; }
    if (joined.startsWith('systemctl --user disable --now')) { serviceStarted = false; return { status: 0, stdout: '', stderr: '' }; }
    if (joined.startsWith('systemctl --user is-active')) return { status: serviceStarted ? 0 : 3, stdout: `${o.serviceActive ?? (serviceStarted ? 'active' : 'inactive')}\n`, stderr: '' };
    // launchd
    if (joined.startsWith('launchctl load')) { serviceStarted = true; return { status: 0, stdout: '', stderr: '' }; }
    if (joined.startsWith('launchctl unload')) { const was = serviceStarted; serviceStarted = false; return { status: was ? 0 : 113, stdout: '', stderr: was ? '' : 'not loaded' }; }
    if (joined.startsWith('launchctl print')) return serviceStarted ? { status: 0, stdout: 'state = running\n', stderr: '' } : { status: 113, stdout: '', stderr: 'Could not find service' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const deps: McpExposeDeps = {
    platform: 'linux', env: { HOME: home, USER: 'alice-example', PATH: '/usr/bin' }, home, user: 'alice-example', uid: 1000,
    serveDir, gbrainEnvFile: join(home, '.gbrain', 'env'), plistPath: join(home, 'LaunchAgents', 'com.gbrain.serve.plist'), unitPath: join(home, '.config', 'systemd', 'user', 'gbrain-serve.service'),
    loadConfig: () => ({ engine: 'pglite', database_path: join(home, 'brain.pglite') } as never), executionEnv: 'local', run,
    which: (n) => (n === 'tailscale' ? TS : n === 'systemctl' ? '/usr/bin/systemctl' : n === 'gbrain' ? '/usr/local/bin/gbrain' : null),
    fileExists: (p) => p === ts || existsSync(p),
    fetch: async (url) => {
      fetches.push(url);
      if (url.startsWith('http://127.0.0.1:')) {
        if (o.localListeningBefore) return { ok: true, status: 200 };
        if (serviceStarted && (o.localHealthyAfterStart ?? true)) return { ok: true, status: 200 };
        throw new Error('ECONNREFUSED');
      }
      if (url.startsWith(`https://${DNS}/`)) { if (o.tailnetHealthy ?? true) return { ok: true, status: 200 }; throw new Error('cert pending'); }
      throw new Error(`unexpected fetch ${url}`);
    },
    isTTY: false, prompt: async () => { throw new Error('prompt must not be called'); },
    stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l),
    now: () => new Date('2026-06-01T12:00:00.000Z'), sleep: async () => {},
    gbrainCommand: ['/usr/local/bin/gbrain'], runtimeDir: '/home/alice-example/.bun/bin', randomHex: () => TOKEN,
    localHealthMs: 3, tailnetHealthMs: 3, healthIntervalMs: 1,
  };
  return { run, calls, recorded, fetches, stdout, stderr, deps, home, serveDir, stopService: () => { serviceStarted = false; } };
}

/** A darwin fake: app-bundle binary (no PATH hit), launchd target, brew present. */
function fakeMac(o: TailnetOpts = {}): Fake {
  const f = fakeTailnet({ ...o, binary: APP_TS });
  f.deps.platform = 'darwin';
  f.deps.uid = 501;
  f.deps.which = (n) => (n === 'brew' ? '/opt/homebrew/bin/brew' : n === 'gbrain' ? '/usr/local/bin/gbrain' : null);
  f.deps.fileExists = (p) => p === APP_TS || existsSync(p);
  return f;
}

const jsonDoc = (f: Fake) => { expect(f.stdout).toHaveLength(1); return JSON.parse(f.stdout[0]); };
const checkOf = (doc: { checks: { name: string; status: string; detail: string }[] }, name: string) => doc.checks.find(c => c.name === name);
const joinedCalls = (f: Fake) => f.calls.map(c => c.join(' '));
const readAll = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else out[p] = readFileSync(p, 'utf-8'); } };
  if (existsSync(dir)) walk(dir);
  return out;
};

describe('dispatch + argument shape', () => {
  test('expose is engine-free in mcpNeedsEngine', () => {
    expect(mcpNeedsEngine(['expose'])).toBe(false);
    expect(mcpNeedsEngine(['expose', '--status'])).toBe(false);
    expect(mcpNeedsEngine(['expose', '--funnel', '--yes'])).toBe(false);
    expect(mcpNeedsEngine(['grant', 'x'])).toBe(true);
  });
  test('help text carries every flag literal and names verify.local / verify.tailnet; --help exits 0 on stdout', async () => {
    for (const flag of ['--port', '--funnel', '--surface', '--enable-dcr', '--no-tailscale', '--no-service', '--no-install', '--force', '--dry-run', '--yes', '--json', '--status', '--remove']) expect(MCP_EXPOSE_HELP).toContain(flag);
    expect(MCP_EXPOSE_HELP).toContain('verify.local');
    expect(MCP_EXPOSE_HELP).toContain('verify.tailnet');
    expect(MCP_EXPOSE_HELP).not.toMatch(/service, verify, receipt/);
    const f = fakeTailnet();
    expect(await runMcpExpose(['--help'], f.deps)).toBe(0);
    expect(f.stdout.join('\n')).toContain('gbrain mcp expose --status');
  });
  test('unknown, duplicate, exclusive and malformed flags fail loud (exit 1, JSON envelope under --json)', async () => {
    expect(() => parseExposeArgs(['--bogus'])).toThrow('Unknown setup argument');
    expect(() => parseExposeArgs(['--status', '--remove'])).toThrow('Conflicting');
    expect(() => parseExposeArgs(['--funnel', '--no-tailscale'])).toThrow('Conflicting');
    expect(() => parseExposeArgs(['--dry-run', '--status'])).toThrow('Conflicting');
    expect(() => parseExposeArgs(['--port', '70000'])).toThrow('invalid --port');
    expect(() => parseExposeArgs(['--port'])).toThrow('requires a value');
    expect(() => parseExposeArgs(['--surface', 'huge'])).toThrow('invalid --surface');
    expect(() => parseExposeArgs(['--yes', '--yes'])).toThrow('Duplicate');
    expect(parseExposeArgs(['--port', '4000', '--funnel', '--surface', 'verbs'])).toMatchObject({ port: 4000, funnel: true, surface: 'verbs', enableDcr: false });
    const f = fakeTailnet();
    expect(await runMcpExpose(['--bogus', '--json'], f.deps)).toBe(1);
    expect(jsonDoc(f)).toMatchObject({ status: 'error', reason: 'invalid_arguments' });
    expect(f.stderr.join('\n')).toContain('gbrain mcp expose --help');
  });
  test('runMcp dispatches expose: --help prints MCP_EXPOSE_HELP (exit verdict untouched); --bogus --json yields invalid_arguments + verdict 1', async () => {
    const savedExitCode = process.exitCode;
    const out: string[] = [];
    const err: string[] = [];
    const outSpy = spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { out.push(String(chunk)); return true; }) as never);
    const errSpy = spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { err.push(String(chunk)); return true; }) as never);
    try {
      _resetCliExitVerdictForTests();
      await runMcp(['expose', '--help']);
      expect(out.join('')).toContain(MCP_EXPOSE_HELP);
      expect(currentExitCode()).toBe(0);
      out.length = 0;
      await runMcp(['expose', '--bogus', '--json']);
      const doc = JSON.parse(out.join('').trim());
      expect(doc).toMatchObject({ status: 'error', reason: 'invalid_arguments' });
      expect(err.join('')).toContain('gbrain mcp expose --help');
      expect(currentExitCode()).toBe(1);
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
      _resetCliExitVerdictForTests();
      // Bun keeps a non-zero exitCode when it is set back to undefined; the mirror
      // write from setCliExitVerdict(1) would otherwise fail this whole test run.
      process.exitCode = savedExitCode ?? 0;
    }
  });
});

describe('plan + consent', () => {
  test('--dry-run --json prints a plan, exits 0, mutates nothing and never publishes', async () => {
    const f = fakeTailnet();
    expect(await runMcpExpose(['--dry-run', '--json'], f.deps)).toBe(0);
    const doc = jsonDoc(f);
    expect(doc.status).toBe('planned');
    expect(doc.receipt).toBeNull();
    expect(checkOf(doc, 'plan')?.status).toBe('planned');
    expect(doc.plan.join('\n')).toContain('engine pglite');
    expect(doc.plan.join('\n')).toContain('systemd user unit');
    expect(existsSync(f.serveDir)).toBe(false);
    expect(existsSync(f.deps.unitPath!)).toBe(false);
    expect(joinedCalls(f).some(c => c.includes('--bg') || c.includes('restart') || c.includes(' up'))).toBe(false);
    expect(f.fetches).toEqual([]);
    expect(f.stderr.join('\n')).toContain('Plan');
  });
  test('non-interactive without --yes → exit 2 confirmation_required and no changes', async () => {
    const f = fakeTailnet();
    expect(await runMcpExpose(['--json'], f.deps)).toBe(2);
    const doc = jsonDoc(f);
    expect(doc).toMatchObject({ status: 'pending', reason: 'confirmation_required' });
    expect(doc.next_actions).toContain('gbrain mcp expose --yes');
    expect(existsSync(f.serveDir)).toBe(false);
    expect(joinedCalls(f).some(c => c.includes('--bg'))).toBe(false);
  });
  test('interactive decline → status pending, exit 2, reason declined, nothing changed; interactive yes proceeds', async () => {
    const f = fakeTailnet();
    f.deps.isTTY = true;
    f.deps.prompt = async () => 'n';
    expect(await runMcpExpose(['--json'], f.deps)).toBe(2);
    const doc = jsonDoc(f);
    expect(doc).toMatchObject({ status: 'pending', reason: 'declined', message: 'Nothing changed. Re-run with --yes to confirm.' });
    expect(checkOf(doc, 'consent')?.status).toBe('pending');
    expect(existsSync(f.serveDir)).toBe(false);
    expect(joinedCalls(f).some(c => c.includes('--bg'))).toBe(false);
    const g = fakeTailnet();
    g.deps.isTTY = true;
    g.deps.prompt = async () => 'y';
    expect(await runMcpExpose([], g.deps)).toBe(0);
    expect(existsSync(receiptPath(g.serveDir))).toBe(true);
  });
  test('thin client → exit 1 with run-on-the-brain-host guidance', async () => {
    const f = fakeTailnet();
    f.deps.loadConfig = () => ({ engine: 'postgres', remote_mcp: { url: 'https://brain.example.com/mcp' } } as never);
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(1);
    expect(jsonDoc(f)).toMatchObject({ status: 'error', reason: 'thin_client' });
  });
});

describe('tailscale steps', () => {
  test('missing binary + --no-install → exit 1 with the install plan printed', async () => {
    const f = fakeTailnet();
    f.deps.which = (n) => (n === 'systemctl' ? '/usr/bin/systemctl' : null);
    f.deps.fileExists = () => false;
    expect(await runMcpExpose(['--yes', '--no-install', '--json'], f.deps)).toBe(1);
    const doc = jsonDoc(f);
    expect(doc).toMatchObject({ status: 'error', reason: 'tailscale_missing' });
    expect(checkOf(doc, 'tailscale.binary')?.detail).toContain('curl -fsSL https://tailscale.com/install.sh | sh');
    expect(f.stderr.join('\n')).toContain('Install:');
    expect(joinedCalls(f).some(c => c.startsWith('sh -c'))).toBe(false);
  });
  test('unsupported platform without brew → exit 1 with the download URL', async () => {
    const f = fakeTailnet();
    f.deps.platform = 'darwin';
    f.deps.which = () => null;
    f.deps.fileExists = () => false;
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(1);
    expect(jsonDoc(f)).toMatchObject({ reason: 'tailscale_unsupported_platform' });
    expect(f.stderr.join('\n')).toContain('https://tailscale.com/download');
  });
  test('install path: the binary appears only after the installer argv ran → tailscale.binary says installed:, run continues', async () => {
    const f = fakeTailnet();
    let installed = false;
    const inner = f.deps.run!;
    f.deps.run = async (argv, o) => {
      if (argv[0] === 'sh' && argv[1] === '-c' && argv[2].includes('tailscale.com/install.sh')) { installed = true; f.calls.push(argv); f.recorded.push({ argv, opts: o }); return { status: 0, stdout: '', stderr: '' }; }
      return inner(argv, o);
    };
    f.deps.which = (n) => (n === 'tailscale' ? (installed ? TS : null) : n === 'systemctl' ? '/usr/bin/systemctl' : n === 'gbrain' ? '/usr/local/bin/gbrain' : null);
    f.deps.fileExists = (p) => (p === TS ? installed : existsSync(p));
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(0);
    const doc = jsonDoc(f);
    expect(checkOf(doc, 'tailscale.binary')?.detail).toContain(`installed: ${TS}`);
    const inst = f.recorded.find(r => r.argv[0] === 'sh')!;
    expect(inst.opts).toMatchObject({ inherit: true, stdoutToStderr: true });
    expect(joinedCalls(f).indexOf(`sh -c curl -fsSL https://tailscale.com/install.sh | sh`)).toBeLessThan(joinedCalls(f).indexOf(`${TS} serve --bg 3131`));
  });
  test('install path: installer exits non-zero → tailscale_install_failed, nothing published', async () => {
    const f = fakeTailnet();
    const inner = f.deps.run!;
    f.deps.run = async (argv, o) => (argv[0] === 'sh' ? { status: 1, stdout: '', stderr: 'curl: (6) Could not resolve host' } : inner(argv, o));
    f.deps.which = (n) => (n === 'systemctl' ? '/usr/bin/systemctl' : null);
    f.deps.fileExists = () => false;
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(1);
    const doc = jsonDoc(f);
    expect(doc).toMatchObject({ status: 'error', reason: 'tailscale_install_failed' });
    expect(checkOf(doc, 'tailscale.binary')?.detail).toContain('exited 1');
    expect(joinedCalls(f).some(c => c.includes('--bg'))).toBe(false);
    expect(existsSync(receiptPath(f.serveDir))).toBe(false);
  });
  test('NeedsLogin → set --operator (non-fatal) then a FLAGLESS sudo up; still not Running → exit 2 with the re-run command', async () => {
    const f = fakeTailnet({ backendState: 'NeedsLogin', afterUp: 'NeedsLogin', setOperatorStatus: 1 });
    expect(await runMcpExpose(['--yes', '--funnel', '--json'], f.deps)).toBe(2);
    const doc = jsonDoc(f);
    expect(doc).toMatchObject({ status: 'pending', reason: 'tailscale_login_pending' });
    const calls = joinedCalls(f);
    expect(calls).toContain(`sudo ${TS} set --operator=alice-example`);
    expect(calls).toContain(`sudo ${TS} up`);
    expect(calls.indexOf(`sudo ${TS} set --operator=alice-example`)).toBeLessThan(calls.indexOf(`sudo ${TS} up`));
    expect(calls.some(c => c.includes('up --operator'))).toBe(false);
    expect(f.stderr.join('\n')).toContain('sudo tailscale set --operator=alice-example');
    expect(doc.next_actions).toContain(`sudo ${TS} up`);
    expect(doc.next_actions).toContain('gbrain mcp expose --funnel --yes');
    expect(existsSync(receiptPath(f.serveDir))).toBe(false);
  });
  test('NeedsLogin → up succeeds → continues to a full publish', async () => {
    const f = fakeTailnet({ backendState: 'NeedsLogin' });
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(0);
    expect(checkOf(jsonDoc(f), 'tailscale.login')?.detail).toContain('signed in just now');
  });
  test('login runner opts: inherit, stdoutToStderr under --json, timeoutMs from GBRAIN_TAILSCALE_LOGIN_TIMEOUT_MS', async () => {
    const f = fakeTailnet({ backendState: 'NeedsLogin' });
    f.deps.env = { ...f.deps.env, GBRAIN_TAILSCALE_LOGIN_TIMEOUT_MS: '1234' };
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(0);
    const up = f.recorded.find(r => r.argv[0] === 'sudo' && r.argv[2] === 'up')!;
    expect(up.opts).toEqual({ inherit: true, stdoutToStderr: true, timeoutMs: 1234 });
    const setOp = f.recorded.find(r => r.argv[0] === 'sudo' && r.argv[2] === 'set')!;
    expect(setOp.opts).toMatchObject({ inherit: true, stdoutToStderr: true });
    // non-json: stdout stays the terminal's
    const g = fakeTailnet({ backendState: 'NeedsLogin' });
    expect(await runMcpExpose(['--yes'], g.deps)).toBe(0);
    expect(g.recorded.find(r => r.argv[0] === 'sudo' && r.argv[2] === 'up')!.opts).toEqual({ inherit: true, stdoutToStderr: false, timeoutMs: 300_000 });
    // the non-interactive probes never inherit
    for (const r of g.recorded.filter(r => r.argv.includes('--json'))) expect(r.opts?.inherit).toBeUndefined();
  });
  test('daemon not running → exit 2 with the platform start hint', async () => {
    const f = fakeTailnet({ statusStdoutOverride: '', statusStderr: 'failed to connect to local Tailscale service; is Tailscale running?' });
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(2);
    const doc = jsonDoc(f);
    expect(doc).toMatchObject({ reason: 'tailscale_daemon_not_running' });
    expect(doc.next_actions).toContain('sudo systemctl enable --now tailscaled');
  });
  test('no MagicDNS name → exit 1 pointing at the DNS admin page', async () => {
    const f = fakeTailnet({ dnsName: null });
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(1);
    expect(jsonDoc(f)).toMatchObject({ reason: 'tailscale_no_dns_name' });
    expect(joinedCalls(f).some(c => c.includes('--bg'))).toBe(false);
  });
  test('pre-check: empty CertDomains → exit 2 tailscale_https_not_enabled, admin URL, and NO serve argv at all', async () => {
    const f = fakeTailnet({ certDomains: [] });
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(2);
    const doc = jsonDoc(f);
    expect(doc).toMatchObject({ status: 'pending', reason: 'tailscale_https_not_enabled' });
    expect(doc.message).toContain(TAILSCALE_ADMIN_DNS_URL);
    expect(doc.message).toContain('gbrain mcp expose --yes');
    expect(checkOf(doc, 'tailscale.identity')?.status).toBe('pending');
    expect(checkOf(doc, 'tailscale.publish')).toBeUndefined();
    expect(joinedCalls(f).some(c => c.includes('--bg') || c.includes('serve status'))).toBe(false);
    expect(existsSync(f.serveDir)).toBe(false);
    expect(doc.next_actions.join('\n')).toContain(TAILSCALE_ADMIN_DNS_URL);
  });
  test('pre-check: --funnel with funnelCapable=false → exit 2 tailscale_funnel_not_enabled with the ACL URL + KB link; capability absent → proceeds', async () => {
    const f = fakeTailnet({ funnelCapable: false });
    expect(await runMcpExpose(['--yes', '--funnel', '--json'], f.deps)).toBe(2);
    const doc = jsonDoc(f);
    expect(doc).toMatchObject({ status: 'pending', reason: 'tailscale_funnel_not_enabled' });
    expect(doc.message).toContain(TAILSCALE_ADMIN_ACL_URL);
    expect(doc.message).toContain(TAILSCALE_FUNNEL_KB_URL);
    expect(joinedCalls(f).some(c => c.includes('--bg'))).toBe(false);
    // tailnet-only publish does not care about the funnel capability
    const g = fakeTailnet({ funnelCapable: false });
    expect(await runMcpExpose(['--yes', '--json'], g.deps)).toBe(0);
    // capability present → funnel proceeds
    const h = fakeTailnet({ funnelCapable: true });
    expect(await runMcpExpose(['--yes', '--funnel', '--json'], h.deps)).toBe(0);
    expect(joinedCalls(h)).toContain(`${TS} funnel --bg 3131`);
    // field absent (older CLI) → proceeds and says the publish step decides
    const i = fakeTailnet();
    expect(await runMcpExpose(['--yes', '--funnel', '--json'], i.deps)).toBe(0);
    expect(checkOf(jsonDoc(i), 'tailscale.identity')?.detail).toContain('publish step decides');
  });
  test('publish failure is classified: https_not_enabled surfaces the admin URL, exit 1', async () => {
    const f = fakeTailnet({ publishStatus: 1, publishStderr: 'error: HTTPS certificates are not enabled for this tailnet; enable them in the admin console' });
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(1);
    const doc = jsonDoc(f);
    expect(doc.reason).toBe('tailscale_https_not_enabled');
    expect(doc.message).toContain(TAILSCALE_ADMIN_DNS_URL);
    expect(checkOf(doc, 'tailscale.publish')?.detail).toContain('https_not_enabled');
    expect(existsSync(receiptPath(f.serveDir))).toBe(false);
  });
  test('funnel_not_enabled → ACL admin URL', async () => {
    const f = fakeTailnet({ publishStatus: 1, publishStderr: 'Funnel is not enabled on your tailnet policy (node attribute funnel missing)' });
    expect(await runMcpExpose(['--yes', '--funnel', '--json'], f.deps)).toBe(1);
    expect(jsonDoc(f).message).toContain('https://login.tailscale.com/admin/acls');
  });
  test('publish timeout (status null) → tailscale_unknown with a run-it-by-hand hint', async () => {
    const f = fakeTailnet({ publishStatus: null, publishStderr: '\n(timed out after 60000ms)' });
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(1);
    const doc = jsonDoc(f);
    expect(doc.reason).toBe('tailscale_unknown');
    expect(doc.message).toContain('did not finish within 60s');
    expect(doc.message).toContain('Run it by hand');
    expect(doc.next_actions).toContain('tailscale serve --bg 3131');
    const pub = f.recorded.find(r => r.argv[1] === 'serve' && r.argv[2] === '--bg')!;
    expect(pub.opts?.timeoutMs).toBe(60_000);
  });
  test('tailscale_publish_unconfirmed when --bg exits 0 but no handler appears', async () => {
    const f = fakeTailnet({ publishNoop: true });
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(1);
    const doc = jsonDoc(f);
    expect(doc.reason).toBe('tailscale_publish_unconfirmed');
    expect(checkOf(doc, 'tailscale.publish')?.detail).toContain('exited 0 but serve status shows no / handler');
    expect(existsSync(receiptPath(f.serveDir))).toBe(false);
  });
  test('funnel mismatch after publish → tailscale.publish warns with the off command, run still completes', async () => {
    const f = fakeTailnet({ publishedFunnel: true });
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(0);
    const doc = jsonDoc(f);
    const c = checkOf(doc, 'tailscale.publish')!;
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('funnel=true (wanted false)');
    expect(f.stderr.join('\n')).toContain('tailscale funnel --https=443 off');
  });
  test('a foreign :443 handler is refused without --force (next action is serve status, never --force) and taken over with it', async () => {
    const f = fakeTailnet({ existingHandlers: { 8080: false } });
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(1);
    const doc = jsonDoc(f);
    expect(doc.reason).toBe('foreign_serve_config');
    expect(doc.message).toContain('tailscale serve already proxies :443 to');
    expect(doc.message).toContain('http://127.0.0.1:8080');
    expect(doc.message).toContain('--force');
    expect(doc.next_actions).toEqual(['tailscale serve status']);
    expect(doc.next_actions.join('\n')).not.toContain('--force');
    expect(joinedCalls(f).some(c => c.includes('--bg'))).toBe(false);
    const g = fakeTailnet({ existingHandlers: { 8080: false } });
    expect(await runMcpExpose(['--yes', '--force', '--json'], g.deps)).toBe(0);
    expect(joinedCalls(g)).toContain(`${TS} serve --bg 3131`);
  });
  test('a foreground serve session in another terminal is refused even with --force', async () => {
    const f = fakeTailnet();
    const inner = f.deps.run!;
    f.deps.run = async (argv, o) => {
      if (argv.join(' ') === `${TS} serve status --json`) {
        f.calls.push(argv);
        return { status: 0, stdout: JSON.stringify({ Foreground: { '42': { Web: { [`${DNS}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9000' } } } } } } }), stderr: '' };
      }
      return inner(argv, o);
    };
    expect(await runMcpExpose(['--yes', '--force', '--json'], f.deps)).toBe(1);
    const doc = jsonDoc(f);
    expect(doc.reason).toBe('foreign_serve_config');
    expect(doc.message).toContain('foreground');
    expect(doc.message).toContain('stop it there');
    expect(joinedCalls(f).some(c => c.includes('--bg'))).toBe(false);
  });
  test('the claimed exemption: receipt for 3131 + handler for 3131, re-run with --port 4000 republishes without --force', async () => {
    const f = fakeTailnet({ existingHandlers: { 3131: false } });
    writeExposeReceipt(receiptPath(f.serveDir), { version: 1, port: 3131, public_url: `https://${DNS}`, mode: 'tailnet', service: { state: 'skipped' } } as ExposeReceipt);
    expect(await runMcpExpose(['--yes', '--port', '4000', '--json'], f.deps)).toBe(0);
    expect(joinedCalls(f)).toContain(`${TS} serve --bg 4000`);
    expect(readExposeReceipt(receiptPath(f.serveDir))?.port).toBe(4000);
  });
  test('switching our own handler from funnel to tailnet turns funnel off first', async () => {
    const f = fakeTailnet({ existingHandlers: { 3131: true } });
    writeExposeReceipt(receiptPath(f.serveDir), { version: 1, port: 3131, public_url: `https://${DNS}`, mode: 'funnel', service: { state: 'skipped' } } as ExposeReceipt);
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(0);
    const calls = joinedCalls(f);
    expect(calls.indexOf(`${TS} funnel --https=443 off`)).toBeLessThan(calls.indexOf(`${TS} serve --bg 3131`));
    expect(calls.some(c => c.includes('reset'))).toBe(false);
    expect(readExposeReceipt(receiptPath(f.serveDir))?.mode).toBe('tailnet');
  });
});

describe('happy path: linux-systemd', () => {
  test('publishes, mints the token, installs the service (enable + restart), verifies, writes the receipt — no secret in any generated file', async () => {
    const f = fakeTailnet();
    mkdirSync(join(f.home, '.gbrain'), { recursive: true });
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(0);
    const doc = jsonDoc(f);
    expect(doc.status).toBe('exposed');
    for (const name of ['plan', 'consent', 'tailscale.binary', 'tailscale.login', 'tailscale.identity', 'tailscale.publish', 'admin_token', 'service', 'verify.local', 'verify.tailnet', 'receipt']) {
      expect(checkOf(doc, name)?.status).toBe('ok');
    }
    // receipt
    const receipt = readExposeReceipt(receiptPath(f.serveDir))!;
    expect(receipt).toMatchObject({
      version: 1, port: 3131, public_url: `https://${DNS}`, mcp_url: `https://${DNS}/mcp`, admin_url: `https://${DNS}/admin`, mode: 'tailnet', surface: 'full', enable_dcr: false,
      tailscale: { binary: TS, dns_name: DNS, tailscale_version: '1.80.0' },
      service: { target: 'linux-systemd', unit_path: f.deps.unitPath, plist_path: null, wrapper_path: wrapperPath(f.serveDir), state: 'running' },
      admin_token_file: adminTokenPath(f.serveDir), engine: 'pglite',
    });
    expect(receipt.created_at).toBe('2026-06-01T12:00:00.000Z');
    expect(doc.receipt).toEqual(receipt);
    // permissions
    expect(statSync(receiptPath(f.serveDir)).mode & 0o777).toBe(0o600);
    expect(statSync(adminTokenPath(f.serveDir)).mode & 0o777).toBe(0o600);
    expect(statSync(wrapperPath(f.serveDir)).mode & 0o777).toBe(0o755);
    expect(readFileSync(adminTokenPath(f.serveDir), 'utf-8').trim()).toBe(TOKEN);
    // no token literal anywhere except the token file; nothing printed either
    const files = { ...readAll(f.serveDir), ...readAll(join(f.home, '.config')) };
    for (const [path, content] of Object.entries(files)) if (path !== adminTokenPath(f.serveDir)) expect(content).not.toContain(TOKEN);
    expect(f.stdout.join('\n')).not.toContain(TOKEN);
    expect(f.stderr.join('\n')).not.toContain(TOKEN);
    // wrapper + unit shape
    const wrapper = readFileSync(wrapperPath(f.serveDir), 'utf-8');
    expect(wrapper).toContain(`GBRAIN_ADMIN_BOOTSTRAP_TOKEN="$(cat '${adminTokenPath(f.serveDir)}')"`);
    expect(wrapper).toContain(`serve --http --port 3131 --public-url https://${DNS} --surface full`);
    expect(wrapper).not.toContain('export GBRAIN_HOME');
    expect(readFileSync(f.deps.unitPath!, 'utf-8')).toContain(`ExecStart=${wrapperPath(f.serveDir)}`);
    // exec ledger: enable + restart (a reinstall relaunches the regenerated wrapper), never enable --now
    const calls = joinedCalls(f);
    expect(calls).toContain(`${TS} serve --bg 3131`);
    expect(calls).toContain('systemctl --user daemon-reload');
    expect(calls).toContain('systemctl --user enable gbrain-serve.service');
    expect(calls).toContain('systemctl --user restart gbrain-serve.service');
    expect(calls.indexOf('systemctl --user enable gbrain-serve.service')).toBeLessThan(calls.indexOf('systemctl --user restart gbrain-serve.service'));
    expect(calls.some(c => c.includes('--now'))).toBe(false);
    expect(calls).toContain('loginctl enable-linger');
    expect(calls.some(c => c.includes('funnel'))).toBe(false);
    expect(f.fetches).toContain('http://127.0.0.1:3131/health');
    expect(f.fetches).toContain(`https://${DNS}/health`);
    // human summary on stderr (json mode)
    const prose = f.stderr.join('\n');
    expect(prose).toContain('GBrain MCP server published on your tailnet');
    expect(prose).toContain(`MCP URL   https://${DNS}/mcp`);
    expect(prose).toContain('PGLite (single-writer)');
    expect(prose).toContain('fail with `live_serve`');
    expect(prose).not.toContain('wait on this server');
    expect(prose).toContain('gbrain mcp expose --status');
    expect(doc.next_actions.join('\n')).toContain(`--url https://${DNS}/mcp`);
  });
  test('PGLite banner: local agents get the pre-mint + --token guidance and the scoped grant path, never a bare bootstrap harness', async () => {
    const f = fakeTailnet();
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(0);
    const doc = jsonDoc(f);
    const prose = f.stderr.join('\n');
    expect(prose).toContain('gbrain auth create local-agents --scopes read,write');
    expect(prose).toContain('gbrain bootstrap harness --yes --port 3131 --token <value>');
    expect(prose).toContain(`gbrain mcp grant local-agents --harness <id> --profile memory-writer --source default --url http://127.0.0.1:3131/mcp --admin-token-file`);
    expect(prose).toContain('gbrain connect http://127.0.0.1:3131/mcp --harness <id> --credentials-file /private/local-agents.json --install');
    const actions: string[] = doc.next_actions;
    expect(actions.some(a => a.startsWith('gbrain bootstrap harness --yes --port 3131 --token'))).toBe(true);
    expect(actions).not.toContain('gbrain bootstrap harness --yes --port 3131');
    expect(actions.some(a => a.includes('--url http://127.0.0.1:3131/mcp --admin-token-file'))).toBe(true);
  });
  test('Postgres banner: plain bootstrap harness, no pre-mint talk', async () => {
    const f = fakeTailnet();
    f.deps.loadConfig = () => ({ engine: 'postgres', database_url: 'postgres://alice-example@localhost/brain' } as never);
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(0);
    const doc = jsonDoc(f);
    expect(doc.receipt.engine).toBe('postgres');
    const prose = f.stderr.join('\n');
    expect(prose).toContain('Local agents     gbrain bootstrap harness --yes --port 3131');
    expect(prose).not.toContain('auth create');
    expect(prose).not.toContain('--token <value>');
    expect(prose).toContain('Engine    Postgres');
    expect(doc.next_actions).toContain('gbrain bootstrap harness --yes --port 3131');
  });
  test('--funnel publishes via funnel, bakes GBRAIN_HOME + surface + DCR, and the summary says public', async () => {
    const f = fakeTailnet();
    f.deps.env = { ...f.deps.env, GBRAIN_HOME: join(f.home, 'custom') };
    expect(await runMcpExpose(['--yes', '--funnel', '--port', '4000', '--surface', 'verbs', '--enable-dcr'], f.deps)).toBe(0);
    expect(joinedCalls(f)).toContain(`${TS} funnel --bg 4000`);
    const receipt = readExposeReceipt(receiptPath(f.serveDir))!;
    expect(receipt).toMatchObject({ mode: 'funnel', port: 4000, surface: 'verbs', enable_dcr: true });
    const wrapper = readFileSync(wrapperPath(f.serveDir), 'utf-8');
    expect(wrapper).toContain(`export GBRAIN_HOME='${join(f.home, 'custom')}'`);
    expect(wrapper).toContain('--port 4000 --public-url https://your-machine.your-tailnet.ts.net --surface verbs --enable-dcr');
    expect(f.stdout.join('\n')).toContain('public (Funnel)');
    expect(f.stdout.join('\n')).toContain('bootstrap harness --yes --port 4000');
  });
  test('tailnet health pending → exit 2, status pending, receipt still written', async () => {
    const f = fakeTailnet({ tailnetHealthy: false });
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(2);
    const doc = jsonDoc(f);
    expect(doc).toMatchObject({ status: 'pending', reason: 'tailnet_health_pending' });
    expect(checkOf(doc, 'verify.tailnet')?.status).toBe('pending');
    expect(existsSync(receiptPath(f.serveDir))).toBe(true);
    expect(f.stderr.join('\n')).toContain('re-run `gbrain mcp expose --status` in a minute');
  });
  test('local health timeout → exit 2 local_health_timeout, verify.local warn, verify.tailnet skipped', async () => {
    const f = fakeTailnet({ localHealthyAfterStart: false });
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(2);
    const doc = jsonDoc(f);
    expect(doc).toMatchObject({ status: 'pending', reason: 'local_health_timeout' });
    expect(checkOf(doc, 'verify.local')).toMatchObject({ status: 'warn' });
    expect(checkOf(doc, 'verify.local')?.detail).toContain('timeout');
    expect(checkOf(doc, 'verify.tailnet')).toMatchObject({ status: 'skipped', detail: 'local server not confirmed yet' });
    expect(f.fetches.some(u => u.startsWith('https://'))).toBe(false);
    expect(f.stderr.join('\n')).toContain('did not answer within');
    expect(existsSync(receiptPath(f.serveDir))).toBe(true);
  });
  test('re-running with an existing receipt keeps created_at and is not a foreign listener', async () => {
    const f = fakeTailnet();
    expect(await runMcpExpose(['--yes'], f.deps)).toBe(0);
    const first = readExposeReceipt(receiptPath(f.serveDir))!;
    f.deps.now = () => new Date('2026-06-02T00:00:00.000Z');
    f.stdout.length = 0;
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(0);
    const second = readExposeReceipt(receiptPath(f.serveDir))!;
    expect(second.created_at).toBe(first.created_at);
    expect(second.updated_at).toBe('2026-06-02T00:00:00.000Z');
    expect(checkOf(jsonDoc(f), 'admin_token')?.detail).toContain('reused');
  });
});

describe('happy path: darwin (launchd, app-bundle CLI)', () => {
  test('login pending → "Open the Tailscale app" guidance, plain `<app> up`, no sudo', async () => {
    const f = fakeMac({ backendState: 'NeedsLogin', afterUp: 'NeedsLogin' });
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(2);
    const doc = jsonDoc(f);
    expect(doc).toMatchObject({ status: 'pending', reason: 'tailscale_login_pending' });
    expect(doc.message).toContain('Open the Tailscale app and sign in');
    expect(doc.next_actions).toContain('Open the Tailscale app and sign in');
    expect(joinedCalls(f)).toContain(`${APP_TS} up`);
    expect(joinedCalls(f).some(c => c.startsWith('sudo'))).toBe(false);
    expect(checkOf(doc, 'tailscale.binary')?.detail).toBe(APP_TS);
  });
  test('launchd happy path: plist written 0644, unload then load, state running, receipt target macos', async () => {
    const f = fakeMac();
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(0);
    const doc = jsonDoc(f);
    expect(doc.status).toBe('exposed');
    expect(doc.receipt.service).toMatchObject({ target: 'macos', plist_path: f.deps.plistPath, unit_path: null, state: 'running' });
    expect(existsSync(f.deps.plistPath!)).toBe(true);
    expect(statSync(f.deps.plistPath!).mode & 0o777).toBe(0o644);
    expect(readFileSync(f.deps.plistPath!, 'utf-8')).toContain(`<string>${wrapperPath(f.serveDir)}</string>`);
    const calls = joinedCalls(f);
    expect(calls.indexOf(`launchctl unload ${f.deps.plistPath}`)).toBeLessThan(calls.indexOf(`launchctl load ${f.deps.plistPath}`));
    expect(calls).toContain('launchctl print gui/501/com.gbrain.serve');
    expect(calls.some(c => c.startsWith('systemctl'))).toBe(false);
    expect(f.stderr.join('\n')).toContain('launchd com.gbrain.serve, running');
  });
  test('brew install path: after the cask, `open -a Tailscale` runs (non-fatal) and the run sleeps before the first status read', async () => {
    const f = fakeMac();
    let installed = false;
    const slept: number[] = [];
    f.deps.sleep = async (ms) => { slept.push(ms); };
    const inner = f.deps.run!;
    f.deps.run = async (argv, o) => {
      if (argv[0] === 'brew') { installed = true; f.calls.push(argv); f.recorded.push({ argv, opts: o }); return { status: 0, stdout: '', stderr: '' }; }
      if (argv[0] === 'open') { f.calls.push(argv); return { status: 1, stdout: '', stderr: 'LSOpenURLsWithRole() failed' }; }
      return inner(argv, o);
    };
    f.deps.fileExists = (p) => (p === APP_TS ? installed : existsSync(p));
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(0);
    const calls = joinedCalls(f);
    const brewAt = calls.indexOf('brew install --cask tailscale-app');
    const openAt = calls.indexOf('open -a Tailscale');
    const statusAt = calls.indexOf(`${APP_TS} status --json`);
    expect(brewAt).toBeGreaterThanOrEqual(0);
    expect(openAt).toBeGreaterThan(brewAt);
    expect(statusAt).toBeGreaterThan(openAt);
    expect(slept.some(ms => ms >= 1000)).toBe(true);
    expect(checkOf(jsonDoc(f), 'tailscale.binary')?.detail).toContain(`installed: ${APP_TS}`);
  });
});

describe('service edge cases', () => {
  test('a foreign listener on the port is refused BEFORE any serve --bg; --no-service publishes only', async () => {
    const f = fakeTailnet({ localListeningBefore: true });
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(1);
    const doc = jsonDoc(f);
    expect(doc.reason).toBe('foreign_listener');
    expect(doc.message).toContain('A server already listens on 127.0.0.1:3131');
    expect(doc.next_actions).toContain('gbrain mcp expose --yes --no-service');
    expect(joinedCalls(f).some(c => c.includes('--bg'))).toBe(false);
    expect(joinedCalls(f).some(c => c.includes('serve status'))).toBe(false);
    expect(checkOf(doc, 'tailscale.publish')).toBeUndefined();
    expect(existsSync(wrapperPath(f.serveDir))).toBe(false);
    expect(existsSync(f.deps.unitPath!)).toBe(false);
    expect(existsSync(adminTokenPath(f.serveDir))).toBe(false);
    const g = fakeTailnet({ localListeningBefore: true });
    expect(await runMcpExpose(['--yes', '--no-service', '--json'], g.deps)).toBe(0);
    const gdoc = jsonDoc(g);
    expect(checkOf(gdoc, 'service')?.status).toBe('skipped');
    expect(checkOf(gdoc, 'verify.local')?.status).toBe('ok');
    expect(readExposeReceipt(receiptPath(g.serveDir))?.service.state).toBe('skipped');
    expect(joinedCalls(g).some(c => c.startsWith('systemctl --user enable') || c.startsWith('systemctl --user restart'))).toBe(false);
  });
  test('a listener on a DIFFERENT port than the receipt is foreign; the receipt port itself is ours', async () => {
    const f = fakeTailnet({ localListeningBefore: true });
    writeExposeReceipt(receiptPath(f.serveDir), { version: 1, port: 3131, public_url: `https://${DNS}`, mode: 'tailnet', service: { state: 'skipped' } } as ExposeReceipt);
    expect(await runMcpExpose(['--yes', '--port', '4000', '--json'], f.deps)).toBe(1);
    expect(jsonDoc(f).reason).toBe('foreign_listener');
    const g = fakeTailnet({ localListeningBefore: true });
    writeExposeReceipt(receiptPath(g.serveDir), { version: 1, port: 3131, public_url: `https://${DNS}`, mode: 'tailnet', service: { state: 'skipped' } } as ExposeReceipt);
    expect(await runMcpExpose(['--yes', '--json'], g.deps)).toBe(0);
  });
  test('--no-service with nothing listening skips the local wait and says so', async () => {
    const f = fakeTailnet();
    expect(await runMcpExpose(['--yes', '--no-service', '--json'], f.deps)).toBe(0);
    const doc = jsonDoc(f);
    expect(checkOf(doc, 'verify.local')?.status).toBe('skipped');
    expect(checkOf(doc, 'verify.tailnet')?.status).toBe('skipped');
    expect(f.stderr.join('\n')).toContain('Nothing listens on 127.0.0.1:3131 yet');
  });
  test('--no-service re-run after a full install keeps the service block and does not rewrite the wrapper', async () => {
    const f = fakeTailnet();
    expect(await runMcpExpose(['--yes'], f.deps)).toBe(0);
    const before = readExposeReceipt(receiptPath(f.serveDir))!;
    expect(before.service.state).toBe('running');
    writeFileSync(wrapperPath(f.serveDir), '#!/bin/bash\n# sentinel: hand-edited\nexit 0\n');
    f.calls.length = 0;
    f.stdout.length = 0;
    expect(await runMcpExpose(['--yes', '--no-service', '--json'], f.deps)).toBe(0);
    const doc = jsonDoc(f);
    const after = readExposeReceipt(receiptPath(f.serveDir))!;
    expect(after.service).toEqual(before.service);
    expect(readFileSync(wrapperPath(f.serveDir), 'utf-8')).toContain('sentinel: hand-edited');
    expect(checkOf(doc, 'service')?.detail).toContain('kept as is');
    expect(checkOf(doc, 'verify.local')?.status).toBe('ok');
    expect(joinedCalls(f).some(c => c.startsWith('systemctl --user enable') || c.startsWith('systemctl --user restart') || c.startsWith('systemctl --user daemon-reload'))).toBe(false);
    expect(f.stderr.join('\n')).toContain('(kept, --no-service)');
  });
  test('no user bus (cloud sandbox) → manual service: wrapper written, foreground + nohup lines, exit 0', async () => {
    const f = fakeTailnet();
    f.deps.executionEnv = 'cloud-sandbox';
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(0);
    const doc = jsonDoc(f);
    expect(checkOf(doc, 'service')?.detail).toContain('manual');
    expect(checkOf(doc, 'verify.local')?.status).toBe('skipped');
    expect(existsSync(wrapperPath(f.serveDir))).toBe(true);
    expect(existsSync(f.deps.unitPath!)).toBe(false);
    expect(f.stderr.join('\n')).toContain('nohup');
    expect(doc.receipt.service).toMatchObject({ target: 'none', state: 'manual' });
    expect(joinedCalls(f).some(c => c.startsWith('systemctl'))).toBe(false);
  });
  test('--no-tailscale skips every tailscale step and keeps the server on loopback', async () => {
    const f = fakeTailnet();
    expect(await runMcpExpose(['--yes', '--no-tailscale', '--json'], f.deps)).toBe(0);
    const doc = jsonDoc(f);
    for (const name of ['tailscale.binary', 'tailscale.login', 'tailscale.identity', 'tailscale.publish']) expect(checkOf(doc, name)?.status).toBe('skipped');
    expect(doc.receipt.public_url).toBe('http://127.0.0.1:3131');
    expect(joinedCalls(f).some(c => c.startsWith(TS))).toBe(false);
  });
  test('service install failure → exit 1 service_install_failed, but a receipt (service stopped) is kept so --status/--remove can clean up', async () => {
    const f = fakeTailnet();
    const inner = f.deps.run!;
    f.deps.run = async (argv, o) => (argv.join(' ').startsWith('systemctl --user restart') ? { status: 1, stdout: '', stderr: 'Job for gbrain-serve.service failed' } : inner(argv, o));
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(1);
    const doc = jsonDoc(f);
    expect(doc).toMatchObject({ status: 'error', reason: 'service_install_failed' });
    const receipt = readExposeReceipt(receiptPath(f.serveDir))!;
    expect(receipt.service).toMatchObject({ target: 'linux-systemd', state: 'stopped', unit_path: f.deps.unitPath });
    expect(receipt.port).toBe(3131);
    expect(doc.receipt).toEqual(receipt);
    expect(doc.next_actions).toContain('gbrain mcp expose --remove --yes');
    // --remove sees it and clears the published handler
    f.calls.length = 0;
    f.stdout.length = 0;
    expect(await runMcpExpose(['--remove', '--yes', '--json'], f.deps)).toBe(0);
    expect(joinedCalls(f)).toContain(`${TS} serve --https=443 off`);
    expect(existsSync(receiptPath(f.serveDir))).toBe(false);
  });
  test('a symlinked token path is refused → structured error, nothing published', async () => {
    const f = fakeTailnet();
    mkdirSync(f.serveDir, { recursive: true });
    const victim = join(f.home, 'victim');
    writeFileSync(victim, 'keep\n');
    symlinkSync(victim, adminTokenPath(f.serveDir));
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(1);
    const doc = jsonDoc(f);
    expect(doc).toMatchObject({ status: 'error', reason: 'mcp_expose_failed' });
    expect(doc.message).toContain('symlink');
    expect(readFileSync(victim, 'utf-8')).toBe('keep\n');
    expect(existsSync(receiptPath(f.serveDir))).toBe(false);
  });
});

describe('--status', () => {
  test('without a receipt: human exit 0, --json exit 2 not_exposed', async () => {
    const f = fakeTailnet();
    expect(await runMcpExpose(['--status'], f.deps)).toBe(0);
    expect(f.stdout.join('\n')).toContain('not exposed');
    const g = fakeTailnet();
    expect(await runMcpExpose(['--status', '--json'], g.deps)).toBe(2);
    expect(jsonDoc(g)).toMatchObject({ status: 'not_exposed', reason: 'not_exposed' });
  });
  test('after a publish: everything verifies → exit 0; a vanished handler → exit 1', async () => {
    const f = fakeTailnet();
    expect(await runMcpExpose(['--yes'], f.deps)).toBe(0);
    f.stdout.length = 0;
    expect(await runMcpExpose(['--status', '--json'], f.deps)).toBe(0);
    const doc = jsonDoc(f);
    expect(doc.status).toBe('exposed');
    for (const name of ['receipt', 'tailscale.publish', 'service', 'verify.local', 'verify.tailnet']) expect(checkOf(doc, name)?.status).toBe('ok');
    // knock the handler out from under us
    await f.run([TS, 'serve', '--https=443', 'off']);
    f.stdout.length = 0;
    expect(await runMcpExpose(['--status', '--json'], f.deps)).toBe(1);
    const bad = jsonDoc(f);
    expect(bad.status).toBe('error');
    expect(checkOf(bad, 'tailscale.publish')?.status).toBe('fail');
    expect(bad.next_actions).toContain('gbrain mcp expose --yes');
  });
  test('a stopped service → service check fails, exit 1', async () => {
    const f = fakeTailnet();
    expect(await runMcpExpose(['--yes'], f.deps)).toBe(0);
    f.stopService();
    f.stdout.length = 0;
    expect(await runMcpExpose(['--status', '--json'], f.deps)).toBe(1);
    const doc = jsonDoc(f);
    expect(doc).toMatchObject({ status: 'error', reason: 'status_unhealthy' });
    expect(checkOf(doc, 'service')).toMatchObject({ status: 'fail' });
    expect(checkOf(doc, 'service')?.detail).toContain('stopped');
    expect(checkOf(doc, 'tailscale.publish')?.status).toBe('ok');
  });
  test('tailnet certificate still pending → status pending, exit 1 (only a full verify exits 0)', async () => {
    const f = fakeTailnet({ tailnetHealthy: false });
    expect(await runMcpExpose(['--yes'], f.deps)).toBe(2);
    f.stdout.length = 0;
    expect(await runMcpExpose(['--status', '--json'], f.deps)).toBe(1);
    const doc = jsonDoc(f);
    expect(doc).toMatchObject({ status: 'pending', reason: 'tailnet_health_pending' });
    expect(checkOf(doc, 'verify.tailnet')?.status).toBe('pending');
    expect(checkOf(doc, 'verify.local')?.status).toBe('ok');
  });
});

describe('--remove', () => {
  test('stops the service, turns off ONLY our handler (funnel first), deletes wrapper + receipt, keeps token + Tailscale', async () => {
    const f = fakeTailnet();
    expect(await runMcpExpose(['--yes', '--funnel'], f.deps)).toBe(0);
    f.calls.length = 0;
    f.stdout.length = 0;
    expect(await runMcpExpose(['--remove', '--json'], f.deps)).toBe(2); // consent needed
    expect(jsonDoc(f)).toMatchObject({ status: 'pending', reason: 'confirmation_required' });
    expect(existsSync(receiptPath(f.serveDir))).toBe(true);
    f.stdout.length = 0;
    expect(await runMcpExpose(['--remove', '--yes', '--json'], f.deps)).toBe(0);
    const doc = jsonDoc(f);
    expect(doc.status).toBe('removed');
    const calls = joinedCalls(f);
    expect(calls).toContain('systemctl --user disable --now gbrain-serve.service');
    expect(calls).toContain(`${TS} funnel --https=443 off`);
    expect(calls.some(c => /reset|logout|uninstall|down/.test(c))).toBe(false);
    expect(calls.some(c => c.startsWith('sh -c') || c.startsWith('sudo'))).toBe(false);
    expect(existsSync(wrapperPath(f.serveDir))).toBe(false);
    expect(existsSync(receiptPath(f.serveDir))).toBe(false);
    expect(existsSync(f.deps.unitPath!)).toBe(false);
    expect(existsSync(adminTokenPath(f.serveDir))).toBe(true);
    expect(f.stderr.join('\n')).toContain('Tailscale itself (installed and signed in)');
    expect(f.stderr.join('\n')).toContain('admin token');
  });
  test('tailnet-mode --remove turns off with `serve --https=443 off` (no funnel off)', async () => {
    const f = fakeTailnet();
    expect(await runMcpExpose(['--yes'], f.deps)).toBe(0);
    f.calls.length = 0;
    f.stdout.length = 0;
    expect(await runMcpExpose(['--remove', '--yes', '--json'], f.deps)).toBe(0);
    const calls = joinedCalls(f);
    expect(calls).toContain(`${TS} serve --https=443 off`);
    expect(calls.some(c => c.includes('funnel'))).toBe(false);
    expect(checkOf(jsonDoc(f), 'tailscale.publish')?.detail).toContain('serve off: exit 0');
  });
  test('--remove with a FOREIGN port on :443 issues no `--https=443 off` and reports nothing to turn off', async () => {
    const f = fakeTailnet({ existingHandlers: { 8080: false } });
    writeExposeReceipt(receiptPath(f.serveDir), {
      version: 1, created_at: 'x', updated_at: 'x', port: 3131, public_url: `https://${DNS}`, mcp_url: `https://${DNS}/mcp`, admin_url: `https://${DNS}/admin`,
      mode: 'tailnet', surface: 'full', enable_dcr: false, tailscale: { binary: TS, dns_name: DNS, tailscale_version: '1.80.0' },
      service: { target: 'linux-systemd', unit_path: null, plist_path: null, wrapper_path: wrapperPath(f.serveDir), state: 'skipped' },
      admin_token_file: adminTokenPath(f.serveDir), engine: 'pglite',
    });
    expect(await runMcpExpose(['--remove', '--yes', '--json'], f.deps)).toBe(0);
    const doc = jsonDoc(f);
    expect(doc.status).toBe('removed');
    expect(joinedCalls(f).some(c => c.includes('--https=443 off'))).toBe(false);
    expect(checkOf(doc, 'tailscale.publish')?.detail).toContain('nothing to turn off');
    // the foreign handler is untouched
    const view = await f.run([TS, 'serve', 'status', '--json']);
    expect(view.stdout).toContain('http://127.0.0.1:8080');
  });
  test('interactive decline on --remove → status pending, exit 2, reason declined, receipt untouched', async () => {
    const f = fakeTailnet();
    expect(await runMcpExpose(['--yes'], f.deps)).toBe(0);
    f.calls.length = 0;
    f.stdout.length = 0;
    f.deps.isTTY = true;
    f.deps.prompt = async () => 'no';
    expect(await runMcpExpose(['--remove', '--json'], f.deps)).toBe(2);
    const doc = jsonDoc(f);
    expect(doc).toMatchObject({ status: 'pending', reason: 'declined', message: 'Nothing changed. Re-run with --yes to confirm.' });
    expect(checkOf(doc, 'consent')?.status).toBe('pending');
    expect(existsSync(receiptPath(f.serveDir))).toBe(true);
    expect(joinedCalls(f).some(c => c.includes('disable') || c.includes('off'))).toBe(false);
  });
  test('--remove --force also deletes the token; a second --remove is a no-op exit 0', async () => {
    const f = fakeTailnet();
    expect(await runMcpExpose(['--yes'], f.deps)).toBe(0);
    expect(await runMcpExpose(['--remove', '--yes', '--force'], f.deps)).toBe(0);
    expect(existsSync(adminTokenPath(f.serveDir))).toBe(false);
    f.stdout.length = 0;
    expect(await runMcpExpose(['--remove', '--yes', '--json'], f.deps)).toBe(0);
    expect(jsonDoc(f)).toMatchObject({ status: 'not_exposed' });
  });
  test('--remove on a manual (no supervisor) receipt names the leftover process and touches no systemctl', async () => {
    const f = fakeTailnet();
    f.deps.executionEnv = 'cloud-sandbox';
    expect(await runMcpExpose(['--yes'], f.deps)).toBe(0);
    f.calls.length = 0;
    expect(await runMcpExpose(['--remove', '--yes'], f.deps)).toBe(0);
    expect(joinedCalls(f).some(c => c.startsWith('systemctl'))).toBe(false);
    expect(f.stdout.join('\n')).toContain('manually started server process');
  });
  test('--remove removes a service that exists even when the receipt says skipped (defensive probe)', async () => {
    const f = fakeTailnet();
    expect(await runMcpExpose(['--yes'], f.deps)).toBe(0);
    // Rewrite the receipt as if the last run had been --no-service on an older build that dropped the block.
    const receipt = readExposeReceipt(receiptPath(f.serveDir))!;
    writeExposeReceipt(receiptPath(f.serveDir), { ...receipt, service: { ...receipt.service, unit_path: null, state: 'skipped' } });
    f.calls.length = 0;
    f.stdout.length = 0;
    expect(await runMcpExpose(['--remove', '--yes', '--json'], f.deps)).toBe(0);
    const doc = jsonDoc(f);
    expect(joinedCalls(f)).toContain('systemctl --user disable --now gbrain-serve.service');
    expect(existsSync(f.deps.unitPath!)).toBe(false);
    expect(checkOf(doc, 'service')?.status).toBe('ok');
    expect(f.stderr.join('\n')).toContain('receipt says no service was installed');
  });
});

describe('never a stack trace', () => {
  test('an exploding dependency becomes a structured error, exit 1', async () => {
    const f = fakeTailnet();
    f.deps.run = async () => { throw new Error('spawn exploded'); };
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(1);
    const doc = jsonDoc(f);
    expect(doc).toMatchObject({ status: 'error', reason: 'mcp_expose_failed' });
    expect(doc.message).toContain('spawn exploded');
  });
  test('a broken existing receipt is treated as absent (unreadable JSON never crashes --status)', async () => {
    const f = fakeTailnet();
    mkdirSync(f.serveDir, { recursive: true });
    writeFileSync(receiptPath(f.serveDir), '{not json');
    expect(await runMcpExpose(['--status'], f.deps)).toBe(0);
    expect(f.stdout.join('\n')).toContain('not exposed');
  });
});
