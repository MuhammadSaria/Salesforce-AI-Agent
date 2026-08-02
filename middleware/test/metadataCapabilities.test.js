import test from 'node:test';
import assert from 'node:assert/strict';
import { retrieveMetadata, buildSfCommandArgs } from '../src/services/sfExecutor.js';
import { trustOrgContext } from '../src/services/orgContextTrust.js';

test('retrieveMetadata renders one explicit metadata argument per verified component and target org', async () => {
  const calls = [];
  const result = await retrieveMetadata({
    components: [
      { type: 'Flow', apiName: 'A_Flow' },
      { type: 'CustomObject', apiName: 'GiftTransaction' }
    ],
    orgContext: trustedContext(),
    executor: async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: '{}', stderr: '', command: `sf ${args.join(' ')}` };
    },
    verifier: async () => ({ organizationId: ORG_ID })
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls[0], [
    'project', 'retrieve', 'start',
    '--metadata', 'CustomObject:GiftTransaction',
    '--metadata', 'Flow:A_Flow',
    '--target-org', 'verified-alias',
    '--json'
  ]);
});

test('retrieveMetadata respects org operation policy before CLI execution', async () => {
  let invoked = false;
  await assert.rejects(
    retrieveMetadata({
      components: [{ type: 'Flow', apiName: 'A_Flow' }],
      orgContext: trustedContext({ allowedOperations: ['read'] }),
      executor: async () => {
        invoked = true;
        return { exitCode: 0, stdout: '{}', stderr: '' };
      },
      verifier: async () => ({ organizationId: ORG_ID })
    }),
    /Operation retrieve is not allowed/
  );
  assert.equal(invoked, false);
});

test('Tooling API query renders explicit Salesforce CLI tooling flag and target org', () => {
  const args = buildSfCommandArgs('toolingQuery', {
    query: 'SELECT ApiName FROM FlowDefinitionView LIMIT 1',
    targetOrg: 'verified-alias'
  });

  assert.deepEqual(args, [
    'data', 'query',
    '--query', 'SELECT ApiName FROM FlowDefinitionView LIMIT 1',
    '--target-org', 'verified-alias',
    '--use-tooling-api',
    '--json'
  ]);
});

const ORG_ID = '00Dg500000E07e9EAB';

function trustedContext(overrides = {}) {
  return trustOrgContext({
    orgRegistryId: 'providus_orgfarm_dev',
    salesforceAlias: 'verified-alias',
    expectedOrgId: ORG_ID,
    environment: 'developer',
    instanceUrl: 'https://orgfarm-9914d7f2f7-dev-ed.develop.my.salesforce.com',
    allowedOperations: ['read', 'retrieve', 'validate'],
    allowedMetadataTypes: ['CustomObject', 'Flow'],
    restrictedMetadataTypes: [],
    productionApprovalRequired: false,
    ...overrides
  });
}
