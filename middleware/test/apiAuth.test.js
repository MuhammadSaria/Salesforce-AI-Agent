import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createApp } from '../src/server.js';

test('API rejects missing authentication and accepts configured bearer token', async (t) => {
  config.apiAuthToken = 'unit-test-token';
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/orgs`)).status, 401);
  assert.equal((await fetch(`${base}/api/orgs`, { headers: { Authorization: 'Bearer unit-test-token' } })).status, 200);
});

test('API accepts trusted Salesforce Apex context when the Named Credential is anonymous', async (t) => {
  config.apiAuthToken = 'unit-test-token';
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    'X-Agent-Source': 'Salesforce-Apex',
    'X-Agent-Org-Id': '00Dg500000E07e9EAB',
    'X-Agent-User-Id': '005g5000009ImIkAAK',
    'X-Agent-Role': 'developer'
  };
  assert.equal((await fetch(`${base}/api/orgs`, { headers })).status, 200);
});
