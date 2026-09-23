import { describe, expect, test } from 'bun:test';
import { memoryCueOperations, validateMemoryCueConfiguration } from '../src/core/ops/memory-cues.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';

const operation = memoryCueOperations[0];

function fixture() {
  const config = new Map<string, string>([
    ['embedding_model', 'openai:text-embedding-3-small'],
    ['embedding_dimensions', '1536'],
  ]);
  const writes: string[] = [];
  const engine = {
    executeRaw: async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('SELECT id FROM sources')) return (params?.[0] as string[]).filter(id => id === 'default').map(id => ({ id }));
      return [...config].filter(([key]) => sql.includes("LIKE 'memory.cues.%'") ? key.startsWith('memory.cues.') : !key.startsWith('memory.cues.')).map(([key, value]) => ({ key, value }));
    },
    setConfig: async (key: string, value: string) => { writes.push(key); config.set(key, value); },
    transaction: async <T>(fn: (tx: BrainEngine) => Promise<T>) => fn(engine as unknown as BrainEngine),
  };
  const ctx = {
    engine: engine as unknown as BrainEngine,
    remote: false,
    dryRun: false,
    sourceId: 'default',
    config: { engine: 'pglite' },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as OperationContext;
  return { ctx, config, writes };
}

describe('memory cue administration', () => {
  test('is a local-only admin operation, outside the seven memory verbs', () => {
    expect(operation.name).toBe('memory_cues');
    expect(operation.scope).toBe('admin');
    expect(operation.localOnly).toBe(true);
    expect(operation.verb).not.toBe(true);
    expect(operation.cliHints).toEqual({ name: 'memory-cues', positional: ['action'] });
  });

  test('rejects remote, missing trust, and subagent callers before database access', async () => {
    for (const authority of [{ remote: true }, { remote: undefined }, { remote: false, viaSubagent: true }]) {
      const ctx = { ...fixture().ctx, ...authority, engine: null } as unknown as OperationContext;
      await expect(operation.handler(ctx, { action: 'status' })).rejects.toMatchObject({ code: 'permission_denied' });
    }
  });

  test('validates explicit source enrollment and numeric boundaries', () => {
    for (const source_ids of ['default', ['__all__'], ['../outside'], [null], Array(1001).fill('default')]) {
      expect(() => validateMemoryCueConfiguration({ source_ids })).toThrow();
    }
    for (const value of [NaN, Infinity, -Infinity, -1.01, 1.01, '0.8', null]) {
      expect(() => validateMemoryCueConfiguration({ min_similarity: value })).toThrow();
      expect(() => validateMemoryCueConfiguration({ push_min_similarity: value })).toThrow();
    }
    for (const weight of [0, -1, 0.51, NaN, Infinity, '0.25']) expect(() => validateMemoryCueConfiguration({ weight })).toThrow();
    expect(validateMemoryCueConfiguration({ source_ids: ['default', 'default'], weight: 0.5, min_similarity: 1 })).toEqual({
      'memory.cues.sources': '["default"]', 'memory.cues.weight': '0.5', 'memory.cues.min_similarity': '1',
    });
    const sources = Array.from({ length: 250 }, (_, i) => `source-${i}`);
    expect(JSON.parse(validateMemoryCueConfiguration({ source_ids: sources })['memory.cues.sources'])).toEqual(sources);
  });

  test('rejects truthy strings instead of enabling paid enrichment', () => {
    expect(() => validateMemoryCueConfiguration({ generation_enabled: 'true' })).toThrow();
    expect(() => validateMemoryCueConfiguration({ push_enabled: 1 })).toThrow();
    expect(() => validateMemoryCueConfiguration({ read_mode: 'enabled' })).toThrow();
    for (const families of [[], 'scene', ['invented'], ['scene', 'scene', 'scene', 'scene']]) {
      expect(() => validateMemoryCueConfiguration({ families })).toThrow();
    }
    expect(validateMemoryCueConfiguration({ families: ['horizon', 'scene', 'scene'] })).toEqual({ 'memory.cues.families': '["horizon","scene"]' });
  });

  test('configuration is preview-only without apply and under dry-run', async () => {
    for (const dryRun of [false, true]) {
      const { ctx, writes } = fixture();
      ctx.dryRun = dryRun;
      const result = await operation.handler(ctx, { action: 'configure', generation_enabled: true, ...(dryRun ? { apply: true } : {}) });
      expect(result).toMatchObject({ applied: false });
      expect(writes).toEqual([]);
    }
  });

  test('missing and archived source enrollment cannot be applied', async () => {
    const { ctx, writes } = fixture();
    await expect(operation.handler(ctx, { action: 'configure', source_ids: ['missing-example'], apply: true })).rejects.toMatchObject({ code: 'not_found' });
    expect(writes).toEqual([]);
  });

  test('read calibration never certifies an existing push threshold', async () => {
    const { ctx, writes, config } = fixture();
    config.set('memory.cues.push_calibration_signature', 'old-model');
    const result = await operation.handler(ctx, { action: 'configure', min_similarity: 0.7, apply: true });
    expect(result).toMatchObject({ applied: true });
    expect(writes).toContain('memory.cues.read_calibration_signature');
    expect(writes).not.toContain('memory.cues.push_calibration_signature');
    expect(config.get('memory.cues.push_calibration_signature')).toBe('old-model');
    expect(config.get('memory.auto_writeback')).toBeUndefined();
  });

  test('push calibration is independently explicit', async () => {
    const { ctx, writes } = fixture();
    await operation.handler(ctx, { action: 'configure', push_min_similarity: 0.9, apply: true });
    expect(writes).toContain('memory.cues.push_calibration_signature');
    expect(writes).not.toContain('memory.cues.read_calibration_signature');
  });

  test('unknown actions and empty configuration are rejected', async () => {
    const { ctx, writes } = fixture();
    await expect(operation.handler(ctx, { action: 'unlimited-build', apply: true })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(operation.handler(ctx, { action: 'configure', apply: true })).rejects.toMatchObject({ code: 'invalid_params' });
    expect(writes).toEqual([]);
  });

  test('the incident off switch works even when the embedding registry is broken', async () => {
    const { ctx, config } = fixture();
    config.set('search_embedding_column', 'unregistered_example');
    config.set('memory.cues.read', 'on');
    config.set('memory.cues.push', 'true');
    config.set('memory.cues.min_similarity', '0.7');
    config.set('memory.cues.push_min_similarity', '0.9');
    expect(await operation.handler(ctx, { action: 'configure', generation_enabled: false, read_mode: 'off', push_enabled: false, apply: true })).toMatchObject({
      applied: true, settings: { generationEnabled: false, readMode: 'off', pushEnabled: false },
    });
  });
});
