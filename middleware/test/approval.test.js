import test from 'node:test';
import assert from 'node:assert/strict';
import { latestApprovedApproval } from '../src/domain/approval.js';

test('a later deployment rejection invalidates an earlier approval', () => {
  const job = { approvals: [
    { approvalType: 'DEPLOYMENT', validationId: 'validation-1', decision: 'APPROVED' },
    { approvalType: 'DEPLOYMENT', validationId: 'validation-1', decision: 'REJECTED' }
  ] };
  assert.equal(latestApprovedApproval(job, 'DEPLOYMENT', 'validation-1'), null);
});

test('approval decisions are isolated by validation ID', () => {
  const current = { approvalType: 'DEPLOYMENT', validationId: 'validation-2', decision: 'APPROVED' };
  const job = { approvals: [
    { approvalType: 'DEPLOYMENT', validationId: 'validation-1', decision: 'REJECTED' },
    current
  ] };
  assert.equal(latestApprovedApproval(job, 'DEPLOYMENT', 'validation-2'), current);
});
