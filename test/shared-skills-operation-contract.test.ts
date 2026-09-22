import { expect, test } from 'bun:test';
import { operations, operationsByName } from '../src/core/operations.ts';
import { brainMembershipOperations } from '../src/core/ops/brain-membership.ts';

test('shared skill synchronization does not replace the existing local administrator sync API', () => {
  const legacy = operationsByName.sync_brain;
  expect(legacy.scope).toBe('admin');
  expect(legacy.localOnly).toBe(true);
  expect(legacy.params.repo).toBeDefined();
  expect(legacy.params.installation_id).toBeUndefined();
  expect(operations.filter(operation => operation.name === 'sync_brain')).toHaveLength(1);
  const member = operationsByName.sync_brain_skills;
  expect(member.scope).toBe('read');
  expect(member.localOnly).not.toBe(true);
  expect(member.mutating).toBe(true);
  expect(member.requiredScopes).toEqual(['skills_member_self']);
  expect(member.params.installation_id).toBeDefined();
  expect(operations.filter(operation => operation.name === 'sync_brain_skills')).toHaveLength(1);
});

test('membership operations use the registry-contained domain array convention', () => {
  expect(Array.isArray(brainMembershipOperations)).toBe(true);
  expect(brainMembershipOperations.map(operation => operation.name)).toEqual(['join_brain', 'sync_brain_skills', 'leave_brain']);
  for (const operation of brainMembershipOperations) expect(operations).toContain(operation);
});
