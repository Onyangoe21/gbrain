import { OperationError, type ParamDef } from '../ops/contract.ts';

/** Capture input sugar stays data; the owner materializes generated fields once. */
export const CAPTURE_EVENT_PARAMS: Record<string, ParamDef> = {
  who: { type: 'string', description: 'For event captures, comma-separated entity slugs.' },
  what: { type: 'string', description: 'For event captures, the event description.' },
  where: { type: 'string', description: 'For event captures, the location.' },
  kind: { type: 'string', description: 'For event captures, the event kind.' },
  depth: { type: 'string', description: 'For event captures, the depth page to link.' },
};
import { WRITE_REQUEST_STATES } from './types.ts';

/** Leaf definitions: safe to import while the frozen verb registry is evaluating. */
export const WRITE_REQUEST_PARAM: ParamDef = {
  type: 'string',
  description: 'Optional caller-generated UUID for this write. Reuse the same UUID and original arguments to recover its outcome after a timeout; a different intent requires a new UUID.',
};

export const PAGE_MUTATION_PARAMS: Record<string, ParamDef> = {
  source_id: {
    type: 'string',
    description: 'Source to mutate. Defaults to the selected source. Remote callers may only use their current write source.',
  },
  expected_revision: {
    type: 'string',
    description: 'Revision returned by the page read. Required when replacing an existing page unless force is true. Omit both for create-only writes.',
  },
  force: {
    type: 'boolean',
    description: 'Explicitly overwrite the current revision. Mutually exclusive with expected_revision; does not bypass authorization or the empty-content guard.',
  },
  request_id: WRITE_REQUEST_PARAM,
};

/** Additive response schema shared by frozen memory-verb success and error envelopes. */
export const WRITE_RECEIPT_SCHEMA = {
  type: 'object',
  required: ['request_id', 'state', 'retry_after_ms'],
  properties: {
    request_id: { type: 'string' },
    state: { type: 'string', enum: [...WRITE_REQUEST_STATES] },
    retry_after_ms: { type: ['integer', 'null'] },
    revision: { type: 'string' },
    compacted: { type: 'boolean' },
    outcome: { type: 'object' },
    persistence: {
      type: 'object',
      required: ['mode'],
      properties: {
        mode: { type: 'string', enum: ['filesystem', 'database'] },
        file_written: { type: 'boolean' },
        git_state: { type: 'string' },
      },
    },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
  },
};

/** Shape/trust checks do not read the current page or resolve a replay target. */
export function assertPurgeParams(params: Record<string, unknown>, remote: boolean | undefined): void {
  if (params.purge !== undefined && typeof params.purge !== 'boolean') {
    throw new OperationError('invalid_params', 'purge must be a boolean.', 'Pass purge: true (CLI: gbrain delete <slug> --purge).');
  }
  if (params.purge === true && remote !== false) {
    throw new OperationError('permission_denied', 'purge is only available to the local CLI.',
      'Remote callers soft-delete only; run `gbrain delete <slug> --purge` on the host to remove a page immediately.');
  }
}
