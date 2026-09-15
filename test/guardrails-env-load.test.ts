/**
 * #3688 — GBRAIN_GUARDRAILS_MODULE operator wiring.
 *
 * Before this fix, registerGuardrailProvider existed only in-module + docs:
 * the package exports map lacked './core/guardrails' and nothing in cli.ts
 * ever loaded a provider, so runGuardrails no-op'd forever (providers.size
 * === 0) — the documented firewall was unreachable. Covers:
 *   - unset env → no-op, stays inert
 *   - default-export provider, provider array, guardrailProviders, register()
 *   - fail-CLOSED: unloadable module throws GuardrailLoadError
 *   - fail-CLOSED: module that registers nothing throws GuardrailLoadError
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  __resetGuardrailProvidersForTests,
  hasGuardrails,
  loadGuardrailProvidersFromEnv,
  runGuardrails,
  GuardrailLoadError,
} from '../src/core/guardrails.ts';
import { withEnv } from './helpers/with-env.ts';

// One fresh mkdtemp per fixture: bun caches a directory's listing after the
// first dynamic import from it, so a second module written into the SAME dir
// resolves as "Cannot find module" mid-run.
const dirs: string[] = [];

afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
beforeEach(() => __resetGuardrailProvidersForTests());

/** Write a fixture module into its own temp dir; returns the absolute path. */
function fixture(name: string, source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-guardrails-3688-'));
  dirs.push(dir);
  const p = join(dir, name);
  writeFileSync(p, source);
  return p;
}

describe('loadGuardrailProvidersFromEnv (#3688)', () => {
  test('unset env var → no-op, distribution stays inert', async () => {
    const out = await loadGuardrailProvidersFromEnv({});
    expect(out.loaded).toBe(0);
    expect(out.modulePath).toBeNull();
    expect(hasGuardrails()).toBe(false);
  });

  test('default-exported provider registers and receives classify calls', async () => {
    const p = fixture('default-provider.mjs', `
      globalThis.__gr3688_calls = [];
      export default {
        id: 'fixture-default',
        classify(input) { globalThis.__gr3688_calls.push(input); },
      };
    `);
    const out = await loadGuardrailProvidersFromEnv({ GBRAIN_GUARDRAILS_MODULE: p });
    expect(out.loaded).toBe(1);
    expect(hasGuardrails()).toBe(true);
    await runGuardrails({ hook: 'file_storage.markdown', content: 'hello world' });
    const calls = (globalThis as Record<string, unknown>).__gr3688_calls as Array<{ hook: string; content: string }>;
    expect(calls.length).toBe(1);
    expect(calls[0].hook).toBe('file_storage.markdown');
    expect(calls[0].content).toBe('hello world');
  });

  test('default-exported provider ARRAY registers every provider', async () => {
    const p = fixture('array-provider.mjs', `
      export default [
        { id: 'fixture-a', classify() {} },
        { id: 'fixture-b', classify() {} },
      ];
    `);
    const out = await loadGuardrailProvidersFromEnv({ GBRAIN_GUARDRAILS_MODULE: p });
    expect(out.loaded).toBe(2);
  });

  test('named guardrailProviders array registers', async () => {
    const p = fixture('named-providers.mjs', `
      export const guardrailProviders = [{ id: 'fixture-named', classify() {} }];
    `);
    const out = await loadGuardrailProvidersFromEnv({ GBRAIN_GUARDRAILS_MODULE: p });
    expect(out.loaded).toBe(1);
  });

  test('register(fn) callback shape registers (async supported)', async () => {
    const p = fixture('register-fn.mjs', `
      export async function register(registerGuardrailProvider) {
        registerGuardrailProvider({ id: 'fixture-register', classify() {} });
      }
    `);
    const out = await loadGuardrailProvidersFromEnv({ GBRAIN_GUARDRAILS_MODULE: p });
    expect(out.loaded).toBe(1);
  });

  test('fail-closed: unloadable module throws GuardrailLoadError', async () => {
    await expect(
      loadGuardrailProvidersFromEnv({ GBRAIN_GUARDRAILS_MODULE: join(tmpdir(), 'gbrain-3688-does-not-exist.mjs') }),
    ).rejects.toBeInstanceOf(GuardrailLoadError);
    expect(hasGuardrails()).toBe(false);
  });

  test('fail-closed: module that registers nothing throws GuardrailLoadError', async () => {
    const p = fixture('empty-module.mjs', `export const unrelated = 42;`);
    await expect(
      loadGuardrailProvidersFromEnv({ GBRAIN_GUARDRAILS_MODULE: p }),
    ).rejects.toBeInstanceOf(GuardrailLoadError);
    expect(hasGuardrails()).toBe(false);
  });

  test('fail-closed: default export that is not a valid provider throws', async () => {
    const p = fixture('bad-shape.mjs', `export default { id: 'no-classify' };`);
    await expect(
      loadGuardrailProvidersFromEnv({ GBRAIN_GUARDRAILS_MODULE: p }),
    ).rejects.toBeInstanceOf(GuardrailLoadError);
  });
});

