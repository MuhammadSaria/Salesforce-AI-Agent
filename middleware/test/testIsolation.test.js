import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { config } from '../src/config.js';

test('middleware tests isolate durable job snapshots from the live workspace', () => {
  const liveWorkspace = resolve(process.cwd(), '..');
  const testWorkspace = resolve(config.workspaceRoot);
  const relativeToTemp = relative(resolve(tmpdir()), testWorkspace);

  assert.notEqual(testWorkspace, liveWorkspace);
  assert.ok(relativeToTemp && !relativeToTemp.startsWith('..') && !isAbsolute(relativeToTemp));
});
