import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calculateSourceHash } from '../src/services/agent.js';

test('source hash changes when implemented file bytes change', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-source-hash-'));
  const relativePath = 'force-app/main/default/flows/Test.flow-meta.xml';
  const fullPath = join(projectRoot, relativePath);
  const plan = { planHash: 'approved-plan', dataOperations: [] };

  try {
    await mkdir(join(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, '<Flow><status>Draft</status></Flow>', 'utf8');
    const first = await calculateSourceHash(projectRoot, [relativePath], plan);
    await writeFile(fullPath, '<Flow><status>Active</status></Flow>', 'utf8');
    const second = await calculateSourceHash(projectRoot, [relativePath], plan);
    assert.notEqual(first, second);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
