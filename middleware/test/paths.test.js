import test from 'node:test';
import assert from 'node:assert/strict';
import { isPathInside } from '../src/utils/paths.js';

test('isPathInside accepts the root itself and nested descendants', () => {
  assert.equal(isPathInside('/srv/jobs', '/srv/jobs'), true);
  assert.equal(isPathInside('/srv/jobs', '/srv/jobs/abc/record.json'), true);
});

test('isPathInside rejects parent and sibling paths', () => {
  assert.equal(isPathInside('/srv/jobs', '/srv'), false);
  assert.equal(isPathInside('/srv/jobs', '/srv/jobs-evil'), false);
  assert.equal(isPathInside('/srv/jobs', '/etc/passwd'), false);
});

test('isPathInside rejects Windows cross-drive containment bypass', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only drive-letter semantics');
  // relative('C:\\proj\\jobs', 'D:\\evil') returns 'D:\\evil' (absolute), not '..'.
  assert.equal(isPathInside('C:\\proj\\jobs', 'D:\\evil\\package.xml'), false);
  assert.equal(isPathInside('C:\\proj\\jobs', 'C:\\proj\\jobs\\a\\record.json'), true);
});
