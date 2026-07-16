import { sanitizeUntrustedText } from '../utils/sanitize.js';

export const PROVIDUS_NEXUS = 'Providus Nexus';

export const JIRA_COMMENT_INTENTS = Object.freeze({
  CHANGE_REQUEST: 'CHANGE_REQUEST',
  CONSTRAINT: 'CONSTRAINT',
  BUG_REPORT: 'BUG_REPORT',
  QUESTION: 'QUESTION',
  EXPLANATION_REQUEST: 'EXPLANATION_REQUEST',
  ENVIRONMENT_QUESTION: 'ENVIRONMENT_QUESTION',
  DEPLOYMENT_SCHEDULING: 'DEPLOYMENT_SCHEDULING',
  SOCIAL: 'SOCIAL'
});

const REVISION_INTENTS = new Set([
  JIRA_COMMENT_INTENTS.CHANGE_REQUEST,
  JIRA_COMMENT_INTENTS.CONSTRAINT,
  JIRA_COMMENT_INTENTS.BUG_REPORT
]);

export function classifyJiraComment(value) {
  const text = sanitizeUntrustedText(value, 4000).trim();
  let intent = JIRA_COMMENT_INTENTS.QUESTION;
  if (/\b(thanks|thank you|cheers|great work|looks good|well done)\b/i.test(text) && !/[?]/.test(text)) {
    intent = JIRA_COMMENT_INTENTS.SOCIAL;
  } else if (/\b(deploy|release|go live|push live)\b/i.test(text) && /\b(tomorrow|today|later|next week|schedule|when|hold|wait)\b/i.test(text)) {
    intent = JIRA_COMMENT_INTENTS.DEPLOYMENT_SCHEDULING;
  } else if (/\b(production|sandbox|environment|org)\b/i.test(text) && /\b(affect|impact|target|which|where|production)\b/i.test(text) && /[?]|\bwill\b|\bdoes\b|\bis\b/i.test(text)) {
    intent = JIRA_COMMENT_INTENTS.ENVIRONMENT_QUESTION;
  } else if (/\b(why|explain|reason|how does|how will)\b/i.test(text)) {
    intent = JIRA_COMMENT_INTENTS.EXPLANATION_REQUEST;
  } else if (/\b(don't|do not|must not|avoid|without|keep .+ out|exclude)\b/i.test(text)) {
    intent = JIRA_COMMENT_INTENTS.CONSTRAINT;
  } else if (/\b(error|failed|failing|failure|bug|broken|not working|still happening|still occurs|incorrect)\b/i.test(text)) {
    intent = JIRA_COMMENT_INTENTS.BUG_REPORT;
  } else if (/\b(also|instead|include|add|create|update|change|modify|remove|delete|rename|display|grant|give access|should|need to)\b/i.test(text)) {
    intent = JIRA_COMMENT_INTENTS.CHANGE_REQUEST;
  } else if (/\b(hello|hi|hey|how are you)\b/i.test(text) && !/[?]/.test(text.replace(/how are you/gi, ''))) {
    intent = JIRA_COMMENT_INTENTS.SOCIAL;
  }
  return { intent, requiresPlanRevision: REVISION_INTENTS.has(intent), text };
}

export function fallbackJiraReply(job, classification) {
  const environment = humanEnvironment(job?.orgContext?.environment);
  switch (classification.intent) {
    case JIRA_COMMENT_INTENTS.CHANGE_REQUEST:
      return "Absolutely. I'll include that in the implementation and update the proposal for your review.";
    case JIRA_COMMENT_INTENTS.CONSTRAINT:
      return "Understood. I'll apply that constraint and update the proposal accordingly.";
    case JIRA_COMMENT_INTENTS.BUG_REPORT:
      return "Thanks for flagging that. I'll investigate the current Salesforce behavior and update the proposed fix once I've confirmed the cause.";
    case JIRA_COMMENT_INTENTS.DEPLOYMENT_SCHEDULING:
      return "Of course. I'll keep the validated changes ready, and we can deploy when you approve the release.";
    case JIRA_COMMENT_INTENTS.ENVIRONMENT_QUESTION:
      return environment === 'Production'
        ? 'This work is currently targeted at the approved Production environment, but nothing will be deployed until the separate deployment approval is provided.'
        : `No. The current work is targeted at the approved ${environment} environment. Nothing will be deployed to Production without explicit approval.`;
    case JIRA_COMMENT_INTENTS.EXPLANATION_REQUEST:
      return explanationReply(job);
    case JIRA_COMMENT_INTENTS.SOCIAL:
      return /\b(thanks|thank you)\b/i.test(classification.text)
        ? "You're welcome! Let me know if you'd like any further improvements."
        : "Hi! I'm here and keeping an eye on this Salesforce work. What would you like to review?";
    default:
      return questionReply(job);
  }
}

export function prepareProvidusNexusComment(value) {
  const salesforceConsoleToken = '__SALESFORCE_REVIEW_CONSOLE__';
  let text = sanitizeUntrustedText(value, 12000)
    .split(/\r?\n/)
    .filter((line) => !/^\s*AI agent job\b/i.test(line))
    .join('\n')
    .replace(/Salesforce AI Agent/gi, salesforceConsoleToken)
    .replace(/\bAI agent job\b/gi, PROVIDUS_NEXUS)
    .replace(/\bAI Agent\b/gi, PROVIDUS_NEXUS)
    .replace(/\b(?:bot|chatbot|assistant|workflow engine|job processor)\b/gi, PROVIDUS_NEXUS)
    .replace(new RegExp(salesforceConsoleToken, 'g'), 'Salesforce AI Agent');

  text = text.split(/\r?\n/)
    .filter((line) => !/^\s*(?:job(?: id)?|plan version|validation id|deployment id|metadata scope|source hash|git commit hash|commit hash|internal state|risk level)\s*:/i.test(line))
    .join('\n')
    .replace(/\b0A[a-zA-Z0-9]{13,16}\b/g, '')
    .replace(/\b[a-f0-9]{40,64}\b/gi, '')
    .replace(/force-app[\\/][^\s]+/gi, '')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  text = text.replace(/^Providus Nexus\s*:\s*/i, '').trim();
  if (!text) text = "I'm reviewing this and will share a clear update here shortly.";
  return `${PROVIDUS_NEXUS}: ${text}`;
}

export function isProvidusNexusComment(value) {
  return /^\s*Providus Nexus\s*:/i.test(String(value || ''));
}

export function jiraLifecycleComment(stage, job = {}) {
  switch (stage) {
    case 'ASSIGNED':
      return "Thanks! I've picked up this ticket and I'm reviewing the current Salesforce implementation. I'll keep you updated here as I make progress.";
    case 'INVESTIGATING':
      return "I found a few related areas that I want to review before making changes. I'll update the proposal once I've confirmed the safest approach.";
    case 'PLAN_READY':
      return "I've finished reviewing the current implementation and prepared a proposed solution. Please review it in the Salesforce AI Agent whenever you're ready.";
    case 'REQUIREMENTS_NEEDED':
      return "I've reviewed the request, but I still need a few implementation details before I can prepare a safe proposal. I've listed the missing information in the Salesforce AI Agent.";
    case 'IMPLEMENTING':
      return "Thanks for the approval! I'm applying the requested changes now.";
    case 'VALIDATING':
      return "The implementation is complete. I'm validating everything to make sure the changes are safe before deployment.";
    case 'VALIDATION_PASSED':
      return 'Everything looks good. The changes have been validated successfully and are ready for deployment whenever you are.';
    case 'VALIDATION_FAILED':
      return "I found an issue during validation. Nothing has been deployed, and I've added the details to the Salesforce AI Agent so we can review the correction.";
    case 'DEPLOYMENT_COMPLETED':
      return 'Deployment completed successfully! Please verify the updated behavior in Salesforce, and let me know if you would like any additional improvements.';
    case 'DEPLOYMENT_FAILED':
      return "I ran into an issue during deployment. I've captured the details in the Salesforce AI Agent so we can review and resolve it together.";
    case 'NO_CHANGES_REQUIRED':
      return "I've completed the review and confirmed that no Salesforce deployment is required for this request.";
    default:
      return questionReply(job);
  }
}

function explanationReply(job) {
  const explanation = sanitizeUntrustedText(job?.plan?.proposedImplementation || job?.plan?.expectedOutcome, 600).trim();
  if (explanation) return `Based on my review, ${lowercaseFirst(explanation)} This keeps the change focused on the existing business process.`;
  return "I'm checking that against the current Salesforce implementation so I can explain the reasoning accurately. I'll respond here once I've confirmed it.";
}

function questionReply(job) {
  const outcome = sanitizeUntrustedText(job?.plan?.expectedOutcome, 500).trim();
  if (outcome) return `The current proposal is designed so that ${lowercaseFirst(outcome)} Nothing will be deployed until the required approval is provided.`;
  return "I'm reviewing that against the current Salesforce implementation and will answer here once I've confirmed the behavior.";
}

function humanEnvironment(value) {
  const environment = String(value || 'sandbox').toLowerCase();
  if (environment === 'production') return 'Production';
  if (environment === 'developer') return 'Developer Org';
  if (environment === 'scratch') return 'Scratch Org';
  return 'Sandbox';
}

function lowercaseFirst(value) {
  const text = String(value || '').trim();
  return text ? `${text[0].toLowerCase()}${text.slice(1)}` : text;
}
