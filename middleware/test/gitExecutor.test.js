import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGitArgs, runGit } from '../src/services/gitExecutor.js';

test('baseline commits are structured and may be immutable empty commits', () => {
  assert.deepEqual(buildGitArgs('commit', { message: 'baseline', allowEmpty: true }), ['commit', '--allow-empty', '-m', 'baseline']);
  assert.deepEqual(buildGitArgs('status'), ['status', '--short', '--untracked-files=all']);
  assert.deepEqual(buildGitArgs('add', { paths: ['force-app/main/default/flows/Test.flow-meta.xml'] }), ['add', '--', 'force-app/main/default/flows/Test.flow-meta.xml']);
});

test('blocks unsupported Git commands and shell syntax', async () => {
  await assert.rejects(() => runGit('push'), /Blocked Git command/);
  await assert.rejects(() => runGit('commit', { message: 'baseline; deploy' }), /blocked shell syntax/i);
});
