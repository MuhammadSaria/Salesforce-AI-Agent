import test from 'node:test';
import assert from 'node:assert/strict';
import { isSafeSalesforceSourcePath, metadataComponentFromPath } from '../src/domain/metadataCapabilities.js';
import { SPECIALIST_AGENT_IDS, ownerForFile, ownerForMetadataType, selectSpecialistAgents } from '../src/domain/specialistAgents.js';

test('routes reports, dashboards, and other general metadata to one specialist owner', () => {
  assert.equal(ownerForMetadataType('Report'), SPECIALIST_AGENT_IDS.GENERAL_METADATA);
  assert.equal(ownerForMetadataType('Dashboard'), SPECIALIST_AGENT_IDS.GENERAL_METADATA);
  assert.equal(ownerForFile('force-app/main/default/reports/Sales/Monthly.report-meta.xml'), SPECIALIST_AGENT_IDS.GENERAL_METADATA);
  assert.equal(ownerForFile('force-app/main/default/pages/CustomerPortal.page'), SPECIALIST_AGENT_IDS.GENERAL_METADATA);
});

test('preserves existing specialist ownership for Aura and object metadata', () => {
  assert.equal(ownerForFile('force-app/main/default/aura/LegacyCard/LegacyCard.cmp'), SPECIALIST_AGENT_IDS.LWC);
  assert.equal(ownerForFile('force-app/main/default/objects/Account/fields/Reference__c.field-meta.xml'), SPECIALIST_AGENT_IDS.OBJECT_FIELD);
});

test('maps nested report and dashboard paths to deployable metadata components', () => {
  assert.deepEqual(metadataComponentFromPath('force-app/main/default/reports/Sales/Monthly.report-meta.xml'), { type: 'Report', apiName: 'Sales/Monthly' });
  assert.deepEqual(metadataComponentFromPath('force-app/main/default/dashboards/Executive/Revenue.dashboard-meta.xml'), { type: 'Dashboard', apiName: 'Executive/Revenue' });
});

test('allows safe Salesforce text source and rejects executable or escaping paths', () => {
  for (const path of [
    'force-app/main/default/reports/Sales/Monthly.report-meta.xml',
    'force-app/main/default/aura/LegacyCard/LegacyCard.cmp',
    'force-app/main/default/pages/CustomerPortal.page',
    'force-app/main/default/email/Support/Reply.email'
  ]) assert.equal(isSafeSalesforceSourcePath(path), true, path);

  for (const path of [
    'force-app/main/default/reports/../../.env',
    'force-app/main/default/staticresources/payload.exe',
    'force-app/main/default/scripts/deploy.ps1',
    '.env'
  ]) assert.equal(isSafeSalesforceSourcePath(path), false, path);
});

test('selects the general metadata specialist for report work', () => {
  const selected = selectSpecialistAgents({ summary: 'Create a Salesforce report for open Cases.' }, {}, { fileOperations: [] });
  assert.ok(selected.includes(SPECIALIST_AGENT_IDS.GENERAL_METADATA));
  assert.ok(selected.includes(SPECIALIST_AGENT_IDS.TESTING));
  assert.ok(selected.includes(SPECIALIST_AGENT_IDS.VALIDATION_DEPLOYMENT));
});
