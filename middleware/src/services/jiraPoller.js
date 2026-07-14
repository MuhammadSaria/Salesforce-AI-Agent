import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { enqueueAgentJob } from '../queue/agentQueue.js';
import { createJobRecord, listJobRecords } from './jobStore.js';

let polling = false;

export function startJiraPoller() {
  if (!isConfigured() || config.jiraPollIntervalSeconds <= 0) return null;
  const poll = () => pollAssignedJiraIssues().catch((error) => logger.error({ error }, 'Jira polling failed'));
  const timer = setInterval(poll, config.jiraPollIntervalSeconds * 1000);
  timer.unref();
  setTimeout(poll, 1000).unref();
  logger.info({ intervalSeconds: config.jiraPollIntervalSeconds, projects: config.jiraAllowedProjectKeys }, 'Jira assignment polling enabled');
  return timer;
}

export async function pollAssignedJiraIssues() {
  if (polling || !isConfigured()) return [];
  polling = true;
  try {
    const existingByKey = new Map((await listJobRecords()).filter((job) => job.jiraIssueKey).map((job) => [job.jiraIssueKey, job]));
    const issues = await searchAssignedIssues();
    const created = [];
    for (const issue of issues) {
      const existing = existingByKey.get(issue.key);
      if (existing) {
        await enqueueAgentJob({ jobId: existing.jobId, action: 'sync-jira', actor: 'jira-poller' }, { jobId: `${existing.jobId}:jira-sync:${issue.updated || Date.now()}` });
        continue;
      }
      const job = await createJobRecord({ jobId: nanoid(), prompt: `Analyze Jira issue ${issue.key}`, jiraIssueKey: issue.key, source: 'jira-poll', userId: 'jira-poller', context: {} });
      await enqueueAgentJob({ jobId: job.jobId, action: 'analyze', actor: 'jira-poller' }, { jobId: `${job.jobId}:analyze:1` });
      existingByKey.set(issue.key, job);
      created.push({ jobId: job.jobId, jiraIssueKey: issue.key });
    }
    if (created.length) logger.info({ created }, 'Assigned Jira issues queued by polling fallback');
    return created;
  } finally {
    polling = false;
  }
}

export function buildAssignedIssuesJql(projectKeys = config.jiraAllowedProjectKeys, accountId = config.jiraAgentAccountId) {
  const projects = projectKeys.map((key) => String(key).toUpperCase()).filter((key) => /^[A-Z][A-Z0-9_]{1,19}$/.test(key));
  if (!projects.length || !accountId) throw new Error('Jira polling requires allowed projects and an agent account ID.');
  return `project IN (${projects.join(',')}) AND assignee = \"${String(accountId).replace(/[\"\\]/g, '')}\" ORDER BY updated DESC`;
}

async function searchAssignedIssues() {
  const base = config.jiraBaseUrl.replace(/\/$/, '');
  const url = `${base}/rest/api/3/search/jql?jql=${encodeURIComponent(buildAssignedIssuesJql())}&maxResults=50&fields=key,updated`;
  const authorization = Buffer.from(`${config.jiraEmail}:${config.jiraApiToken}`).toString('base64');
  const response = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Basic ${authorization}` } });
  if (!response.ok) throw new Error(`Jira polling failed with status ${response.status}.`);
  const payload = await response.json();
  return (payload.issues || []).map((issue) => ({ key: String(issue.key || '').toUpperCase(), updated: String(issue.fields?.updated || '') })).filter((issue) => /^[A-Z][A-Z0-9_]{1,19}-[1-9][0-9]{0,9}$/.test(issue.key));
}

function isConfigured() {
  return Boolean(config.jiraBaseUrl && config.jiraEmail && config.jiraApiToken && config.jiraAgentAccountId && config.jiraAllowedProjectKeys.length);
}