describe('#3688 residual — top-level side-effect registration counts', () => {
  test('a module that registers at import time is accepted, not rejected as zero-provider', async () => {
    const guardrailsUrl = new URL('../src/core/guardrails.ts', import.meta.url).href;
    const p = fixture('side-effect-provider.mjs', `
      import { registerGuardrailProvider } from '${guardrailsUrl}';
      registerGuardrailProvider({ id: 'fixture-side-effect', classify() {} });
      export default undefined;
    `);
    const out = await loadGuardrailProvidersFromEnv({ GBRAIN_GUARDRAILS_MODULE: p });
    expect(out.loaded).toBe(1);
    expect(hasGuardrails()).toBe(true);
  });

  test('a same-id REPLACEMENT counts as a registration, not zero', async () => {
    const guardrailsUrl = new URL('../src/core/guardrails.ts', import.meta.url).href;
    // Pre-register the id, then load a module that replaces it: providers.size
    // stays constant, so a size-delta count would misread the load as empty.
    const { registerGuardrailProvider } = await import('../src/core/guardrails.ts');
    registerGuardrailProvider({ id: 'fixture-replace', classify() {} });
    const p = fixture('replace-provider.mjs', `
      export default { id: 'fixture-replace', classify() {} };
    `);
    const out = await loadGuardrailProvidersFromEnv({ GBRAIN_GUARDRAILS_MODULE: p });
    expect(out.loaded).toBe(1);
    expect(hasGuardrails()).toBe(true);
  });
});

describe('cwd-relative specs and cwd-.env-assigned specs are refused', () => {
  /** Fixture whose TOP LEVEL drops a marker — proves the module was never imported. */
  function markerFixture(): { path: string; marker: string; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-guardrails-relspec-'));
    dirs.push(dir);
    const marker = join(dir, 'PROBE_RAN');
    const path = join(dir, 'probe.mjs');
    writeFileSync(path, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nexport default undefined;\n`);
    return { path, marker, dir };
  }

  test('a cwd-relative spec (./, ../, bare .) throws GuardrailLoadError WITHOUT importing', async () => {
    const { marker } = markerFixture();
    for (const spec of ['./probe.mjs', '../probe.mjs', '.']) {
      const err = await loadGuardrailProvidersFromEnv({ GBRAIN_GUARDRAILS_MODULE: spec }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(GuardrailLoadError);
      expect((err as Error).message).toContain('absolute');
    }
    expect(existsSync(marker)).toBe(false);
    expect(hasGuardrails()).toBe(false);
  });

  test('an absolute spec that a cwd .env file assigns is refused (opts.cwd)', async () => {
    const { path, marker, dir } = markerFixture();
    writeFileSync(join(dir, '.env'), 'GBRAIN_GUARDRAILS_MODULE=${PWD}/probe.mjs\n');
    await expect(
      loadGuardrailProvidersFromEnv({ GBRAIN_GUARDRAILS_MODULE: path }, { cwd: dir }),
    ).rejects.toBeInstanceOf(GuardrailLoadError);
    expect(existsSync(marker)).toBe(false);
    // Same spec, a cwd WITHOUT a .env assigning the key → loads normally.
    const clean = mkdtempSync(join(tmpdir(), 'gbrain-guardrails-clean-cwd-'));
    dirs.push(clean);
    await expect(
      loadGuardrailProvidersFromEnv({ GBRAIN_GUARDRAILS_MODULE: path }, { cwd: clean }),
    ).rejects.toBeInstanceOf(GuardrailLoadError); // imported (marker) but registers nothing
    expect(existsSync(marker)).toBe(true);
  });

  test('process.env path: the cwd check applies when env is process.env', async () => {
    const { path, marker, dir } = markerFixture();
    writeFileSync(join(dir, '.env'), 'GBRAIN_GUARDRAILS_MODULE=./probe.mjs\n');
    await withEnv({ GBRAIN_GUARDRAILS_MODULE: path }, async () => {
      await expect(loadGuardrailProvidersFromEnv(process.env, { cwd: dir })).rejects.toBeInstanceOf(GuardrailLoadError);
    });
    expect(existsSync(marker)).toBe(false);
  });
});
