import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

test('live production modules do not import legacy jobStore globals directly', async () => {
  for (const modulePath of await sourceFiles(join(process.cwd(), 'src'))) {
    if (modulePath.endsWith('src\\persistence\\jobStore.js') || modulePath.endsWith('src/persistence/jobStore.js')) continue;
    const source = await readFile(join(process.cwd(), modulePath), 'utf8');
    assert.doesNotMatch(
      source,
      /from ['"].*services\/jobStore\.js['"]/,
      `${modulePath} must receive the unified JobStore through dependency injection`
    );
  }
});

async function sourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    if (entry.isFile() && entry.name.endsWith('.js')) files.push(path.slice(process.cwd().length + 1));
  }
  return files;
}
