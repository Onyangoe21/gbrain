import type { BrainEngine } from '../../src/core/engine.ts';
import { installFixtureChunks } from './page-projection.ts';
import { cueSignature, memoryCueColumn, submitMemoryCueBuild, type MemoryCueProviders } from '../../src/core/memory-cues/index.ts';

export const cueEvidence = 'I do not take calls before 10.';
export function cueVector(dimensions = 1536): Float32Array {
  const vector = new Float32Array(dimensions);
  vector[0] = 1;
  return vector;
}
export const cueProviders: MemoryCueProviders = {
  async generate() {
    return { output: [{ family: 'horizon', relation: 'explicit_constraint_applies', quote: cueEvidence, text: 'Scheduling an early meeting' }], actualUsd: 0.001 };
  },
  async embed(texts, column) { return texts.map(() => cueVector(column.dimensions)); },
};

export async function seedCuePage(engine: BrainEngine, slug = 'cue-example', sourceId = 'default', body = cueEvidence) {
  await engine.putPage(slug, { title: 'Scheduling constraint', type: 'note', compiled_truth: body, timeline: '', frontmatter: {} }, { sourceId });
  await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' }], { sourceId });
}

export async function enrollCues(engine: BrainEngine, sourceIds = ['default']) {
  await engine.setConfig('memory.cues.generation_enabled', 'true');
  await engine.setConfig('memory.cues.sources', JSON.stringify(sourceIds));
  await engine.setConfig('memory.cues.read', 'on');
  await engine.setConfig('memory.cues.min_similarity', '0.5');
  await engine.setConfig('memory.cues.read_calibration_signature', cueSignature(await memoryCueColumn(engine)));
}

export async function startCueBuild(engine: BrainEngine, extra = {}) {
  return submitMemoryCueBuild(engine, { sourceIds: ['default'], trustedLocal: true, maxUsd: 1, ...extra });
}
