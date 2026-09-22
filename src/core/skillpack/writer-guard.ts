import { OperationError } from '../ops/contract.ts';
import { lstatSync, readlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { assertLegacyFilesystemWriter, assertManagedFilesystemWrite } from '../persistence/filesystem-guard.ts';
import type { SqlEngine } from '../persistence/model.ts';

function refuse(error: unknown): never {
  if (error instanceof OperationError && error.code === 'writer_coordinator_required') {
    throw new OperationError('skill_bundle_required', 'Legacy skill writers cannot change a managed canonical worktree.',
      'Use put_skill with the catalog expected_revision and complete approved file bundle; an existing pack requires host-authorized adoptSharedSkillpack adoption. Run legacy optimization in an unmanaged working copy, then submit the reviewed result through put_skill.');
  }
  throw error;
}

export function assertLegacySkillFilesystemWrite(path: string): void {
  try { assertManagedFilesystemWrite(path); } catch (error) { refuse(error); }
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink()) return assertLegacySkillFilesystemWrite(resolve(dirname(path), readlinkSync(path)));
  if (stat.isFile() && stat.nlink > 1) throw new OperationError('skill_bundle_required',
    'Legacy skill writers cannot safely replace a multiply linked file.',
    'Use a detached unmanaged working copy, then publish the reviewed complete bundle through put_skill; adopt an existing canonical pack with host-authorized adoptSharedSkillpack.');
}

export async function assertLegacySkillWriter(engine: SqlEngine, path: string): Promise<void> {
  try { await assertLegacyFilesystemWriter(engine, path); } catch (error) { refuse(error); }
  assertLegacySkillFilesystemWrite(path);
}
