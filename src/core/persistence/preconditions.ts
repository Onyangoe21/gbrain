import { OperationError } from '../ops/contract.ts';
import { isWriteRequestId, type MutationPrecondition } from './types.ts';

export function parseWriteRequestId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isWriteRequestId(value)) {
    throw new OperationError('invalid_params', 'request_id must be a UUID.',
      'Generate a UUID before submitting the write and reuse it for retries of the same request.');
  }
  return value.toLowerCase();
}

/** Syntax only; the coordinator checks the revision under its mutation lock. */
export function parseMutationPrecondition(params: Record<string, unknown>): MutationPrecondition {
  const expected = params.expected_revision;
  if (expected !== undefined && !isWriteRequestId(expected)) {
    throw new OperationError('invalid_params', 'expected_revision must be the UUID returned by a page read.',
      'Read the current page and pass its revision unchanged.');
  }
  if (params.force !== undefined && typeof params.force !== 'boolean') {
    throw new OperationError('invalid_params', 'force must be a boolean.', 'Pass force: true only for an intentional overwrite.');
  }
  if (expected !== undefined && params.force === true) {
    throw new OperationError('invalid_params', 'expected_revision and force: true are mutually exclusive.',
      'Use the observed revision for a conditional edit or force: true for an intentional overwrite.');
  }
  const requestId = parseWriteRequestId(params.request_id);
  return {
    ...(expected !== undefined ? { expected_revision: expected.toLowerCase() } : {}),
    ...(params.force !== undefined ? { force: params.force } : {}),
    ...(requestId !== undefined ? { request_id: requestId } : {}),
  };
}

/** Keep wire idempotency separate from engine row preconditions. */
export function engineMutationPrecondition(precondition: MutationPrecondition): { expectedRevision?: string; force?: boolean } {
  return {
    ...(precondition.expected_revision !== undefined ? { expectedRevision: precondition.expected_revision } : {}),
    ...(precondition.force !== undefined ? { force: precondition.force } : {}),
  };
}

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
