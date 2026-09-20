/**
 * src/core/serve-service.ts — the persistent `gbrain serve --http` user
 * service behind `gbrain mcp expose`. Everything runs in a tmpdir against a
 * recording fake runner: no launchctl, no systemctl, no process.env writes.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandResult, CommandRunner } from '../src/core/tailscale.ts';
import {
  ADMIN_TOKEN_SHAPE, adminTokenPath, detectServiceTarget, ensureAdminToken, installServeService, launchdPlistPath,
  readExposeReceipt, receiptPath, refuseSymlink, renderServeLaunchdPlist, renderServeSystemdUnit, renderServeWrapper,
  resolveServeGbrainCommand, serveCommandArgv, serveServiceState, SERVE_LAUNCHD_LABEL, SERVE_SYSTEMD_UNIT, systemdUnitPath,
  uninstallServeService, wrapperPath, writeExposeReceipt, type ExposeReceipt,
} from '../src/core/serve-service.ts';

const roots: string[] = [];
const temp = () => { const p = mkdtempSync(join(tmpdir(), 'gbrain-serve-service-')); roots.push(p); return p; };
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });

interface Rule { key: string; status?: number | null; stdout?: string; stderr?: string }
function makeRunner(rules: Rule[] = []): { run: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: CommandRunner = async (argv): Promise<CommandResult> => {
    calls.push(argv);
    const joined = argv.join(' ');
    const rule = rules.find(r => joined.includes(r.key));
    return { status: rule?.status === undefined ? 0 : rule.status, stdout: rule?.stdout ?? '', stderr: rule?.stderr ?? '' };
  };
  return { run, calls };
}

const TOKEN = 'a'.repeat(64);

describe('paths + target detection', () => {
  test('path helpers hang off the serve dir', () => {
    expect(adminTokenPath('/x/serve')).toBe('/x/serve/admin-token');
    expect(wrapperPath('/x/serve')).toBe('/x/serve/gbrain-serve.sh');
    expect(receiptPath('/x/serve')).toBe('/x/serve/expose.json');
    expect(launchdPlistPath('/home/u')).toBe(`/home/u/Library/LaunchAgents/${SERVE_LAUNCHD_LABEL}.plist`);
    expect(systemdUnitPath('/home/u')).toBe(`/home/u/.config/systemd/user/${SERVE_SYSTEMD_UNIT}`);
  });
  test('detectServiceTarget matrix', () => {
    expect(detectServiceTarget({ platform: 'darwin', executionEnv: 'local' })).toBe('macos');
    expect(detectServiceTarget({ platform: 'darwin', executionEnv: 'cloud-sandbox' })).toBe('macos');
    expect(detectServiceTarget({ platform: 'linux', executionEnv: 'cloud-sandbox', userBus: { status: 0, stdout: 'running' } })).toBe('none');
    expect(detectServiceTarget({ platform: 'linux', executionEnv: 'ephemeral-container', userBus: { status: 0, stdout: 'running' } })).toBe('none');
    expect(detectServiceTarget({ platform: 'linux', executionEnv: 'local', userBus: { status: 0, stdout: 'running\n' } })).toBe('linux-systemd');
    expect(detectServiceTarget({ platform: 'linux', executionEnv: 'local', userBus: { status: 1, stdout: 'degraded\n' } })).toBe('linux-systemd');
    expect(detectServiceTarget({ platform: 'linux', executionEnv: 'local', userBus: { status: 1, stdout: 'Failed to connect to bus: No medium found' } })).toBe('none');
    expect(detectServiceTarget({ platform: 'linux', executionEnv: 'local', userBus: null })).toBe('none');
    expect(detectServiceTarget({ platform: 'win32', executionEnv: 'local', userBus: { status: 0, stdout: 'running' } })).toBe('none');
  });
  test('resolveServeGbrainCommand: shim > compiled execPath > bun + cli.ts', () => {
    expect(resolveServeGbrainCommand({ which: () => '/usr/local/bin/gbrain' })).toEqual(['/usr/local/bin/gbrain']);
    expect(resolveServeGbrainCommand({ which: () => null, execPath: '/opt/gbrain/bin/gbrain', argv1: '' })).toEqual(['/opt/gbrain/bin/gbrain']);
    const viaBun = resolveServeGbrainCommand({ which: () => null, execPath: '/home/u/.bun/bin/bun', argv1: '/repo/src/cli.ts' });
    expect(viaBun[0]).toBe('/home/u/.bun/bin/bun');
    expect(viaBun[1]).toMatch(/\/src\/cli\.ts$/);
  });
});

describe('renderServeWrapper', () => {
  const base = { port: 3131, publicUrl: 'https://your-machine.your-tailnet.ts.net', surface: 'full' as const, enableDcr: false, adminTokenPath: '/home/u/.gbrain/serve/admin-token', gbrainEnvFile: '/home/u/.gbrain/env', runtimeDir: '/home/u/.bun/bin' };
  test('reads the token at run time, sources env with set -a, prefixes PATH, cd $HOME, execs serve', () => {
    const w = renderServeWrapper({ ...base, gbrainCommand: ['/usr/local/bin/gbrain'] });
    expect(w.startsWith('#!/bin/bash\n')).toBe(true);
    expect(w).toContain("[ -f ~/.zshenv ] && source ~/.zshenv");
    expect(w).toContain("{ set -a; source '/home/u/.gbrain/env' 2>/dev/null; set +a; }");
    expect(w).toContain(`export PATH='/home/u/.bun/bin':"$HOME/.bun/bin:$PATH"`);
    expect(w).toContain(`GBRAIN_ADMIN_BOOTSTRAP_TOKEN="$(cat '/home/u/.gbrain/serve/admin-token')"`);
    expect(w).toContain('cd "$HOME"');
    expect(w).toContain(`_gbrain='/usr/local/bin/gbrain'`);
    expect(w).toContain('type -P gbrain');
    expect(w).toContain('exec "$_gbrain" serve --http --port 3131 --public-url https://your-machine.your-tailnet.ts.net --surface full');
    expect(w).not.toContain('export GBRAIN_HOME');
    expect(w).not.toContain('--enable-dcr');
  });
  test('bakes GBRAIN_HOME, the bun+cli.ts form, --enable-dcr, and single-quote-escapes hostile paths', () => {
    const w = renderServeWrapper({ ...base, enableDcr: true, surface: 'verbs', gbrainHome: "/home/u/it's home", gbrainCommand: ['/home/u/.bun/bin/bun', "/repo/it's/src/cli.ts"], adminTokenPath: "/home/u/tok'en" });
    expect(w).toContain(`export GBRAIN_HOME='/home/u/it'\\''s home'`);
    expect(w).toContain(`exec "$_gbrain" '/repo/it'\\''s/src/cli.ts' serve --http --port 3131 --public-url https://your-machine.your-tailnet.ts.net --surface verbs --enable-dcr`);
    expect(w).toContain(`cat '/home/u/tok'\\''en'`);
    expect(w).not.toContain(TOKEN);
  });
  test('an empty runtime dir produces no PATH prefix', () => {
    const w = renderServeWrapper({ ...base, runtimeDir: '', gbrainCommand: ['/usr/local/bin/gbrain'] });
    expect(w).toContain(`export PATH="$HOME/.bun/bin:$PATH"`);
  });
  test('serveCommandArgv omits optional flags when unset', () => {
    expect(serveCommandArgv({ port: 4000, publicUrl: 'https://h.ts.net' })).toEqual(['serve', '--http', '--port', '4000', '--public-url', 'https://h.ts.net']);
  });
});

describe('launchd plist + systemd unit renderers', () => {
  test('plist: label, RunAtLoad, KeepAlive, ThrottleInterval 30, log paths, XML escaping', () => {
    const p = renderServeLaunchdPlist({ wrapperPath: '/home/u & co/.gbrain/serve/gbrain-serve.sh', home: '/home/u & co', logPath: '/home/u & co/.gbrain/serve/serve.log', errPath: '/home/u & co/.gbrain/serve/serve.err' });
    expect(p).toContain(`<key>Label</key><string>${SERVE_LAUNCHD_LABEL}</string>`);
    expect(p).toContain('<key>RunAtLoad</key><true/>');
    expect(p).toContain('<key>KeepAlive</key><true/>');
    expect(p).toContain('<key>ThrottleInterval</key><integer>30</integer>');
    expect(p).toContain('<key>WorkingDirectory</key><string>/home/u &amp; co</string>');
    expect(p).toContain('<string>/home/u &amp; co/.gbrain/serve/gbrain-serve.sh</string>');
    expect(p).toContain('<key>StandardErrorPath</key><string>/home/u &amp; co/.gbrain/serve/serve.err</string>');
    expect(p).not.toContain('/home/u & co');
  });
  test('unit: network-online, Restart=always, RestartSec=10, start-limit, append: logs, quoting', () => {
    const u = renderServeSystemdUnit({ wrapperPath: '/home/u/.gbrain/serve/gbrain-serve.sh', logPath: '/home/u/.gbrain/serve/serve.log', errPath: '/home/u/.gbrain/serve/serve.err' });
    expect(u).toContain('After=network-online.target');
    expect(u).toContain('StartLimitIntervalSec=300');
    expect(u).toContain('StartLimitBurst=10');
    expect(u).toContain('ExecStart=/home/u/.gbrain/serve/gbrain-serve.sh');
    expect(u).toContain('Restart=always');
    expect(u).toContain('RestartSec=10');
    expect(u).toContain('StandardOutput=append:/home/u/.gbrain/serve/serve.log');
    expect(u).toContain('StandardError=append:/home/u/.gbrain/serve/serve.err');
    expect(u).toContain('WantedBy=default.target');
    expect(renderServeSystemdUnit({ wrapperPath: '/home/u v/w.sh', logPath: '/l', errPath: '/e' })).toContain('ExecStart="/home/u v/w.sh"');
  });
  test('unit: systemd specifiers are escaped — % → %% in ExecStart and both append: paths, $ → $$ in ExecStart', () => {
    const u = renderServeSystemdUnit({ wrapperPath: '/home/100%user/.gbrain/serve/gbrain-serve.sh', logPath: '/home/100%user/serve.log', errPath: '/home/100%user/$err.log' });
    expect(u).toContain('ExecStart=/home/100%%user/.gbrain/serve/gbrain-serve.sh');
    expect(u).toContain('StandardOutput=append:/home/100%%user/serve.log');
    expect(u).toContain('StandardError=append:/home/100%%user/$err.log');
    expect(renderServeSystemdUnit({ wrapperPath: '/home/u/$HOME-ish/w.sh', logPath: '/l', errPath: '/e' })).toContain('ExecStart=/home/u/$$HOME-ish/w.sh');
    expect(u).not.toContain('100%user');
  });
});

describe('ensureAdminToken', () => {
  test('creates dir 0700 + file 0600 with 64 hex chars; reuses a valid token; regenerates a malformed one', () => {
    const dir = join(temp(), 'serve');
    const path = adminTokenPath(dir);
    const first = ensureAdminToken(path);
    expect(first.action).toBe('created');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const value = readFileSync(path, 'utf-8').trim();
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(ADMIN_TOKEN_SHAPE.test(value)).toBe(true);
    expect(ensureAdminToken(path).action).toBe('reused');
    expect(readFileSync(path, 'utf-8').trim()).toBe(value);
    writeFileSync(path, 'short\n');
    const third = ensureAdminToken(path, { randomHex: () => TOKEN });
    expect(third.action).toBe('regenerated');
    expect(readFileSync(path, 'utf-8').trim()).toBe(TOKEN);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  test('a symlink at the token path is refused (never written through)', () => {
    const root = temp();
    const dir = join(root, 'serve');
    mkdirSync(dir, { recursive: true });
    const victim = join(root, 'victim');
    writeFileSync(victim, 'keep me\n');
    const path = adminTokenPath(dir);
    symlinkSync(victim, path);
    expect(() => ensureAdminToken(path, { randomHex: () => TOKEN })).toThrow(/symlink/);
    expect(readFileSync(victim, 'utf-8')).toBe('keep me\n');
    // dangling link too
    const dangling = join(dir, 'dangling');
    symlinkSync(join(root, 'nowhere'), dangling);
    expect(() => refuseSymlink(dangling, 'x')).toThrow(/symlink/);
    expect(() => refuseSymlink(join(dir, 'absent'), 'x')).not.toThrow();
  });
});

describe('install / uninstall / state', () => {
  test('linux-systemd: writes wrapper 0755 + unit 0644, daemon-reload, enable, restart, enable-linger (non-fatal)', async () => {
    const home = temp();
    const dir = join(home, '.gbrain', 'serve');
    const { run, calls } = makeRunner([{ key: 'loginctl enable-linger', status: 1, stderr: 'Could not enable linger' }]);
    const r = await installServeService({ target: 'linux-systemd', wrapperPath: wrapperPath(dir), wrapperContent: '#!/bin/bash\nexit 0\n', home, logPath: join(dir, 'serve.log'), errPath: join(dir, 'serve.err'), run });
    expect(r.error).toBeUndefined();
    expect(r.unit_path).toBe(systemdUnitPath(home));
    expect(statSync(wrapperPath(dir)).mode & 0o777).toBe(0o755);
    expect(statSync(r.unit_path!).mode & 0o777).toBe(0o644);
    expect(readFileSync(r.unit_path!, 'utf-8')).toContain(`ExecStart=${wrapperPath(dir)}`);
    // `restart`, not `enable --now`: a reinstall regenerates the wrapper and the running server must relaunch.
    expect(calls.map(c => c.join(' '))).toEqual([
      'systemctl --user daemon-reload',
      `systemctl --user enable ${SERVE_SYSTEMD_UNIT}`,
      `systemctl --user restart ${SERVE_SYSTEMD_UNIT}`,
      'loginctl enable-linger',
    ]);
    expect(calls.some(c => c.includes('--now'))).toBe(false);
    expect(r.notes.join('\n')).toContain('enable-linger');
    const off = await uninstallServeService({ target: 'linux-systemd', home, run });
    expect(off.removed).toEqual([systemdUnitPath(home)]);
    expect(existsSync(systemdUnitPath(home))).toBe(false);
    expect(calls.slice(4).map(c => c.join(' '))).toEqual([`systemctl --user disable --now ${SERVE_SYSTEMD_UNIT}`, 'systemctl --user daemon-reload']);
  });
  test('linux-systemd: enable failure surfaces as error; restart failure too; linger not attempted', async () => {
    const home = temp();
    const { run, calls } = makeRunner([{ key: 'systemctl --user enable', status: 1, stderr: 'Failed to connect to bus' }]);
    const r = await installServeService({ target: 'linux-systemd', wrapperPath: join(home, 'w.sh'), wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run });
    expect(r.error).toContain('Failed to connect to bus');
    expect(calls.some(c => c[0] === 'loginctl' || c.includes('restart'))).toBe(false);
    const bad = makeRunner([{ key: 'systemctl --user restart', status: 1, stderr: 'Job for gbrain-serve.service failed' }]);
    const r2 = await installServeService({ target: 'linux-systemd', wrapperPath: join(home, 'w.sh'), wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run: bad.run });
    expect(r2.error).toContain('restart');
    expect(bad.calls.some(c => c[0] === 'loginctl')).toBe(false);
  });
  test('a symlinked wrapper path is refused before anything is written or started', async () => {
    const home = temp();
    const victim = join(home, 'victim.sh');
    writeFileSync(victim, 'original\n');
    const link = join(home, 'w.sh');
    symlinkSync(victim, link);
    const { run, calls } = makeRunner();
    await expect(installServeService({ target: 'linux-systemd', wrapperPath: link, wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run })).rejects.toThrow(/symlink/);
    expect(readFileSync(victim, 'utf-8')).toBe('original\n');
    expect(calls).toEqual([]);
  });
  test('macos: plist 0644, unload (ignored) before load, load failure reported', async () => {
    const home = temp();
    const plist = join(home, 'LaunchAgents', 'com.gbrain.serve.plist');
    const { run, calls } = makeRunner([{ key: 'launchctl unload', status: 113, stderr: 'not loaded' }]);
    const r = await installServeService({ target: 'macos', wrapperPath: join(home, 'w.sh'), wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run, plistPath: plist });
    expect(r.error).toBeUndefined();
    expect(statSync(plist).mode & 0o777).toBe(0o644);
    expect(calls.map(c => c.join(' '))).toEqual([`launchctl unload ${plist}`, `launchctl load ${plist}`]);
    const bad = makeRunner([{ key: 'launchctl load', status: 5, stderr: 'Bootstrap failed: 5: Input/output error' }]);
    const r2 = await installServeService({ target: 'macos', wrapperPath: join(home, 'w.sh'), wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run: bad.run, plistPath: plist });
    expect(r2.error).toContain('Input/output error');
    const off = await uninstallServeService({ target: 'macos', home, run, plistPath: plist });
    expect(off.removed).toEqual([plist]);
    expect(existsSync(plist)).toBe(false);
  });
  test('target none: only the wrapper is written, no exec', async () => {
    const home = temp();
    const { run, calls } = makeRunner();
    const r = await installServeService({ target: 'none', wrapperPath: join(home, 'w.sh'), wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run });
    expect(r.plist_path).toBeNull();
    expect(r.unit_path).toBeNull();
    expect(existsSync(join(home, 'w.sh'))).toBe(true);
    expect(calls).toEqual([]);
  });
  test('serveServiceState parses launchctl and systemctl answers', async () => {
    expect(await serveServiceState({ target: 'macos', uid: 501, run: makeRunner([{ key: 'launchctl print', stdout: 'state = running\n' }]).run })).toBe('running');
    expect(await serveServiceState({ target: 'macos', uid: 501, run: makeRunner([{ key: 'launchctl print', stdout: 'state = waiting\n' }]).run })).toBe('loaded');
    expect(await serveServiceState({ target: 'macos', uid: 501, run: makeRunner([{ key: 'launchctl print', status: 113 }]).run })).toBe('not-installed');
    expect(await serveServiceState({ target: 'linux-systemd', run: makeRunner([{ key: 'is-active', stdout: 'active\n' }]).run })).toBe('running');
    expect(await serveServiceState({ target: 'linux-systemd', run: makeRunner([{ key: 'is-active', status: 3, stdout: 'inactive\n' }]).run })).toBe('stopped');
    expect(await serveServiceState({ target: 'linux-systemd', run: makeRunner([{ key: 'is-active', status: 4, stdout: 'inactive\n', stderr: 'Unit gbrain-serve.service could not be found.' }]).run })).toBe('not-installed');
    expect(await serveServiceState({ target: 'linux-systemd', run: makeRunner([{ key: 'is-active', status: null }]).run })).toBe('unknown');
    expect(await serveServiceState({ target: 'none', run: makeRunner().run })).toBe('manual');
  });
});

describe('receipt', () => {
  const receipt: ExposeReceipt = {
    version: 1, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', port: 3131,
    public_url: 'https://your-machine.your-tailnet.ts.net', mcp_url: 'https://your-machine.your-tailnet.ts.net/mcp', admin_url: 'https://your-machine.your-tailnet.ts.net/admin',
    mode: 'tailnet', surface: 'full', enable_dcr: false, tailscale: { binary: '/usr/bin/tailscale', dns_name: 'your-machine.your-tailnet.ts.net', tailscale_version: '1.80.0' },
    service: { target: 'linux-systemd', unit_path: '/home/u/.config/systemd/user/gbrain-serve.service', plist_path: null, wrapper_path: '/home/u/.gbrain/serve/gbrain-serve.sh', state: 'running' },
    admin_token_file: '/home/u/.gbrain/serve/admin-token', engine: 'pglite',
  };
  test('round-trips at 0600; malformed or missing → null', () => {
    const path = receiptPath(join(temp(), 'serve'));
    expect(readExposeReceipt(path)).toBeNull();
    writeExposeReceipt(path, receipt);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readExposeReceipt(path)).toEqual(receipt);
    writeFileSync(path, '{"version":2}');
    expect(readExposeReceipt(path)).toBeNull();
    writeFileSync(path, 'nope');
    expect(readExposeReceipt(path)).toBeNull();
  });
  test('a symlinked receipt path is refused on read and write', () => {
    const root = temp();
    const dir = join(root, 'serve');
    mkdirSync(dir, { recursive: true });
    const victim = join(root, 'victim.json');
    writeFileSync(victim, JSON.stringify(receipt));
    const path = receiptPath(dir);
    symlinkSync(victim, path);
    expect(() => readExposeReceipt(path)).toThrow(/symlink/);
    expect(() => writeExposeReceipt(path, { ...receipt, port: 9 })).toThrow(/symlink/);
    expect(JSON.parse(readFileSync(victim, 'utf-8')).port).toBe(3131);
  });
});
