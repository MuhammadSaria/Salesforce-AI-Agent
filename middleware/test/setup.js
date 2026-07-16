import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testWorkspace = mkdtempSync(join(tmpdir(), 'providus-nexus-tests-'));

process.env.NODE_ENV = 'test';
process.env.QUEUE_DRIVER = 'memory';
process.env.AGENT_BACKEND = 'disabled';
process.env.WORKSPACE_ROOT = testWorkspace;

process.on('exit', () => {
  rmSync(testWorkspace, { recursive: true, force: true });
});
