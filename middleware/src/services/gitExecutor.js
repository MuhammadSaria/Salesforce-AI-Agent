import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { redactSecrets } from '../utils/sanitize.js';
import { isPathInside } from '../utils/paths.js';

const ALLOWED = new Set(['status', 'diff', 'worktree-add', 'add', 'commit', 'rev-parse']);

export async function runGit(command, params = {}) {
  if (!ALLOWED.has(command)) throw new Error(`Blocked Git command: ${command}`);
  const args = buildArgs(command, params);
  if (args.some((arg) => /[;&|<>`\r\n]/.test(arg))) throw new Error('Git argument contains blocked shell syntax.');
  return spawnGit(args, safeCwd(params.cwd));
}

function buildArgs(command, params) {
  if (command === 'status') return ['status', '--short'];
  if (command === 'diff') return ['diff', '--no-ext-diff', ...(params.cached ? ['--cached'] : []), '--', ...(params.paths || [])];
  if (command === 'worktree-add') {
    if (!/^ai-agent\/[A-Z][A-Z0-9_]+-[0-9]+-[A-Za-z0-9_-]+$/.test(params.branch || '')) throw new Error('Invalid agent branch name.');
    const worktree = resolve(String(params.path || ''));
    if (!isPathInside(resolve(config.workspaceRoot, 'jobs'), worktree)) throw new Error('Git worktree must stay inside the jobs workspace.');
    return ['worktree', 'add', '-b', params.branch, worktree, 'HEAD'];
  }
  if (command === 'add') return ['add', '--', ...(params.paths || [])];
  if (command === 'commit') return ['commit', '-m', String(params.message || '').slice(0, 120)];
  return ['rev-parse', params.ref || 'HEAD'];
}

function safeCwd(cwd) {
  const resolved = resolve(cwd || config.projectRoot);
  const inProject = isPathInside(resolve(config.projectRoot), resolved);
  const inJobs = isPathInside(resolve(config.workspaceRoot, 'jobs'), resolved);
  if (!inProject && !inJobs) throw new Error('Git working directory is outside the project and jobs roots.');
  return resolved;
}

function spawnGit(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { shell: false, windowsHide: true, cwd, env: process.env });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ exitCode: 1, stdout: '', stderr: redactSecrets(error.message) }));
    child.on('close', (exitCode) => resolve({ exitCode, stdout: redactSecrets(stdout), stderr: redactSecrets(stderr), command: `git ${args[0]}` }));
  });
}
