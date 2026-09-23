import { applyRedaction, planRedaction, type RedactionPlan } from '../secret-scan.ts';

export const OUTPUT_REDACTION_MAX_FIELD_CHARS = 64 * 1024;
export const OUTPUT_REDACTION_MAX_TOTAL_CHARS = 1024 * 1024;
export const OUTPUT_REDACTION_LIMIT = '<REDACTED:output_limit>';

const IDENTITY_FIELDS = new Set([
  'id', 'slug', 'source_id', 'page_id', 'chunk_id', 'message_id', 'thread_id',
  'graph_session_prefix', 'relational_seed', 'relational_path', 'superseded_by',
]);
const MAX_DEPTH = 24;
const MAX_TEXT_FIELDS = 8192;

export function redactRetrievalOutput<T, M>(results: T[], meta: M): { results: T[]; meta: M } {
  const echoValues = new Map<string, string>();
  const plans = new Map<string, RedactionPlan>();
  const writes: Array<() => void> = [];
  let remaining = OUTPUT_REDACTION_MAX_TOTAL_CHARS;
  let fields = 0;

  function copy(value: unknown, depth: number): unknown {
    if (typeof value !== 'object' || value === null) return value;
    if (depth > MAX_DEPTH) return OUTPUT_REDACTION_LIMIT;
    const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
    const out: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
    for (const [key, item] of entries) {
      let next: unknown;
      if (IDENTITY_FIELDS.has(String(key)) && (typeof item !== 'object' || item === null ||
        (Array.isArray(item) && item.every(part => typeof part === 'string')))) {
        next = Array.isArray(item) ? [...item] : item;
      } else if (typeof item === 'string') {
        let plan = plans.get(item);
        if (item.length > OUTPUT_REDACTION_MAX_FIELD_CHARS || item.length > remaining || ++fields > MAX_TEXT_FIELDS) {
          next = OUTPUT_REDACTION_LIMIT;
        } else {
          remaining -= item.length;
          if (!plan) {
            plan = planRedaction(item, { echoValues });
            plans.set(item, plan);
          }
          const planned = plan;
          writes.push(() => {
            Object.defineProperty(out, key, { value: applyRedaction(planned), enumerable: true, writable: true, configurable: true });
          });
        }
      } else {
        next = copy(item, depth + 1);
      }
      Object.defineProperty(out, key, { value: next, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }

  const output = copy({ results, meta }, 0) as { results: T[]; meta: M };
  for (const write of writes) write();
  return output;
}
