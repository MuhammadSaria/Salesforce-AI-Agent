import test from 'node:test';
import assert from 'node:assert/strict';
import { sfFailureMessage } from '../src/services/agent.js';

test('Salesforce component failures take precedence over CLI warnings', () => {
  const result = {
    stderr: 'Warning: optional CLI plugin could not be loaded',
    stdout: JSON.stringify({
      result: {
        details: {
          componentFailures: [{ problem: 'Screen must allow either Back or Finish.' }]
        }
      }
    })
  };

  assert.equal(sfFailureMessage(result), 'Screen must allow either Back or Finish.');
});
