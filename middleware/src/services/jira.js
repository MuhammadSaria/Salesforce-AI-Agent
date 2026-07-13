import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { redis } from '../queue/connection.js';
import { sanitizeUntrustedText } from '../utils/sanitize.js';

const memoryEvents = new Set();

export function verifyJiraWebhook(rawBody, signature, webhookToken) {
  if (!config.jiraWebhookSecret) throw unauthorized('Jira webhook secret is not configured.');
  if (safeEqual(String(webhookToken || ''), config.jiraWebhookSecret)) return;
  const supplied = String(signature || '').replace(/^sha256=/i, '');
  const expected = createHmac('sha256', config.jiraWebhookSecret).update(rawBody).digest('hex');
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw unauthorized('Invalid Jira webhook signature.');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export async function claimWebhookEvent(eventId) {
  const key = `jira-webhook:${eventId}`;
  if (redis) return (await redis.set(key, '1', 'EX', 86400 * 7, 'NX')) === 'OK';
  if (memoryEvents.has(key)) return false;
  memoryEvents.add(key);
  return true;
}

export function parseJiraWebhook(payload) {
  const event = String(payload?.webhookEvent || '');
  if (!['jira:issue_created', 'jira:issue_updated'].includes(event)) throw unsupported('Unsupported Jira event.');
  const issue = normalizeIssue(payload.issue);
  enforceAllowedIssue(issue);
  if (config.jiraAgentAccountId && issue.assigneeAccountId !== config.jiraAgentAccountId) throw unsupported('Issue is not assigned to the configured AI agent.');
  return { event, issue };
}

export async function getJiraIssue(issueKey) {
  validateIssueKey(issueKey);
  assertConfigured();
  const response = await fetch(`${config.jiraBaseUrl.replace(/\/$/, '')}/rest/api/3/issue/${encodeURIComponent(issueKey)}?expand=renderedFields,names`, {
    headers: { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${config.jiraEmail}:${config.jiraApiToken}`).toString('base64')}` }
  });
  if (!response.ok) throw new Error(`Jira issue retrieval failed with status ${response.status}.`);
  const issue = normalizeIssue(await response.json());
  enforceAllowedIssue(issue);
  return issue;
}

export async function addJiraComment(issueKey, body) {
  validateIssueKey(issueKey);
  assertConfigured();
  const response = await fetch(`${config.jiraBaseUrl.replace(/\/$/, '')}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${config.jiraEmail}:${config.jiraApiToken}`).toString('base64')}` },
    body: JSON.stringify({ body: adfDocument(sanitizeUntrustedText(body, 12000)) })
  });
  if (!response.ok) throw new Error(`Jira comment update failed with status ${response.status}.`);
}

function normalizeIssue(issue) {
  const fields = issue?.fields || {};
  const key = String(issue?.key || '').toUpperCase();
  validateIssueKey(key);
  return {
    key,
    projectKey: key.split('-')[0],
    summary: sanitizeUntrustedText(fields.summary, 500),
    description: sanitizeUntrustedText(extractAdfText(fields.description), 20000),
    acceptanceCriteria: sanitizeUntrustedText(fields.acceptanceCriteria || fields.customfield_acceptance_criteria, 10000),
    comments: (fields.comment?.comments || []).slice(-50).map((comment) => sanitizeUntrustedText(extractAdfText(comment.body), 4000)),
    attachments: (fields.attachment || []).map(({ id, filename, mimeType, size }) => ({ id: String(id), filename: sanitizeUntrustedText(filename, 255), mimeType, size })),
    priority: sanitizeUntrustedText(fields.priority?.name, 100),
    reporter: sanitizeUntrustedText(fields.reporter?.displayName, 200),
    assignee: sanitizeUntrustedText(fields.assignee?.displayName, 200),
    assigneeAccountId: String(fields.assignee?.accountId || ''),
    labels: (fields.labels || []).map((value) => sanitizeUntrustedText(value, 100)),
    components: (fields.components || []).map((value) => sanitizeUntrustedText(value.name, 100)),
    environment: sanitizeUntrustedText(fields.environment, 500),
    status: sanitizeUntrustedText(fields.status?.name, 100),
    linkedIssues: (fields.issuelinks || []).map((link) => link.outwardIssue?.key || link.inwardIssue?.key).filter(Boolean),
    customFields: Object.fromEntries(Object.entries(fields).filter(([key]) => key.startsWith('customfield_')).map(([key, value]) => [key, sanitizeUntrustedText(extractJiraFieldValue(value), 2000)]))
  };
}

function enforceAllowedIssue(issue) {
  if (config.jiraAllowedProjectKeys.length && !config.jiraAllowedProjectKeys.includes(issue.projectKey)) throw unsupported('Jira project is not allowed.');
}

function validateIssueKey(key) {
  if (!/^[A-Z][A-Z0-9_]{1,19}-[1-9][0-9]{0,9}$/.test(String(key || '').toUpperCase())) throw unsupported('Invalid Jira issue key.');
}

function extractAdfText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractAdfText).join(' ');
  if (value && typeof value === 'object') return [value.text, extractAdfText(value.content)].filter(Boolean).join(' ');
  return '';
}

function extractJiraFieldValue(value) {
  if (Array.isArray(value)) return value.map(extractJiraFieldValue).filter(Boolean).join(', ');
  if (value && typeof value === 'object') {
    return extractAdfText(value) || String(value.value || value.name || value.id || '').trim();
  }
  return extractAdfText(value);
}

function adfDocument(text) {
  return { type: 'doc', version: 1, content: text.split('\n').filter(Boolean).map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })) };
}

function assertConfigured() {
  if (!config.jiraBaseUrl || !config.jiraEmail || !config.jiraApiToken) throw new Error('Jira API is not configured.');
}

function unauthorized(message) { const error = new Error(message); error.statusCode = 401; return error; }
function unsupported(message) { const error = new Error(message); error.statusCode = 422; return error; }
