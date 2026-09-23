import { describe, expect, test } from 'bun:test';
import { buildCueWindows, validateCueOutput, groundCueQuote } from '../src/core/memory-cues/windows.ts';
import { cueSignature, unsupportedCueColumn } from '../src/core/memory-cues/settings.ts';

describe('bounded situation cue validation', () => {
  test('overlaps long chunks and preserves the end without exceeding the byte/token ceiling', () => {
    const text = 'A'.repeat(625) + 'Decision boundary.' + '界'.repeat(1000) + 'last evidence';
    const windows = buildCueWindows([{ id: 1, chunk_text: text }]);
    expect(windows.length).toBeGreaterThan(3);
    expect(windows.every(w => Buffer.byteLength(w.text) <= 800)).toBe(true);
    expect(windows.some(w => w.text.includes('Decision boundary.'))).toBe(true);
    expect(windows.at(-1)!.text).toContain('last evidence');
    expect(buildCueWindows([{ id: 1, chunk_text: text }])).toEqual(windows);
  });

  test('small neighboring chunks share a bounded boundary window', () => {
    const windows = buildCueWindows([{ id: 1, chunk_text: 'First turn constraint.' }, { id: 2, chunk_text: 'Second turn decision.' }]);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.text).toContain('First turn constraint.\nSecond turn decision.');
    expect(windows[0]!.spans.map(s => s.chunkId)).toEqual([1, 2]);
  });

  test('keeps role markers intact and carries their original attribution into long-turn continuations', () => {
    const body = `## User\n${'A'.repeat(625)}\n## Assistant\n${'B'.repeat(210)}\n## User\nNo calls before ten.`;
    const windows = buildCueWindows([{ id: 7, chunk_text: body }]);
    expect(windows.length).toBeGreaterThan(1);
    expect(windows.every(w => Buffer.byteLength(w.text) <= 800)).toBe(true);
    expect(windows.some(w => w.text.includes(`## Assistant\n${'B'.repeat(210)}`))).toBe(true);
    for (const window of windows) {
      expect(window.text).toMatch(/^## (?:User|Assistant)\n/);
      for (const heading of window.text.split('\n').filter(line => line.startsWith('#'))) expect(['## User', '## Assistant']).toContain(heading);
    }
  });

  test('derives bounded multi-span grounding from the complete cross-chunk quote, not model IDs', () => {
    const first = `🙂 ${'Prelude. '.repeat(35)}I cannot accept any morning call before`;
    const second = 'ten because I cover the morning school run.';
    const window = buildCueWindows([{ id: 11, chunk_text: first }, { id: 22, chunk_text: second }])[0]!;
    const quote = 'I cannot accept any morning call before\nten because I cover the morning school run.';
    expect(groundCueQuote(window, quote)).toEqual([
      { chunk_id: 11, start: Array.from(first.slice(0, first.indexOf('I cannot'))).length, end: Array.from(first).length, separator: '' },
      { chunk_id: 22, start: 0, end: second.length, separator: '\n' },
    ]);
    const cue = { family: 'horizon', relation: 'explicit_constraint_applies', quote, text: 'Scheduling an early meeting', chunk_ids: [99999] };
    expect(validateCueOutput([cue], window)[0]).not.toHaveProperty('chunk_ids');
    expect(groundCueQuote(window, quote.replace('morning school run', 'invented reason'))).toBeNull();
  });

  test('lowercase role labels remain intact across the active byte boundary', () => {
    for (const size of [625, 775, 785, 795, 1200]) {
      const body = `user: ${'A'.repeat(size)}\nassistant: ${'B'.repeat(210)}\nuser: No calls before ten.`;
      const windows = buildCueWindows([{ id: 8, chunk_text: body }]);
      expect(windows.every(window => Buffer.byteLength(window.text) <= 800)).toBe(true);
      expect(windows.every(window => /^(?:user|assistant):/.test(window.text))).toBe(true);
      expect(windows.some(window => window.text.includes(`assistant: ${'B'.repeat(210)}`))).toBe(true);
      expect(buildCueWindows([{ id: 8, chunk_text: body }])).toEqual(windows);
    }
  });

  test('requires exact supporting text, allowed relations and explicit bridge opt-in', () => {
    const window = buildCueWindows([{ id: 1, chunk_text: 'I do not take calls before 10.' }])[0]!;
    const cue = { family: 'horizon' as const, relation: 'explicit_constraint_applies', quote: 'I do not take calls before 10.', text: 'Scheduling an early meeting' };
    expect(validateCueOutput([cue], window)).toEqual([cue]);
    expect(validateCueOutput([], window)).toEqual([]);
    for (const invalid of [null, {}, [cue, cue, cue, cue], [cue, cue, cue, cue, cue], [{ ...cue, quote: 'different' }], [{ ...cue, relation: 'invented' }],
      [{ ...cue, family: 'bridge' }], [{ ...cue, text: 'Introverted personality' }], [{ ...cue, text: 'chronic fatigue diagnosis' }], [{ ...cue, text: 'a'.repeat(241) }]]) {
      expect(() => validateCueOutput(invalid, window)).toThrow();
    }
  });

  test('signature includes model identity and rejects unindexable widths', () => {
    const column = { name: 'embedding', type: 'vector' as const, dimensions: 1536, embeddingModel: 'openai:text-embedding-3-small' };
    expect(cueSignature(column)).not.toBe(cueSignature({ ...column, embeddingModel: 'other:same-width' }));
    expect(unsupportedCueColumn(column)).toBeUndefined();
    expect(unsupportedCueColumn({ ...column, dimensions: 3072 })).toBe('unsupported_embedding_signature');
    expect(unsupportedCueColumn({ ...column, type: 'halfvec', dimensions: 3072 })).toBeUndefined();
  });
});
