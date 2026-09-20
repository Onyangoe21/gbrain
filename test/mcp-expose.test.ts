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
    // launchd (modern, domain-explicit verbs; the legacy load/unload pair is never expected here)
    if (joined.startsWith('launchctl bootstrap gui/')) { serviceStarted = true; return { status: 0, stdout: '', stderr: '' }; }
    if (joined.startsWith('launchctl bootout gui/')) { const was = serviceStarted; serviceStarted = false; return { status: was ? 0 : 3, stdout: '', stderr: was ? '' : 'Boot-out failed: 3: No such process' }; }
    if (joined.startsWith('launchctl load') || joined.startsWith('launchctl unload')) return { status: 64, stdout: '', stderr: 'legacy verb: not expected' };
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
/** A complete receipt for `f` (the shape a real run writes — the reader refuses partial ones); `over` patches top-level fields. */
const fullReceipt = (f: Fake, over: Partial<ExposeReceipt> = {}): ExposeReceipt => ({
  version: 1, created_at: '2026-05-01T00:00:00.000Z', updated_at: '2026-05-01T00:00:00.000Z', port: 3131,
  public_url: `https://${DNS}`, mcp_url: `https://${DNS}/mcp`, admin_url: `https://${DNS}/admin`, mode: 'tailnet', surface: 'full', enable_dcr: false,
  tailscale: { binary: TS, dns_name: DNS, tailscale_version: '1.80.0' },
  service: { target: 'linux-systemd', unit_path: null, plist_path: null, wrapper_path: wrapperPath(f.serveDir), state: 'skipped' },
  admin_token_file: adminTokenPath(f.serveDir), engine: 'pglite',
  ...over,
});

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
    writeExposeReceipt(receiptPath(f.serveDir), fullReceipt(f));
    expect(await runMcpExpose(['--yes', '--port', '4000', '--json'], f.deps)).toBe(0);
    expect(joinedCalls(f)).toContain(`${TS} serve --bg 4000`);
    expect(readExposeReceipt(receiptPath(f.serveDir))?.port).toBe(4000);
  });
  test('switching our own handler from funnel to tailnet turns funnel off first', async () => {
    const f = fakeTailnet({ existingHandlers: { 3131: true } });
    writeExposeReceipt(receiptPath(f.serveDir), fullReceipt(f, { mode: 'funnel' }));
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
  test('launchd happy path: plist written 0644, bootout gui/<uid> then bootstrap gui/<uid>, state running, receipt target macos', async () => {
    const f = fakeMac();
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(0);
    const doc = jsonDoc(f);
    expect(doc.status).toBe('exposed');
    expect(doc.receipt.service).toMatchObject({ target: 'macos', plist_path: f.deps.plistPath, unit_path: null, state: 'running' });
    expect(existsSync(f.deps.plistPath!)).toBe(true);
    expect(statSync(f.deps.plistPath!).mode & 0o777).toBe(0o644);
    expect(readFileSync(f.deps.plistPath!, 'utf-8')).toContain(`<string>${wrapperPath(f.serveDir)}</string>`);
    const calls = joinedCalls(f);
    expect(calls.indexOf(`launchctl bootout gui/501 ${f.deps.plistPath}`)).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf(`launchctl bootout gui/501 ${f.deps.plistPath}`)).toBeLessThan(calls.indexOf(`launchctl bootstrap gui/501 ${f.deps.plistPath}`));
    expect(calls.some(c => c.startsWith('launchctl load') || c.startsWith('launchctl unload'))).toBe(false);
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
    expect(doc.message).toContain('Something already answers on 127.0.0.1:3131');
    expect(doc.message).toContain('If this is a gbrain server left behind by an interrupted `gbrain mcp expose`, run `gbrain mcp expose --remove --yes` first.');
    expect(doc.next_actions).toContain('gbrain mcp expose --yes --no-service');
    expect(doc.next_actions).toContain('gbrain mcp expose --remove --yes');
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
    writeExposeReceipt(receiptPath(f.serveDir), fullReceipt(f));
    expect(await runMcpExpose(['--yes', '--port', '4000', '--json'], f.deps)).toBe(1);
    expect(jsonDoc(f).reason).toBe('foreign_listener');
    const g = fakeTailnet({ localListeningBefore: true });
    writeExposeReceipt(receiptPath(g.serveDir), fullReceipt(g));
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

describe('engine detection + summary variants', () => {
  test('no brain config (null or a throwing loadConfig) → refused as no_brain_config before consent (a service would crash-loop); --no-service still publishes with engine unknown; bare engine hints resolve', async () => {
    for (const cfg of [() => null, () => { throw new Error('config unreadable'); }, () => ({})]) {
      const f = fakeTailnet();
      f.deps.loadConfig = cfg as never;
      expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(1);
      const doc = jsonDoc(f);
      expect(doc).toMatchObject({ status: 'error', reason: 'no_brain_config' });
      expect(doc.message).toBe('No brain is configured on this host (gbrain init first), so a service would only crash-loop; pass --no-service to publish a server you run yourself.');
      expect(checkOf(doc, 'plan')).toMatchObject({ status: 'fail' });
      expect(checkOf(doc, 'plan')?.detail).toContain('REFUSED: no brain is configured on this host');
      expect(checkOf(doc, 'consent')).toBeUndefined();
      expect(doc.next_actions).toContain('gbrain init');
      expect(doc.next_actions).toContain('gbrain mcp expose --yes --no-service');
      expect(joinedCalls(f).some(c => c.includes('--bg') || c.startsWith('systemctl --user enable'))).toBe(false);
      expect(f.fetches).toEqual([]);
      expect(existsSync(f.serveDir)).toBe(false);
    }
    // --no-service: the operator runs the server themselves → allowed, engine recorded as unknown with the init hint
    const g = fakeTailnet();
    g.deps.loadConfig = () => null;
    expect(await runMcpExpose(['--yes', '--no-service', '--json'], g.deps)).toBe(0);
    const gdoc = jsonDoc(g);
    expect(gdoc.receipt.engine).toBe('unknown');
    expect(checkOf(gdoc, 'plan')?.status).toBe('ok');
    expect(g.stderr.join('\n')).toContain('unknown (no brain config found');
    expect(gdoc.next_actions).toContain('gbrain bootstrap harness --yes --port 3131');
    expect(g.stderr.join('\n')).not.toContain('auth create');
    // --dry-run still prints the plan (with the refusal marked) and exits 0
    const h = fakeTailnet();
    h.deps.loadConfig = () => null;
    expect(await runMcpExpose(['--dry-run', '--json'], h.deps)).toBe(0);
    const hdoc = jsonDoc(h);
    expect(hdoc.status).toBe('planned');
    expect(checkOf(hdoc, 'plan')?.status).toBe('planned');
    expect(hdoc.plan.join('\n')).toContain('engine unknown');
    expect(hdoc.plan.join('\n')).toContain('WOULD BE REFUSED: no brain is configured on this host');
    const planOf = async (cfg: () => unknown, extra: string[] = []) => {
      const i = fakeTailnet();
      i.deps.loadConfig = cfg as never;
      expect(await runMcpExpose(['--dry-run', '--json', ...extra], i.deps)).toBe(0);
      return jsonDoc(i).plan.join('\n') as string;
    };
    expect(await planOf(() => { throw new Error('config unreadable'); })).toContain('engine unknown');
    expect(await planOf(() => ({ engine: 'postgres' }))).toContain('engine postgres');
    expect(await planOf(() => ({ engine: 'postgres' }))).not.toContain('REFUSED');
    expect(await planOf(() => ({ engine: 'pglite' }))).toContain('engine pglite');
    expect(await planOf(() => ({}))).toContain('engine unknown');
    expect(await planOf(() => null, ['--no-service'])).not.toContain('REFUSED');
  });
  test('the re-run hint re-renders every non-default publish flag (never --yes/--json); a non-JSON argument error goes to stderr only', async () => {
    const f = fakeTailnet();
    expect(await runMcpExpose(['--port', '4000', '--surface', 'verbs', '--enable-dcr', '--no-install', '--no-service', '--json'], f.deps)).toBe(2);
    expect(jsonDoc(f).next_actions).toContain('gbrain mcp expose --port 4000 --surface verbs --enable-dcr --no-service --no-install --yes');
    const g = fakeTailnet();
    expect(await runMcpExpose(['--no-tailscale', '--json'], g.deps)).toBe(2);
    expect(jsonDoc(g).next_actions).toContain('gbrain mcp expose --no-tailscale --yes');
    const h = fakeTailnet();
    expect(await runMcpExpose(['--dry-run', '--remove'], h.deps)).toBe(1);
    expect(h.stdout).toEqual([]);
    expect(h.stderr.join('\n')).toContain('Conflicting setup arguments: --dry-run and --remove');
    expect(h.stderr.join('\n')).toContain('gbrain mcp expose --help');
  });
});

describe('service target + state edges', () => {
  test('no systemctl on PATH → manual target without probing; a dead user bus → manual too (probe bounded to 3s); a service that is not running after install → warn', async () => {
    const f = fakeTailnet();
    f.deps.which = (n) => (n === 'tailscale' ? TS : n === 'gbrain' ? '/usr/local/bin/gbrain' : null);
    expect(await runMcpExpose(['--dry-run', '--json'], f.deps)).toBe(0);
    expect(jsonDoc(f).plan.join('\n')).toContain('Service   manual — no user supervisor in this environment (no user bus)');
    expect(joinedCalls(f).some(c => c.startsWith('systemctl'))).toBe(false);
    const g = fakeTailnet({ userBusStatus: 1 });
    expect(await runMcpExpose(['--yes', '--json'], g.deps)).toBe(0);
    const gdoc = jsonDoc(g);
    expect(joinedCalls(g)).toContain('systemctl --user is-system-running');
    expect(g.recorded.find(r => r.argv.join(' ') === 'systemctl --user is-system-running')!.opts?.timeoutMs).toBe(3_000);
    expect(gdoc.receipt.service).toMatchObject({ target: 'none', state: 'manual' });
    expect(joinedCalls(g).some(c => c.startsWith('systemctl --user enable'))).toBe(false);
    const h = fakeTailnet({ serviceActive: 'inactive' });
    expect(await runMcpExpose(['--yes', '--json'], h.deps)).toBe(0);
    const hdoc = jsonDoc(h);
    expect(checkOf(hdoc, 'service')).toMatchObject({ status: 'warn' });
    expect(checkOf(hdoc, 'service')?.detail).toContain('gbrain-serve.service, stopped');
    expect(hdoc.receipt.service.state).toBe('stopped');
    expect(f.stderr.join('\n')).not.toContain(TOKEN);
  });
  test('health polling follows the wall clock (an advancing `now` ends the budget long before the attempt cap) and a non-2xx answer is unhealthy', async () => {
    // Budget 100ms, interval 10ms → the attempt cap alone would allow 10 probes. pollHealth reads the
    // clock once for the deadline, then twice per attempt (remaining, left); each read advances `step`.
    //   step 30: deadline T+130 → probe@60, left 40 → sleep → probe@120, left -20 → exits on `left <= 0`  (2 poll probes)
    //   step 40: deadline T+140 → probe@80, left 20 → sleep → remaining@160 = -20 → exits on `attempt > 0 && remaining <= 0` (1 poll probe)
    for (const [step, pollProbes] of [[30, 2], [40, 1]] as const) {
      const f = fakeTailnet();
      let t = Date.parse('2026-06-01T12:00:00.000Z');
      f.deps.now = () => new Date((t += step));
      f.deps.localHealthMs = 100;
      f.deps.healthIntervalMs = 10;
      // The plan-step occupancy probe must see a CLOSED port (any answer counts as occupied); the
      // verify polls then get a 503, which is "answering but unhealthy".
      f.deps.fetch = async (url) => {
        f.fetches.push(url);
        if (!url.startsWith('http://127.0.0.1:')) return { ok: true, status: 200 };
        if (f.fetches.filter(u => u === url).length === 1) throw new Error('ECONNREFUSED');
        return { ok: false, status: 503 };
      };
      expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(2);
      const doc = jsonDoc(f);
      expect(doc).toMatchObject({ status: 'pending', reason: 'local_health_timeout' });
      // 1 probe in the plan step (foreign-listener check) + the poll attempts the clock allowed
      expect(f.fetches.filter(u => u === 'http://127.0.0.1:3131/health')).toHaveLength(1 + pollProbes);
      expect(f.fetches.some(u => u.startsWith('https://'))).toBe(false);
      expect(checkOf(doc, 'verify.local')).toMatchObject({ status: 'warn', detail: 'http://127.0.0.1:3131/health: timeout' });
      expect(checkOf(doc, 'verify.tailnet')).toMatchObject({ status: 'skipped', detail: 'local server not confirmed yet' });
    }
  });
});

describe('tailscale binary + login step edges', () => {
  test('status --json without JSON: an operator error → exit 1 tailscale_needs_operator; silence → tailscale_unknown; a killed probe → daemon pending (probe bounded to 15s)', async () => {
    const f = fakeTailnet({ statusStdoutOverride: 'Access denied', statusStderr: 'Access denied: serve requires the operator' });
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(1);
    const doc = jsonDoc(f);
    expect(doc).toMatchObject({ status: 'error', reason: 'tailscale_needs_operator' });
    expect(doc.message).toContain('sudo tailscale set --operator=alice-example');
    expect(checkOf(doc, 'tailscale.login')).toMatchObject({ status: 'fail', detail: 'Access denied: serve requires the operator' });
    expect(joinedCalls(f).some(c => c.includes('--bg') || c.includes(' up'))).toBe(false);
    const g = fakeTailnet({ statusStdoutOverride: '', statusStderr: '' });
    expect(await runMcpExpose(['--yes', '--json'], g.deps)).toBe(1);
    const gdoc = jsonDoc(g);
    expect(gdoc.reason).toBe('tailscale_unknown');
    expect(checkOf(gdoc, 'tailscale.login')?.detail).toBe('tailscale status printed no JSON');
    expect(gdoc.message).toContain('without output');
    const h = fakeTailnet();
    const inner = h.deps.run!;
    h.deps.run = async (argv, o) => {
      if (argv.join(' ') === `${TS} status --json`) { h.recorded.push({ argv, opts: o }); return { status: null, stdout: '', stderr: '\n(timed out after 15000ms)' }; }
      return inner(argv, o);
    };
    expect(await runMcpExpose(['--yes', '--json'], h.deps)).toBe(2);
    const hdoc = jsonDoc(h);
    expect(hdoc).toMatchObject({ status: 'pending', reason: 'tailscale_daemon_not_running' });
    expect(checkOf(hdoc, 'tailscale.login')?.detail).toContain('daemon not running');
    expect(hdoc.next_actions).toEqual(['sudo systemctl enable --now tailscaled', 'gbrain mcp expose --yes']);
    expect(h.recorded.find(r => r.argv.join(' ') === `${TS} status --json`)!.opts?.timeoutMs).toBe(15_000);
  });
  test('installer exits 0 but no binary appears → tailscale_install_failed names the download page', async () => {
    const f = fakeTailnet();
    const inner = f.deps.run!;
    f.deps.run = async (argv, o) => (argv[0] === 'sh' ? { status: 0, stdout: '', stderr: '' } : inner(argv, o));
    f.deps.which = (n) => (n === 'systemctl' ? '/usr/bin/systemctl' : null);
    f.deps.fileExists = () => false;
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(1);
    const doc = jsonDoc(f);
    expect(doc).toMatchObject({ status: 'error', reason: 'tailscale_install_failed' });
    expect(checkOf(doc, 'tailscale.binary')?.detail).toBe('install finished but no binary was found');
    expect(doc.message).toContain('https://tailscale.com/download');
    expect(existsSync(f.serveDir)).toBe(false);
  });
});

describe('publish step edges', () => {
  test('switching our own handler from tailnet to funnel turns the plain serve handler off first; raw TCP forwards and non-proxy handlers are described honestly', async () => {
    const f = fakeTailnet({ existingHandlers: { 3131: false } });
    writeExposeReceipt(receiptPath(f.serveDir), fullReceipt(f));
    expect(await runMcpExpose(['--yes', '--funnel', '--json'], f.deps)).toBe(0);
    const calls = joinedCalls(f);
    expect(calls.indexOf(`${TS} serve --https=443 off`)).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf(`${TS} serve --https=443 off`)).toBeLessThan(calls.indexOf(`${TS} funnel --bg 3131`));
    expect(calls.some(c => c.includes('funnel --https=443 off'))).toBe(false);
    expect(readExposeReceipt(receiptPath(f.serveDir))?.mode).toBe('funnel');
    const serveStatus = (doc: unknown) => async (argv: string[], o: CommandRunOptions | undefined, inner: CommandRunner) =>
      (argv.join(' ') === `${TS} serve status --json` ? { status: 0, stdout: JSON.stringify(doc), stderr: '' } : inner(argv, o));
    const g = fakeTailnet();
    const ginner = g.deps.run!;
    const gview = serveStatus({ TCP: { '443': { TCPForward: '127.0.0.1:5432' } } });
    g.deps.run = (argv, o) => gview(argv, o, ginner);
    expect(await runMcpExpose(['--yes', '--json'], g.deps)).toBe(1);
    const gdoc = jsonDoc(g);
    expect(gdoc.reason).toBe('foreign_serve_config');
    expect(gdoc.message).toContain('*:443/ -> raw TCP forward 127.0.0.1:5432');
    expect(gdoc.message).toContain('--force');
    const h = fakeTailnet();
    const hinner = h.deps.run!;
    const hview = serveStatus({ Web: { [`${DNS}:443`]: { Handlers: { '/': { Path: '/var/www' } } } } });
    h.deps.run = (argv, o) => hview(argv, o, hinner);
    expect(await runMcpExpose(['--yes', '--json'], h.deps)).toBe(1);
    expect(jsonDoc(h).message).toContain(`${DNS}:443/ -> (non-proxy handler)`);
  });
});

describe('--status edges', () => {
  test('after a --no-tailscale publish the tailscale + tailnet checks are skipped; after --no-service the service is reported skipped', async () => {
    const f = fakeTailnet();
    expect(await runMcpExpose(['--yes', '--no-tailscale'], f.deps)).toBe(0);
    f.stdout.length = 0;
    f.calls.length = 0;
    expect(await runMcpExpose(['--status', '--json'], f.deps)).toBe(0);
    const doc = jsonDoc(f);
    expect(doc.status).toBe('exposed');
    expect(checkOf(doc, 'tailscale.publish')).toMatchObject({ status: 'skipped', detail: 'published without Tailscale' });
    expect(checkOf(doc, 'verify.tailnet')).toMatchObject({ status: 'skipped', detail: 'no https public URL' });
    expect(checkOf(doc, 'service')?.status).toBe('ok');
    expect(f.calls.some(c => c[0] === TS)).toBe(false);
    const g = fakeTailnet({ localListeningBefore: true });
    expect(await runMcpExpose(['--yes', '--no-service'], g.deps)).toBe(0);
    g.stdout.length = 0;
    expect(await runMcpExpose(['--status', '--json'], g.deps)).toBe(0);
    const gdoc = jsonDoc(g);
    expect(gdoc.status).toBe('exposed');
    expect(checkOf(gdoc, 'service')).toMatchObject({ status: 'skipped', detail: 'installed with --no-service' });
    expect(joinedCalls(g).some(c => c.startsWith('systemctl --user is-active'))).toBe(false);
  });
  test('a handler whose funnel flag disagrees with the receipt warns (exit 1); a vanished tailscale binary fails the publish check', async () => {
    const f = fakeTailnet();
    expect(await runMcpExpose(['--yes'], f.deps)).toBe(0);
    await f.run([TS, 'funnel', '--bg', '3131']); // someone flipped Funnel on by hand
    f.stdout.length = 0;
    expect(await runMcpExpose(['--status', '--json'], f.deps)).toBe(1);
    const doc = jsonDoc(f);
    expect(doc).toMatchObject({ status: 'error', reason: 'status_unhealthy' });
    expect(checkOf(doc, 'tailscale.publish')).toMatchObject({ status: 'warn' });
    expect(checkOf(doc, 'tailscale.publish')?.detail).toContain('funnel=true; receipt says tailnet');
    const g = fakeTailnet();
    expect(await runMcpExpose(['--yes'], g.deps)).toBe(0);
    g.deps.which = (n) => (n === 'systemctl' ? '/usr/bin/systemctl' : n === 'gbrain' ? '/usr/local/bin/gbrain' : null);
    g.deps.fileExists = (p) => p !== TS && existsSync(p);
    g.stdout.length = 0;
    expect(await runMcpExpose(['--status', '--json'], g.deps)).toBe(1);
    expect(checkOf(jsonDoc(g), 'tailscale.publish')).toMatchObject({ status: 'fail', detail: 'tailscale binary not found' });
  });
});

describe('--remove edges', () => {
  test('binary gone → handler left with a warning; a --no-tailscale receipt has nothing to undo; a skipped receipt with no service → none installed (interactive yes); an undeletable wrapper is a note', async () => {
    const f = fakeTailnet();
    expect(await runMcpExpose(['--yes'], f.deps)).toBe(0);
    f.deps.which = (n) => (n === 'systemctl' ? '/usr/bin/systemctl' : null);
    f.deps.fileExists = (p) => p !== TS && existsSync(p);
    f.stdout.length = 0;
    f.calls.length = 0;
    expect(await runMcpExpose(['--remove', '--yes', '--json'], f.deps)).toBe(0);
    const doc = jsonDoc(f);
    expect(checkOf(doc, 'tailscale.publish')).toMatchObject({ status: 'warn', detail: 'tailscale binary not found; serve handler left as is' });
    expect(f.stderr.join('\n')).toContain('the tailscale serve handler (binary not found)');
    expect(joinedCalls(f).some(c => c.includes('off'))).toBe(false);
    // --no-tailscale receipt
    const g = fakeTailnet();
    expect(await runMcpExpose(['--yes', '--no-tailscale'], g.deps)).toBe(0);
    g.stdout.length = 0;
    g.calls.length = 0;
    expect(await runMcpExpose(['--remove', '--yes', '--json'], g.deps)).toBe(0);
    const gdoc = jsonDoc(g);
    expect(checkOf(gdoc, 'plan')?.detail).toContain('Tailscale nothing to undo');
    expect(checkOf(gdoc, 'tailscale.publish')).toMatchObject({ status: 'skipped', detail: 'published without Tailscale' });
    expect(g.calls.some(c => c[0] === TS)).toBe(false);
    expect(g.stderr.join('\n')).toContain('Left in place: ~/.gbrain/serve/admin-token (admin token; pass --force to delete)');
    expect(g.stderr.join('\n')).not.toContain('Tailscale itself');
    // receipt says skipped, supervisor has nothing, unit file gone → none installed
    const h = fakeTailnet();
    expect(await runMcpExpose(['--yes'], h.deps)).toBe(0);
    const receipt = readExposeReceipt(receiptPath(h.serveDir))!;
    writeExposeReceipt(receiptPath(h.serveDir), { ...receipt, service: { ...receipt.service, unit_path: null, state: 'skipped' } });
    h.stopService();
    rmSync(h.deps.unitPath!);
    h.stdout.length = 0;
    h.calls.length = 0;
    h.deps.isTTY = true;
    h.deps.prompt = async () => 'YES';
    expect(await runMcpExpose(['--remove', '--json'], h.deps)).toBe(0);
    const hdoc = jsonDoc(h);
    expect(checkOf(hdoc, 'consent')?.detail).toBe('confirmed interactively');
    expect(checkOf(hdoc, 'service')).toMatchObject({ status: 'skipped', detail: 'none installed' });
    expect(joinedCalls(h)).toContain('systemctl --user is-active gbrain-serve.service');
    expect(joinedCalls(h).some(c => c.includes('disable'))).toBe(false);
    // a directory where the wrapper was: unlink fails, the run still completes
    const i = fakeTailnet();
    expect(await runMcpExpose(['--yes'], i.deps)).toBe(0);
    rmSync(wrapperPath(i.serveDir));
    mkdirSync(wrapperPath(i.serveDir));
    i.stdout.length = 0;
    expect(await runMcpExpose(['--remove', '--yes', '--json'], i.deps)).toBe(0);
    const idoc = jsonDoc(i);
    expect(idoc.status).toBe('removed');
    expect(i.stderr.join('\n')).toContain(`could not delete ${wrapperPath(i.serveDir)}`);
    expect(checkOf(idoc, 'receipt')?.detail).not.toContain('gbrain-serve.sh');
    expect(existsSync(receiptPath(i.serveDir))).toBe(false);
  });
  test('when `funnel off` only clears the funnel flag, `serve off` follows; a handler that survives both is reported and left in place', async () => {
    const f = fakeTailnet();
    expect(await runMcpExpose(['--yes', '--funnel'], f.deps)).toBe(0);
    const inner = f.deps.run!;
    let funnelOn = true;
    let handlerOn = true;
    f.deps.run = async (argv, o) => {
      const joined = argv.join(' ');
      if (joined === `${TS} serve status --json`) {
        const web = handlerOn ? { [`${DNS}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3131' } } } } : {};
        const allow = funnelOn && handlerOn ? { [`${DNS}:443`]: true } : {};
        return { status: 0, stdout: JSON.stringify({ TCP: { '443': { HTTPS: true } }, Web: web, AllowFunnel: allow }), stderr: '' };
      }
      if (joined === `${TS} funnel --https=443 off`) { f.calls.push(argv); funnelOn = false; return { status: 0, stdout: '', stderr: '' }; }
      if (joined === `${TS} serve --https=443 off`) { f.calls.push(argv); handlerOn = false; return { status: 0, stdout: '', stderr: '' }; }
      return inner(argv, o);
    };
    f.stdout.length = 0;
    f.calls.length = 0;
    expect(await runMcpExpose(['--remove', '--yes', '--json'], f.deps)).toBe(0);
    const doc = jsonDoc(f);
    const calls = joinedCalls(f);
    expect(calls.indexOf(`${TS} funnel --https=443 off`)).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf(`${TS} funnel --https=443 off`)).toBeLessThan(calls.indexOf(`${TS} serve --https=443 off`));
    expect(checkOf(doc, 'tailscale.publish')).toMatchObject({ status: 'ok', detail: 'funnel off: exit 0, serve off: exit 0' });
    const g = fakeTailnet();
    expect(await runMcpExpose(['--yes'], g.deps)).toBe(0);
    const ginner = g.deps.run!;
    g.deps.run = async (argv, o) => (argv[0] === TS && argv[2] === '--https=443' && argv[3] === 'off' ? { status: 1, stdout: '', stderr: 'nope' } : ginner(argv, o));
    g.stdout.length = 0;
    expect(await runMcpExpose(['--remove', '--yes', '--json'], g.deps)).toBe(0);
    const gdoc = jsonDoc(g);
    expect(checkOf(gdoc, 'tailscale.publish')).toMatchObject({ status: 'warn' });
    expect(checkOf(gdoc, 'tailscale.publish')?.detail).toContain('serve off: exit 1');
    expect(checkOf(gdoc, 'tailscale.publish')?.detail).toContain('handler still present');
    expect(g.stderr.join('\n')).toContain('Left in place: the tailscale serve handler;');
    expect(existsSync(receiptPath(g.serveDir))).toBe(false);
  });
  test('darwin: a malformed pre-existing token is regenerated with a note; --remove boots the launchd agent out and deletes the plist', async () => {
    const f = fakeMac();
    mkdirSync(f.serveDir, { recursive: true });
    writeFileSync(adminTokenPath(f.serveDir), 'not-a-token\n');
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(0);
    const doc = jsonDoc(f);
    expect(checkOf(doc, 'admin_token')?.detail).toContain('regenerated');
    expect(f.stderr.join('\n')).toContain('was regenerated');
    expect(readFileSync(adminTokenPath(f.serveDir), 'utf-8').trim()).toBe(TOKEN);
    f.stdout.length = 0;
    f.calls.length = 0;
    expect(await runMcpExpose(['--remove', '--yes', '--json'], f.deps)).toBe(0);
    const rdoc = jsonDoc(f);
    expect(rdoc.status).toBe('removed');
    expect(joinedCalls(f)).toContain(`launchctl bootout gui/501 ${f.deps.plistPath}`);
    expect(joinedCalls(f).some(c => c.startsWith('launchctl unload'))).toBe(false);
    expect(joinedCalls(f).some(c => c.startsWith('systemctl') || c.startsWith('sudo'))).toBe(false);
    expect(existsSync(f.deps.plistPath!)).toBe(false);
    expect(checkOf(rdoc, 'plan')?.detail).toContain('launchd com.gbrain.serve');
    expect(checkOf(rdoc, 'service')?.detail).toContain(f.deps.plistPath!);
    expect(existsSync(adminTokenPath(f.serveDir))).toBe(true);
  });
});

describe('runMcp dispatch regression', () => {
  test('an unknown subcommand names expose in the error (verdict 1); the top-level help lists the expose forms (verdict untouched)', async () => {
    const savedExitCode = process.exitCode;
    const out: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation(((...chunks: unknown[]) => { out.push(chunks.map(String).join(' ')); }) as never);
    try {
      _resetCliExitVerdictForTests();
      await runMcp(['bogus']);
      expect(JSON.parse(out.join('').trim())).toEqual({ status: 'error', reason: 'mcp_setup_failed', message: 'Expected mcp grant, verify, adapters, profiles or expose' });
      expect(currentExitCode()).toBe(1);
      out.length = 0;
      _resetCliExitVerdictForTests();
      await runMcp([]);
      const help = out.join('\n');
      expect(help).toContain('gbrain mcp expose --status [--json]');
      expect(help).toContain('gbrain mcp expose --remove [--yes] [--json]');
      expect(help).toContain('See: gbrain mcp expose --help');
      expect(currentExitCode()).toBe(0);
    } finally {
      logSpy.mockRestore();
      _resetCliExitVerdictForTests();
      process.exitCode = savedExitCode ?? 0;
    }
  });
});

describe('receipt shape guard, rollback, binary + path confinement', () => {
  test('a receipt that passes the old version/port/public_url guard but lacks the service/tailscale blocks is absent: --status not_exposed (exit 2 under --json), --remove nothing to remove (exit 0), no crash', async () => {
    const f = fakeTailnet();
    mkdirSync(f.serveDir, { recursive: true });
    writeFileSync(receiptPath(f.serveDir), JSON.stringify({ version: 1, port: 3131, public_url: `https://${DNS}`, mode: 'tailnet' }));
    expect(await runMcpExpose(['--status', '--json'], f.deps)).toBe(2);
    expect(jsonDoc(f)).toMatchObject({ status: 'not_exposed', reason: 'not_exposed' });
    f.stdout.length = 0;
    expect(await runMcpExpose(['--remove', '--yes', '--json'], f.deps)).toBe(0);
    expect(jsonDoc(f)).toMatchObject({ status: 'not_exposed', reason: 'not_exposed' });
    expect(f.stderr.join('\n')).toContain('nothing to remove');
    // the receipt-less recovery only PROBES (supervisor state, serve status) — it changes nothing when nothing of ours is found
    expect(joinedCalls(f).every(c => c === 'systemctl --user is-system-running' || c === 'systemctl --user is-active gbrain-serve.service' || c === `${TS} serve status --json`)).toBe(true);
    expect(joinedCalls(f)).toContain(`${TS} serve status --json`);
    expect(f.fetches).toEqual([]);
    // the file itself is left alone (it is not ours to delete)
    expect(existsSync(receiptPath(f.serveDir))).toBe(true);
  });
  test('--status on a manual (cloud-sandbox) receipt once the operator started the server → exit 0, service ok (manual), no supervisor probed', async () => {
    const f = fakeTailnet();
    f.deps.executionEnv = 'cloud-sandbox';
    expect(await runMcpExpose(['--yes'], f.deps)).toBe(0);
    f.deps.fetch = async (url) => { f.fetches.push(url); return { ok: true, status: 200 }; };
    f.stdout.length = 0;
    f.calls.length = 0;
    expect(await runMcpExpose(['--status', '--json'], f.deps)).toBe(0);
    const doc = jsonDoc(f);
    expect(doc.status).toBe('exposed');
    expect(checkOf(doc, 'service')).toMatchObject({ status: 'ok' });
    expect(checkOf(doc, 'service')?.detail).toContain('manual');
    expect(checkOf(doc, 'verify.local')?.status).toBe('ok');
    expect(checkOf(doc, 'verify.tailnet')?.status).toBe('ok');
    expect(joinedCalls(f).some(c => c.startsWith('systemctl') || c.startsWith('launchctl'))).toBe(false);
    // check order is fixed regardless of which probe answered first
    expect(doc.checks.map((c: { name: string }) => c.name)).toEqual(['receipt', 'tailscale.publish', 'service', 'verify.local', 'verify.tailnet']);
  });
  test('--status after a service_install_failed partial receipt → exit 1 with the service check failing', async () => {
    const f = fakeTailnet();
    const inner = f.deps.run!;
    f.deps.run = async (argv, o) => (argv.join(' ').startsWith('systemctl --user restart') ? { status: 1, stdout: '', stderr: 'Job for gbrain-serve.service failed' } : inner(argv, o));
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(1);
    expect(jsonDoc(f).reason).toBe('service_install_failed');
    f.stdout.length = 0;
    expect(await runMcpExpose(['--status', '--json'], f.deps)).toBe(1);
    const doc = jsonDoc(f);
    expect(doc).toMatchObject({ status: 'error', reason: 'status_unhealthy' });
    expect(checkOf(doc, 'service')).toMatchObject({ status: 'fail' });
    expect(checkOf(doc, 'service')?.detail).toContain('stopped');
    expect(checkOf(doc, 'tailscale.publish')?.status).toBe('ok');
    expect(doc.next_actions).toContain('gbrain mcp expose --yes');
  });
  test('rollback: a throw after this run published (no handler before) turns the fresh handler off, writes no receipt, exit 1; funnel uses funnel off; a pre-existing handler is left alone', async () => {
    const f = fakeTailnet();
    mkdirSync(f.serveDir, { recursive: true });
    symlinkSync(join(f.home, 'victim'), adminTokenPath(f.serveDir));
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(1);
    const doc = jsonDoc(f);
    expect(doc).toMatchObject({ status: 'error', reason: 'mcp_expose_failed' });
    expect(doc.message).toContain('symlink');
    expect(doc.message).toContain('turned off again');
    expect(doc.message).toContain('no receipt written');
    expect(checkOf(doc, 'rollback')).toMatchObject({ status: 'ok' });
    expect(checkOf(doc, 'rollback')?.detail).toContain('tailscale serve --https=443 off');
    expect(checkOf(doc, 'internal')?.status).toBe('fail');
    const calls = joinedCalls(f);
    expect(calls.indexOf(`${TS} serve --bg 3131`)).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf(`${TS} serve --bg 3131`)).toBeLessThan(calls.indexOf(`${TS} serve --https=443 off`));
    expect(calls.some(c => c.includes('reset'))).toBe(false);
    expect(existsSync(receiptPath(f.serveDir))).toBe(false);
    expect((await f.run([TS, 'serve', 'status', '--json'])).stdout).not.toContain('127.0.0.1:3131');
    // --funnel → funnel off
    const h = fakeTailnet();
    mkdirSync(h.serveDir, { recursive: true });
    symlinkSync(join(h.home, 'victim'), adminTokenPath(h.serveDir));
    expect(await runMcpExpose(['--yes', '--funnel', '--json'], h.deps)).toBe(1);
    expect(joinedCalls(h)).toContain(`${TS} funnel --https=443 off`);
    expect(existsSync(receiptPath(h.serveDir))).toBe(false);
    // a handler for our port existed before this run → left in place, no off at all
    const g = fakeTailnet({ existingHandlers: { 3131: false } });
    mkdirSync(g.serveDir, { recursive: true });
    symlinkSync(join(g.home, 'victim'), adminTokenPath(g.serveDir));
    expect(await runMcpExpose(['--yes', '--json'], g.deps)).toBe(1);
    const gdoc = jsonDoc(g);
    expect(gdoc).toMatchObject({ status: 'error', reason: 'mcp_expose_failed' });
    expect(gdoc.message).toContain('left in place');
    expect(checkOf(gdoc, 'rollback')).toMatchObject({ status: 'skipped' });
    expect(joinedCalls(g)).toContain(`${TS} serve --bg 3131`);
    expect(joinedCalls(g).some(c => c.includes('--https=443 off'))).toBe(false);
    expect(existsSync(receiptPath(g.serveDir))).toBe(false);
    expect((await g.run([TS, 'serve', 'status', '--json'])).stdout).toContain('127.0.0.1:3131');
    // a throw BEFORE publishing (or with --no-tailscale) has nothing to roll back
    const i = fakeTailnet();
    mkdirSync(i.serveDir, { recursive: true });
    symlinkSync(join(i.home, 'victim'), adminTokenPath(i.serveDir));
    expect(await runMcpExpose(['--yes', '--no-tailscale', '--json'], i.deps)).toBe(1);
    const idoc = jsonDoc(i);
    expect(idoc.reason).toBe('mcp_expose_failed');
    expect(checkOf(idoc, 'rollback')).toBeUndefined();
    expect(i.calls.some(c => c[0] === TS)).toBe(false);
  });
  test('a receipt binary that exists but is neither the discovered binary nor a known install location is never executed (--status and --remove); a known candidate is honored', async () => {
    const f = fakeTailnet();
    expect(await runMcpExpose(['--yes'], f.deps)).toBe(0);
    const planted = join(f.home, 'planted-tailscale');
    writeFileSync(planted, '#!/bin/sh\nexit 0\n');
    const receipt = readExposeReceipt(receiptPath(f.serveDir))!;
    writeExposeReceipt(receiptPath(f.serveDir), { ...receipt, tailscale: { ...receipt.tailscale, binary: planted } });
    f.calls.length = 0;
    f.stdout.length = 0;
    expect(await runMcpExpose(['--status', '--json'], f.deps)).toBe(0);
    expect(joinedCalls(f)).toContain(`${TS} serve status --json`);
    expect(f.calls.some(c => c[0] === planted)).toBe(false);
    f.calls.length = 0;
    f.stdout.length = 0;
    expect(await runMcpExpose(['--remove', '--yes', '--json'], f.deps)).toBe(0);
    expect(joinedCalls(f)).toContain(`${TS} serve --https=443 off`);
    expect(f.calls.some(c => c[0] === planted)).toBe(false);
    expect(existsSync(planted)).toBe(true);
    // the macOS app-bundle CLI is not on PATH but IS a known candidate → the recorded path is used
    const g = fakeMac();
    expect(await runMcpExpose(['--yes'], g.deps)).toBe(0);
    expect(readExposeReceipt(receiptPath(g.serveDir))?.tailscale.binary).toBe(APP_TS);
    g.calls.length = 0;
    g.stdout.length = 0;
    expect(await runMcpExpose(['--status', '--json'], g.deps)).toBe(0);
    expect(joinedCalls(g)).toContain(`${APP_TS} serve status --json`);
  });
  test('--remove never unlinks a wrapper or token path outside the serve directory; each is named in "Left in place"', async () => {
    const f = fakeTailnet();
    expect(await runMcpExpose(['--yes'], f.deps)).toBe(0);
    const elsewhere = join(f.home, 'precious.sh');
    writeFileSync(elsewhere, 'keep\n');
    const receipt = readExposeReceipt(receiptPath(f.serveDir))!;
    writeExposeReceipt(receiptPath(f.serveDir), { ...receipt, service: { ...receipt.service, wrapper_path: elsewhere } });
    f.stdout.length = 0;
    expect(await runMcpExpose(['--remove', '--yes', '--json'], f.deps)).toBe(0);
    const doc = jsonDoc(f);
    expect(doc.status).toBe('removed');
    expect(existsSync(elsewhere)).toBe(true);
    expect(readFileSync(elsewhere, 'utf-8')).toBe('keep\n');
    expect(f.stderr.join('\n')).toContain('~/precious.sh (outside the serve directory; not touched)');
    expect(checkOf(doc, 'plan')?.detail).toContain('leave ~/precious.sh (outside the serve directory; not touched)');
    expect(checkOf(doc, 'receipt')?.detail).not.toContain('precious');
    expect(checkOf(doc, 'receipt')?.detail).toContain('expose.json');
    expect(existsSync(receiptPath(f.serveDir))).toBe(false);
    // --force with an out-of-dir token path leaves the token alone too
    const g = fakeTailnet();
    expect(await runMcpExpose(['--yes'], g.deps)).toBe(0);
    const tokenElsewhere = join(g.home, 'token-elsewhere');
    writeFileSync(tokenElsewhere, `${TOKEN}\n`);
    const greceipt = readExposeReceipt(receiptPath(g.serveDir))!;
    writeExposeReceipt(receiptPath(g.serveDir), { ...greceipt, admin_token_file: tokenElsewhere });
    g.stdout.length = 0;
    expect(await runMcpExpose(['--remove', '--yes', '--force', '--json'], g.deps)).toBe(0);
    const gdoc = jsonDoc(g);
    expect(existsSync(tokenElsewhere)).toBe(true);
    expect(g.stderr.join('\n')).toContain('~/token-elsewhere (admin token outside the serve directory; not touched)');
    expect(checkOf(gdoc, 'plan')?.detail).toContain('Token     leave ~/token-elsewhere');
    expect(existsSync(wrapperPath(g.serveDir))).toBe(false);
  });
});

describe('occupied-port probe (any answer counts)', () => {
  test('a listener that 404s /health is still a foreign listener: refused before any tailscale serve argv; with --no-service it counts as "something listens"', async () => {
    const f = fakeTailnet();
    f.deps.fetch = async (url) => { f.fetches.push(url); if (url.startsWith('http://127.0.0.1:')) return { ok: false, status: 404 }; return { ok: true, status: 200 }; };
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(1);
    const doc = jsonDoc(f);
    expect(doc).toMatchObject({ status: 'error', reason: 'foreign_listener' });
    expect(doc.message).toContain('Something already answers on 127.0.0.1:3131');
    expect(checkOf(doc, 'service')?.detail).toContain('something already answers on 127.0.0.1:3131');
    expect(f.calls.some(c => c[0] === TS)).toBe(false);
    expect(joinedCalls(f).some(c => c.includes('--bg'))).toBe(false);
    expect(existsSync(f.serveDir)).toBe(false);
    // a 500 is occupied too
    const g = fakeTailnet();
    g.deps.fetch = async (url) => (url.startsWith('http://127.0.0.1:') ? { ok: false, status: 500 } : { ok: true, status: 200 });
    expect(await runMcpExpose(['--yes', '--json'], g.deps)).toBe(1);
    expect(jsonDoc(g).reason).toBe('foreign_listener');
    // --no-service: the occupant is the operator's server → the local wait runs (and, unhealthy, times out) instead of "Nothing listens"
    const h = fakeTailnet();
    h.deps.fetch = async (url) => { h.fetches.push(url); if (url.startsWith('http://127.0.0.1:')) return { ok: false, status: 404 }; return { ok: true, status: 200 }; };
    expect(await runMcpExpose(['--yes', '--no-service', '--json'], h.deps)).toBe(2);
    const hdoc = jsonDoc(h);
    expect(hdoc).toMatchObject({ status: 'pending', reason: 'local_health_timeout' });
    expect(checkOf(hdoc, 'verify.local')).toMatchObject({ status: 'warn' });
    expect(h.stderr.join('\n')).not.toContain('Nothing listens on 127.0.0.1:3131');
    // health itself still needs 2xx: a refused connection is neither occupied nor healthy
    const i = fakeTailnet();
    expect(await runMcpExpose(['--yes', '--no-service', '--json'], i.deps)).toBe(0);
    expect(checkOf(jsonDoc(i), 'verify.local')?.status).toBe('skipped');
  });
});

describe('tailscale serve status fails closed', () => {
  /** Make the fake's `serve status --json` answer with `result` (a broken read) while everything else works. */
  const breakServeStatus = (f: Fake, result: { status: number | null; stdout: string; stderr: string }) => {
    const inner = f.deps.run!;
    f.deps.run = async (argv, o) => {
      if (argv.join(' ') === `${TS} serve status --json`) { f.calls.push(argv); f.recorded.push({ argv, opts: o }); return result; }
      return inner(argv, o);
    };
  };
  test('publish: a non-zero exit is classified (needs_operator), a killed read is unknown, exit 0 with non-JSON stdout is unknown — nothing is published in any case', async () => {
    const f = fakeTailnet();
    breakServeStatus(f, { status: 1, stdout: '', stderr: 'Access denied: serve requires the operator flag' });
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(1);
    const doc = jsonDoc(f);
    expect(doc).toMatchObject({ status: 'error', reason: 'tailscale_needs_operator' });
    expect(doc.message).toContain('Could not read the current `tailscale serve status`, so nothing was published.');
    expect(doc.message).toContain('sudo tailscale set --operator=alice-example');
    expect(checkOf(doc, 'tailscale.publish')).toMatchObject({ status: 'fail' });
    expect(checkOf(doc, 'tailscale.publish')?.detail).toContain('could not read tailscale serve status (exit 1): needs_operator');
    expect(doc.next_actions).toContain('tailscale serve status --json');
    expect(joinedCalls(f).some(c => c.includes('--bg'))).toBe(false);
    expect(existsSync(f.serveDir)).toBe(false);
    const g = fakeTailnet();
    breakServeStatus(g, { status: null, stdout: '', stderr: '\n(timed out after 15000ms)' });
    expect(await runMcpExpose(['--yes', '--json'], g.deps)).toBe(1);
    const gdoc = jsonDoc(g);
    expect(gdoc.reason).toBe('tailscale_unknown');
    expect(checkOf(gdoc, 'tailscale.publish')?.detail).toContain('killed or not spawned');
    expect(joinedCalls(g).some(c => c.includes('--bg'))).toBe(false);
    const h = fakeTailnet();
    breakServeStatus(h, { status: 0, stdout: 'Warning: serve is in a weird state\n', stderr: '' });
    expect(await runMcpExpose(['--yes', '--json'], h.deps)).toBe(1);
    const hdoc = jsonDoc(h);
    expect(hdoc.reason).toBe('tailscale_unknown');
    expect(checkOf(hdoc, 'tailscale.publish')?.detail).toContain('exit 0 but stdout was not a JSON object');
    expect(joinedCalls(h).some(c => c.includes('--bg'))).toBe(false);
    // an EMPTY document from exit 0 is a legitimately empty config → publish proceeds
    const i = fakeTailnet();
    const iinner = i.deps.run!;
    let published = false;
    i.deps.run = async (argv, o) => {
      if (argv.join(' ') === `${TS} serve status --json` && !published) return { status: 0, stdout: '', stderr: '' };
      if (argv[1] === 'serve' && argv[2] === '--bg') published = true;
      return iinner(argv, o);
    };
    expect(await runMcpExpose(['--yes', '--json'], i.deps)).toBe(0);
  });
  test('--remove: an unreadable serve status fails the tailscale check, keeps the receipt AND the wrapper, exit 1; a re-run once it reads again finishes the job', async () => {
    const f = fakeTailnet();
    expect(await runMcpExpose(['--yes'], f.deps)).toBe(0);
    const inner = f.deps.run!;
    let broken = true;
    f.deps.run = async (argv, o) => {
      if (broken && argv.join(' ') === `${TS} serve status --json`) { f.calls.push(argv); return { status: 1, stdout: '', stderr: 'failed to connect to local Tailscale service; is Tailscale running?' }; }
      return inner(argv, o);
    };
    f.calls.length = 0;
    f.stdout.length = 0;
    expect(await runMcpExpose(['--remove', '--yes', '--json'], f.deps)).toBe(1);
    const doc = jsonDoc(f);
    expect(doc).toMatchObject({ status: 'error', reason: 'tailscale_serve_status_unreadable', message: 'could not read tailscale serve status; handler left as is' });
    expect(checkOf(doc, 'tailscale.publish')).toMatchObject({ status: 'fail' });
    expect(checkOf(doc, 'tailscale.publish')?.detail).toContain('could not read tailscale serve status (exit 1): daemon_not_running');
    expect(checkOf(doc, 'tailscale.publish')?.detail).toContain('handler left as is');
    expect(checkOf(doc, 'receipt')).toMatchObject({ status: 'skipped' });
    expect(doc.receipt).not.toBeNull();
    expect(doc.next_actions).toContain('gbrain mcp expose --remove --yes');
    expect(joinedCalls(f).some(c => c.includes('--https=443 off'))).toBe(false);
    expect(existsSync(receiptPath(f.serveDir))).toBe(true);
    expect(existsSync(wrapperPath(f.serveDir))).toBe(true);
    expect((await inner([TS, 'serve', 'status', '--json'])).stdout).toContain('127.0.0.1:3131');
    expect(f.stderr.join('\n')).toContain('re-run `gbrain mcp expose --remove --yes`');
    // Tailscale is back → the same command completes the removal
    broken = false;
    f.calls.length = 0;
    f.stdout.length = 0;
    expect(await runMcpExpose(['--remove', '--yes', '--json'], f.deps)).toBe(0);
    expect(jsonDoc(f).status).toBe('removed');
    expect(joinedCalls(f)).toContain(`${TS} serve --https=443 off`);
    expect(existsSync(receiptPath(f.serveDir))).toBe(false);
    expect(existsSync(wrapperPath(f.serveDir))).toBe(false);
  });
  test('--status: an unreadable serve status is a failed tailscale.publish check (never "handler present"), exit 1', async () => {
    const f = fakeTailnet();
    expect(await runMcpExpose(['--yes'], f.deps)).toBe(0);
    breakServeStatus(f, { status: 1, stdout: '', stderr: 'Access denied' });
    f.stdout.length = 0;
    expect(await runMcpExpose(['--status', '--json'], f.deps)).toBe(1);
    const doc = jsonDoc(f);
    expect(doc).toMatchObject({ status: 'error', reason: 'status_unhealthy' });
    expect(checkOf(doc, 'tailscale.publish')).toMatchObject({ status: 'fail' });
    expect(checkOf(doc, 'tailscale.publish')?.detail).toContain('could not read tailscale serve status (exit 1): needs_operator');
    expect(doc.next_actions).toContain('tailscale serve status --json');
    // the other probes still ran and are reported in order
    expect(doc.checks.map((c: { name: string }) => c.name)).toEqual(['receipt', 'tailscale.publish', 'service', 'verify.local', 'verify.tailnet']);
    expect(checkOf(doc, 'service')?.status).toBe('ok');
    // exit 0 with junk on stdout is the same failure
    const g = fakeTailnet();
    expect(await runMcpExpose(['--yes'], g.deps)).toBe(0);
    breakServeStatus(g, { status: 0, stdout: 'not json at all', stderr: '' });
    g.stdout.length = 0;
    expect(await runMcpExpose(['--status', '--json'], g.deps)).toBe(1);
    expect(checkOf(jsonDoc(g), 'tailscale.publish')?.detail).toContain('exit 0 but stdout was not a JSON object');
  });
});

describe('early receipt + receipt-less recovery', () => {
  test('the receipt is on disk right after the service step — before verify — and is rewritten with the settled state when verify never turns healthy', async () => {
    const f = fakeTailnet({ localHealthyAfterStart: false });
    const inner = f.deps.fetch!;
    const receiptSeenDuringVerify: boolean[] = [];
    f.deps.fetch = async (url, init) => {
      if (url.startsWith('http://127.0.0.1:') && f.fetches.length > 0) receiptSeenDuringVerify.push(existsSync(receiptPath(f.serveDir)));
      return inner(url, init);
    };
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(2);
    const doc = jsonDoc(f);
    expect(doc).toMatchObject({ status: 'pending', reason: 'local_health_timeout' });
    // every verify poll (all local probes after the plan-step occupancy probe) saw the receipt already written
    expect(receiptSeenDuringVerify.length).toBeGreaterThan(0);
    expect(receiptSeenDuringVerify.every(Boolean)).toBe(true);
    const receipt = readExposeReceipt(receiptPath(f.serveDir))!;
    expect(receipt.service).toMatchObject({ target: 'linux-systemd', state: 'running', unit_path: f.deps.unitPath });
    expect(receipt.created_at).toBe('2026-06-01T12:00:00.000Z');
    expect(doc.receipt).toEqual(receipt);
    expect(checkOf(doc, 'receipt')?.status).toBe('ok');
  });
  test('a throw AFTER the early receipt leaves handler + service in place (no rollback) and points at --status / --remove', async () => {
    const f = fakeTailnet({ localHealthyAfterStart: false });
    f.deps.sleep = async () => { throw new Error('clock exploded'); };
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(1);
    const doc = jsonDoc(f);
    expect(doc).toMatchObject({ status: 'error', reason: 'mcp_expose_failed' });
    expect(doc.message).toContain('clock exploded');
    expect(doc.message).toContain('the receipt was already written');
    expect(checkOf(doc, 'rollback')).toMatchObject({ status: 'skipped' });
    expect(checkOf(doc, 'rollback')?.detail).toContain('receipt already written');
    expect(doc.next_actions).toContain('gbrain mcp expose --remove --yes');
    expect(joinedCalls(f).some(c => c.includes('--https=443 off'))).toBe(false);
    expect(existsSync(receiptPath(f.serveDir))).toBe(true);
    expect((await f.run([TS, 'serve', 'status', '--json'])).stdout).toContain('127.0.0.1:3131');
    // and --remove cleans it all up
    f.stdout.length = 0;
    expect(await runMcpExpose(['--remove', '--yes', '--json'], f.deps)).toBe(0);
    expect(existsSync(receiptPath(f.serveDir))).toBe(false);
    expect((await f.run([TS, 'serve', 'status', '--json'])).stdout).not.toContain('127.0.0.1:3131');
  });
  test('an interrupted run (receipt deleted after a successful publish): --remove --yes still removes the unit + wrapper and turns the handler off, leaves the token', async () => {
    const f = fakeTailnet();
    expect(await runMcpExpose(['--yes'], f.deps)).toBe(0);
    rmSync(receiptPath(f.serveDir));
    f.calls.length = 0;
    f.stdout.length = 0;
    // non-TTY without --yes: a plan + confirmation_required, nothing changed
    expect(await runMcpExpose(['--remove', '--json'], f.deps)).toBe(2);
    const pending = jsonDoc(f);
    expect(pending).toMatchObject({ status: 'pending', reason: 'confirmation_required' });
    expect(checkOf(pending, 'receipt')).toMatchObject({ status: 'warn' });
    expect(checkOf(pending, 'receipt')?.detail).toContain('recovering from what is on disk (port 3131)');
    expect(checkOf(pending, 'plan')?.detail).toContain('stop + remove systemd (user) gbrain-serve.service');
    expect(checkOf(pending, 'plan')?.detail).toContain('turn off the :443 handler proxying http://127.0.0.1:3131');
    expect(checkOf(pending, 'plan')?.detail).toContain(`delete ~/.gbrain/serve/gbrain-serve.sh`);
    expect(checkOf(pending, 'plan')?.detail).toContain('leave ~/.gbrain/serve/admin-token');
    expect(pending.next_actions).toContain('gbrain mcp expose --remove --yes');
    expect(f.stderr.join('\n')).toContain('Recovering without a receipt');
    expect(joinedCalls(f).some(c => c.includes('off') || c.includes('disable'))).toBe(false);
    expect(existsSync(wrapperPath(f.serveDir))).toBe(true);
    f.calls.length = 0;
    f.stdout.length = 0;
    expect(await runMcpExpose(['--remove', '--yes', '--json'], f.deps)).toBe(0);
    const doc = jsonDoc(f);
    expect(doc).toMatchObject({ status: 'removed', reason: 'recovered_without_receipt' });
    const calls = joinedCalls(f);
    expect(calls).toContain('systemctl --user disable --now gbrain-serve.service');
    expect(calls).toContain(`${TS} serve --https=443 off`);
    expect(calls.some(c => /reset|logout|uninstall/.test(c))).toBe(false);
    expect(checkOf(doc, 'service')?.detail).toContain(f.deps.unitPath!);
    expect(checkOf(doc, 'tailscale.publish')).toMatchObject({ status: 'ok', detail: 'serve off: exit 0' });
    expect(checkOf(doc, 'files')?.detail).toContain('gbrain-serve.sh');
    expect(existsSync(f.deps.unitPath!)).toBe(false);
    expect(existsSync(wrapperPath(f.serveDir))).toBe(false);
    expect(existsSync(adminTokenPath(f.serveDir))).toBe(true);
    expect((await f.run([TS, 'serve', 'status', '--json'])).stdout).not.toContain('127.0.0.1:3131');
    expect(f.stderr.join('\n')).toContain('Removed the leftovers of an interrupted publish.');
    expect(f.stderr.join('\n')).toContain('admin token; left without a receipt');
    // now truly nothing is left → the plain "nothing to remove"
    f.stdout.length = 0;
    expect(await runMcpExpose(['--remove', '--yes', '--json'], f.deps)).toBe(0);
    expect(jsonDoc(f)).toMatchObject({ status: 'not_exposed', reason: 'not_exposed' });
  });
  test('recovery honors --port (a handler for another port is not ours), turns Funnel off first, and on darwin boots the agent out', async () => {
    const f = fakeTailnet();
    expect(await runMcpExpose(['--yes', '--funnel', '--port', '4000'], f.deps)).toBe(0);
    rmSync(receiptPath(f.serveDir));
    f.calls.length = 0;
    f.stdout.length = 0;
    // default port 3131: the handler proxies 4000 → not touched (service + wrapper still ours)
    expect(await runMcpExpose(['--remove', '--yes', '--port', '5000', '--json'], f.deps)).toBe(0);
    const other = jsonDoc(f);
    expect(other.status).toBe('removed');
    expect(checkOf(other, 'tailscale.publish')?.detail).toContain('no :443 handler proxies to port 5000');
    expect(joinedCalls(f).some(c => c.includes('--https=443 off'))).toBe(false);
    expect((await f.run([TS, 'serve', 'status', '--json'])).stdout).toContain('127.0.0.1:4000');
    // right port: funnel off first, then serve off
    // (re-create the wrapper the previous recovery removed, as an interrupted run would have left it)
    writeFileSync(wrapperPath(f.serveDir), '#!/bin/bash\nexit 0\n');
    f.calls.length = 0;
    f.stdout.length = 0;
    expect(await runMcpExpose(['--remove', '--yes', '--port', '4000', '--json'], f.deps)).toBe(0);
    const doc = jsonDoc(f);
    expect(checkOf(doc, 'plan')?.detail).toContain('(funnel first)');
    const calls = joinedCalls(f);
    expect(calls).toContain(`${TS} funnel --https=443 off`);
    expect((await f.run([TS, 'serve', 'status', '--json'])).stdout).not.toContain('127.0.0.1:4000');
    expect(existsSync(wrapperPath(f.serveDir))).toBe(false);
    // darwin
    const g = fakeMac();
    expect(await runMcpExpose(['--yes'], g.deps)).toBe(0);
    rmSync(receiptPath(g.serveDir));
    g.calls.length = 0;
    g.stdout.length = 0;
    expect(await runMcpExpose(['--remove', '--yes', '--json'], g.deps)).toBe(0);
    expect(jsonDoc(g).reason).toBe('recovered_without_receipt');
    expect(joinedCalls(g)).toContain(`launchctl bootout gui/501 ${g.deps.plistPath}`);
    expect(existsSync(g.deps.plistPath!)).toBe(false);
    expect(joinedCalls(g)).toContain(`${APP_TS} serve --https=443 off`);
  });
  test('recovery with only a stray wrapper removes just the wrapper; with only a live handler it turns only that off; an unreadable serve status is reported and leaves the handler', async () => {
    const f = fakeTailnet();
    mkdirSync(f.serveDir, { recursive: true });
    writeFileSync(wrapperPath(f.serveDir), '#!/bin/bash\nexit 0\n');
    expect(await runMcpExpose(['--remove', '--yes', '--json'], f.deps)).toBe(0);
    const doc = jsonDoc(f);
    expect(doc.reason).toBe('recovered_without_receipt');
    expect(checkOf(doc, 'service')).toMatchObject({ status: 'skipped', detail: 'none found' });
    expect(checkOf(doc, 'tailscale.publish')?.detail).toContain('nothing to turn off');
    expect(existsSync(wrapperPath(f.serveDir))).toBe(false);
    expect(joinedCalls(f).some(c => c.includes('disable') || c.includes('off'))).toBe(false);
    const g = fakeTailnet({ existingHandlers: { 3131: false } });
    expect(await runMcpExpose(['--remove', '--yes', '--json'], g.deps)).toBe(0);
    const gdoc = jsonDoc(g);
    expect(gdoc.reason).toBe('recovered_without_receipt');
    expect(joinedCalls(g)).toContain(`${TS} serve --https=443 off`);
    expect(joinedCalls(g).some(c => c.includes('disable'))).toBe(false);
    expect(checkOf(gdoc, 'files')?.detail).toBe('removed nothing');
    const h = fakeTailnet();
    mkdirSync(h.serveDir, { recursive: true });
    writeFileSync(wrapperPath(h.serveDir), '#!/bin/bash\nexit 0\n');
    const hinner = h.deps.run!;
    h.deps.run = async (argv, o) => (argv.join(' ') === `${TS} serve status --json` ? { status: 1, stdout: '', stderr: 'Access denied' } : hinner(argv, o));
    expect(await runMcpExpose(['--remove', '--yes', '--json'], h.deps)).toBe(0);
    const hdoc = jsonDoc(h);
    expect(checkOf(hdoc, 'tailscale.publish')).toMatchObject({ status: 'warn' });
    expect(checkOf(hdoc, 'tailscale.publish')?.detail).toContain('could not read tailscale serve status');
    expect(h.stderr.join('\n')).toContain('serve status could not be read');
    expect(existsSync(wrapperPath(h.serveDir))).toBe(false);
    // nothing of ours anywhere AND serve status unreadable → still "nothing to remove", with the caveat recorded
    const i = fakeTailnet();
    const iinner = i.deps.run!;
    i.deps.run = async (argv, o) => (argv.join(' ') === `${TS} serve status --json` ? { status: 1, stdout: '', stderr: 'Access denied' } : iinner(argv, o));
    expect(await runMcpExpose(['--remove', '--yes', '--json'], i.deps)).toBe(0);
    const idoc = jsonDoc(i);
    expect(idoc).toMatchObject({ status: 'not_exposed' });
    expect(checkOf(idoc, 'tailscale.publish')?.detail).toContain('could not be checked');
  });
});

describe('PGLite lock-holder warning', () => {
  test('a live holder that is not our own service adds a Lock plan line and a pglite_lock warn (run proceeds); our own running service, Postgres, or no holder → no warning', async () => {
    const f = fakeTailnet();
    const asked: string[] = [];
    f.deps.pgliteHolder = (dbPath) => { asked.push(dbPath); return { pid: 4242, serve: true }; };
    expect(await runMcpExpose(['--yes', '--json'], f.deps)).toBe(0);
    const doc = jsonDoc(f);
    expect(asked).toEqual([join(f.home, 'brain.pglite')]);
    expect(checkOf(doc, 'pglite_lock')).toMatchObject({ status: 'warn' });
    expect(checkOf(doc, 'pglite_lock')?.detail).toBe('a live process holds this PGLite brain (pid 4242, gbrain serve): the service cannot start until it exits — stop it, or move to Postgres');
    expect(f.stderr.join('\n')).toContain('  Lock      a live process holds this PGLite brain (pid 4242, gbrain serve)');
    expect(doc.checks.findIndex((c: { name: string }) => c.name === 'pglite_lock')).toBe(doc.checks.findIndex((c: { name: string }) => c.name === 'plan') + 1);
    expect(doc.status).toBe('exposed');
    // a command string wins over the serve flag; a non-serve holder says gbrain
    const g = fakeTailnet();
    g.deps.pgliteHolder = () => ({ pid: 7, serve: false, command: 'gbrain doctor' });
    expect(await runMcpExpose(['--dry-run', '--json'], g.deps)).toBe(0);
    expect(jsonDoc(g).plan.join('\n')).toContain('(pid 7, gbrain doctor)');
    const g2 = fakeTailnet();
    g2.deps.pgliteHolder = () => ({ pid: 8, serve: false });
    expect(await runMcpExpose(['--dry-run', '--json'], g2.deps)).toBe(0);
    expect(jsonDoc(g2).plan.join('\n')).toContain('(pid 8, gbrain)');
    // our own managed service (receipt present, state running) is expected to hold the lock → no warning
    const h = fakeTailnet();
    expect(await runMcpExpose(['--yes'], h.deps)).toBe(0);
    h.deps.pgliteHolder = () => ({ pid: 4242, serve: true });
    h.stdout.length = 0;
    expect(await runMcpExpose(['--yes', '--json'], h.deps)).toBe(0);
    expect(checkOf(jsonDoc(h), 'pglite_lock')).toBeUndefined();
    // a receipt whose service is stopped does not explain the holder → warn
    const h2 = fakeTailnet();
    writeExposeReceipt(receiptPath(h2.serveDir), fullReceipt(h2, { service: { target: 'linux-systemd', unit_path: null, plist_path: null, wrapper_path: wrapperPath(h2.serveDir), state: 'stopped' } }));
    h2.deps.pgliteHolder = () => ({ pid: 4242, serve: true });
    expect(await runMcpExpose(['--dry-run', '--json'], h2.deps)).toBe(0);
    expect(checkOf(jsonDoc(h2), 'pglite_lock')).toMatchObject({ status: 'warn' });
    // Postgres never consults the probe
    const i = fakeTailnet();
    i.deps.loadConfig = () => ({ engine: 'postgres', database_url: 'postgres://alice-example@localhost/brain' } as never);
    i.deps.pgliteHolder = () => { throw new Error('must not be called'); };
    expect(await runMcpExpose(['--yes', '--json'], i.deps)).toBe(0);
    expect(checkOf(jsonDoc(i), 'pglite_lock')).toBeUndefined();
    // no holder → no warning
    const j = fakeTailnet();
    j.deps.pgliteHolder = () => null;
    expect(await runMcpExpose(['--yes', '--json'], j.deps)).toBe(0);
    expect(checkOf(jsonDoc(j), 'pglite_lock')).toBeUndefined();
  });
  test('the default probe reads the real PGLite lock file (a live pid → warn; absent → nothing) without opening the engine', async () => {
    const f = fakeTailnet();
    const lockDir = join(f.home, 'brain.pglite', '.gbrain-lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'lock'), JSON.stringify({ pid: process.pid, subcommand: 'serve' }));
    expect(await runMcpExpose(['--dry-run', '--json'], f.deps)).toBe(0);
    const doc = jsonDoc(f);
    expect(checkOf(doc, 'pglite_lock')?.detail).toContain(`(pid ${process.pid}, gbrain serve)`);
    const g = fakeTailnet();
    expect(await runMcpExpose(['--dry-run', '--json'], g.deps)).toBe(0);
    expect(checkOf(jsonDoc(g), 'pglite_lock')).toBeUndefined();
  });
});
