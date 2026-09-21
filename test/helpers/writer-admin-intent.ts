import type { BrainEngine } from '../../src/core/engine.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import type { PersistenceAdminOperation } from '../../src/core/persistence/admin-contract.ts';

export async function reviewedWriterIntent(engine: BrainEngine, operation: PersistenceAdminOperation) {
  const status = await runPersistenceAdministration(engine, 'writer_status', {});
  return { admin_intent: operation, expected_state: status.admin_state };
}
