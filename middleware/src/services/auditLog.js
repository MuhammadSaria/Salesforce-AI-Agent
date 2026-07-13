import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { redactSecrets } from '../utils/sanitize.js';
import { appendAudit } from './jobStore.js';

export async function auditEvent(entry) {
  const safeEntry = sanitizeEntry(entry);
  if (safeEntry.jobId) {
    await appendAudit(safeEntry.jobId, safeEntry);
  }
  const auditPath = join(config.workspaceRoot, 'jobs', safeEntry.jobId || 'system', 'logs', 'audit.jsonl');
  await mkdir(dirname(auditPath), { recursive: true });
  await appendFile(auditPath, `${JSON.stringify(safeEntry)}\n`, 'utf8');
}

export async function auditSalesforceOperation(entry) {
  return auditEvent({ action: 'SALESFORCE_COMMAND', ...entry });
}

function sanitizeEntry(entry) {
  const safeMetadata = JSON.parse(redactSecrets(JSON.stringify(entry.safeMetadata || entry.metadataScope || {})));
  return {
    jobId: entry.jobId || '',
    jiraIssueKey: entry.jiraIssueKey || '',
    actor: entry.actor || 'system',
    orgRegistryId: entry.orgRegistryId || '',
    salesforceOrgId: entry.salesforceOrgId || '',
    environment: entry.environment || '',
    action: entry.action || entry.commandCategory || 'EVENT',
    timestamp: entry.timestamp || entry.endTimestamp || new Date().toISOString(),
    result: redactSecrets(entry.result || ''),
    safeMetadata
  };
}
