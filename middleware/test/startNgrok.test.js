import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';

test('ngrok launcher uses an event-loop handle to remain active', async () => {
  const source = await readFile(new URL('../src/scripts/startNgrok.js', import.meta.url), 'utf8');
  assert.match(source, /setInterval\(\(\) => \{\}, 60_000\)/);
  assert.doesNotMatch(source, /await new Promise\(\(\) => \{\}\)/);
});
