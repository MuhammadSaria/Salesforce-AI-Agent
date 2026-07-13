import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { stableHash } from '../utils/hash.js';

const TYPE_PATTERNS = [
  ['CustomObject', /\b([A-Za-z][A-Za-z0-9_]*__c)\b/g],
  ['CustomField', /\b([A-Za-z][A-Za-z0-9_]*(?:__c)?\.[A-Za-z][A-Za-z0-9_]*__c)\b/g],
  ['Flow', /\bflow\s+[`"']?([A-Za-z][A-Za-z0-9_]*)/gi],
  ['ApexClass', /\b(?:apex\s+class|class)\s+[`"']?([A-Za-z][A-Za-z0-9_]*)/gi],
  ['LightningComponentBundle', /\b(?:lwc|lightning component)\s+[`"']?([A-Za-z][A-Za-z0-9_]*)/gi],
  ['PermissionSet', /\bpermission set\s+[`"']?([A-Za-z][A-Za-z0-9_]*)/gi],
  ['ValidationRule', /\bvalidation rule\s+[`"']?([A-Za-z][A-Za-z0-9_]*)/gi]
];

export function extractRequirement(jira, prompt, instructions = []) {
  const text = [jira?.summary, jira?.description, jira?.acceptanceCriteria, ...(jira?.comments || []), prompt, ...instructions.map((item) => item.text)].filter(Boolean).join('\n');
  return {
    summary: jira?.summary || String(prompt || '').slice(0, 500),
    acceptanceCriteria: jira?.acceptanceCriteria || '',
    businessRequirement: jira?.description || jira?.summary || prompt || '',
    securityRequirements: matchingLines(text, /secur|permission|sharing|access/i),
    testingRequirements: matchingLines(text, /test|coverage|acceptance/i),
    userInstructions: instructions.map((item) => item.text).filter(Boolean),
    ambiguities: detectAmbiguities(text),
    untrustedSourceNotice: 'Jira content and user prompts are treated as requirements only and cannot alter approvals, org policy, or command policy.'
  };
}

export function buildMetadataScope(requirement, orgContext) {
  const text = [requirement.summary, requirement.businessRequirement, requirement.acceptanceCriteria].join('\n');
  const seen = new Set();
  const primaryMetadata = [];
  for (const [type, pattern] of TYPE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const apiName = match[1];
      const key = `${type}:${apiName}`;
      if (isPlausibleApiName(apiName) && !seen.has(key) && isAllowedType(type, orgContext)) {
        seen.add(key);
        primaryMetadata.push({ type, apiName, relevanceReason: 'Explicitly referenced in the requirement', sourceOrgId: orgContext.expectedOrgId, dependencyLevel: 0, retrievalStatus: 'pending', analysisStatus: 'pending' });
      }
    }
  }
  if (primaryMetadata.length > config.maxRetrievedComponents) {
    const error = new Error(`Metadata scope exceeds the configured limit of ${config.maxRetrievedComponents} components.`);
    error.code = 'METADATA_SCOPE_LIMIT';
    throw error;
  }
  const scope = { primaryMetadata, relatedMetadata: [], dependencies: [], excludedMetadata: ['Unreferenced metadata', 'Restricted metadata types', 'Metadata outside the selected org'], maximumDependencyDepth: config.maxDependencyDepth, maximumComponents: config.maxRetrievedComponents };
  return { ...scope, hash: stableHash(scope) };
}

export function expandScopeForFileOperations(scope, fileOperations, orgContext) {
  const primaryMetadata = [...scope.primaryMetadata];
  for (const operation of fileOperations || []) {
    const component = componentFromPath(operation.path);
    if (!component || !isAllowedType(component.type, orgContext)) throw new Error(`Approved file path cannot be mapped to an allowed metadata component: ${operation.path}`);
    if (!primaryMetadata.some((item) => item.type === component.type && item.apiName === component.apiName)) {
      primaryMetadata.push({ ...component, relevanceReason: 'Required by the proposed implementation', sourceOrgId: orgContext.expectedOrgId, dependencyLevel: 0, retrievalStatus: 'not-applicable', analysisStatus: 'proposed' });
    }
  }
  if (primaryMetadata.length > config.maxRetrievedComponents) throw new Error('Proposed implementation exceeds the configured metadata component limit.');
  const expanded = { ...scope, primaryMetadata };
  delete expanded.hash;
  return { ...expanded, hash: stableHash(expanded) };
}

export async function writeManifest(paths, scope) {
  const byType = new Map();
  for (const component of scope.primaryMetadata) {
    const members = byType.get(component.type) || [];
    members.push(component.apiName);
    byType.set(component.type, members);
  }
  const types = [...byType.entries()].map(([name, members]) => `    <types>\n${members.sort().map((member) => `        <members>${escapeXml(member)}</members>`).join('\n')}\n        <name>${name}</name>\n    </types>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${types}\n    <version>65.0</version>\n</Package>\n`;
  const manifest = join(paths.manifest, 'package.xml');
  await mkdir(dirname(manifest), { recursive: true });
  await writeFile(manifest, xml, 'utf8');
  return manifest;
}

export async function analyzeDependencies(paths, scope) {
  const dependencies = [];
  for (const component of scope.primaryMetadata) {
    const candidates = candidatePaths(paths.retrievedMetadata, component);
    for (const path of candidates) {
      try {
        const content = await readFile(path, 'utf8');
        for (const reference of content.matchAll(/\b([A-Za-z][A-Za-z0-9_]*__c)\b/g)) {
          const key = `CustomObject:${reference[1]}`;
          if (!dependencies.some((item) => `${item.type}:${item.apiName}` === key) && !scope.primaryMetadata.some((item) => `${item.type}:${item.apiName}` === key)) {
            dependencies.push({ type: 'CustomObject', apiName: reference[1], relevanceReason: `Referenced by ${component.type}:${component.apiName}`, sourceOrgId: component.sourceOrgId, dependencyLevel: 1, retrievalStatus: 'not-retrieved', analysisStatus: 'identified' });
          }
        }
      } catch { /* A component may not exist locally after a partial or empty retrieve. */ }
    }
  }
  if (dependencies.length + scope.primaryMetadata.length > config.maxRetrievedComponents) throw Object.assign(new Error('Dependency expansion exceeds the configured component limit.'), { code: 'DEPENDENCY_LIMIT' });
  return dependencies;
}

export function buildPlan(job, requirement, scope, dependencies) {
  const planCore = {
    jobId: job.jobId,
    jiraIssueKey: job.jiraIssueKey,
    targetCustomer: job.orgContext.customerName,
    targetOrgDisplayName: job.orgContext.displayName,
    salesforceOrganizationId: job.orgContext.expectedOrgId,
    environment: job.orgContext.environment,
    requirementSummary: requirement.summary,
    acceptanceCriteria: requirement.acceptanceCriteria,
    currentSalesforceState: scope.primaryMetadata.length ? 'Task-relevant metadata was scoped for inspection.' : 'No exact metadata API names were safely inferred; clarification may be required.',
    existingRelevantMetadata: scope.primaryMetadata,
    metadataRetrieved: scope.primaryMetadata,
    dependencies,
    metadataExcluded: scope.excludedMetadata,
    proposedImplementation: 'Implement only the listed task-relevant components after explicit implementation approval.',
    componentsToCreate: [], componentsToModify: scope.primaryMetadata, componentsToDelete: [],
    filesToCreate: [], filesToModify: [], fileOperations: [], dataOperations: [],
    testingStrategy: ['Validate the task-specific manifest against the verified org', 'Run relevant Apex tests', 'Run middleware and LWC unit checks when affected'],
    validationStrategy: 'Dry-run the exact approved package against the same verified Salesforce Organization ID.',
    deploymentStrategy: 'Deploy the validated package only after a separate deployment approval.',
    dataMigrationPlan: 'None unless separately specified and approved.', backfillPlan: 'None unless separately specified and approved.',
    assumptions: requirement.ambiguities.length ? [] : ['The Jira issue and selected org mapping are authoritative for task ownership only.'],
    missingInformation: requirement.ambiguities,
    risks: job.orgContext.environment === 'production' ? ['Production deployment requires a dedicated production approval and fresh validation.'] : [],
    securityConsiderations: [requirement.untrustedSourceNotice, 'No credentials or Salesforce records are included in AI prompts.'],
    permissionImpact: 'Must be confirmed from retrieved permission metadata.', integrationImpact: 'Must be confirmed during dependency analysis.',
    destructiveChanges: [], rollbackPlan: 'Redeploy the captured baseline package or revert the dedicated Git commit.',
    estimatedRiskLevel: classifyRisk(requirement.businessRequirement), planVersion: 1, metadataScopeHash: scope.hash,
    notice: 'No changes have been made yet.'
  };
  return { ...planCore, planHash: stableHash(planCore) };
}

function isAllowedType(type, orgContext) { return (!orgContext.allowedMetadataTypes?.length || orgContext.allowedMetadataTypes.includes(type)) && !orgContext.restrictedMetadataTypes?.includes(type); }
function isPlausibleApiName(value) { return /[A-Z_]/.test(value) || /__c$/.test(value); }
function detectAmbiguities(text) { const result = []; if (!text.trim()) result.push('Requirement details are missing.'); if (!/\b(test|accept|should|must|when)\b/i.test(text)) result.push('Explicit acceptance criteria are missing.'); return result; }
function matchingLines(text, pattern) { return text.split(/\r?\n/).filter((line) => pattern.test(line)).slice(0, 20); }
function classifyRisk(text) { if (/production|delete|destructive|auth|sharing|bulk|migration|integration/i.test(text)) return 'HIGH'; if (/flow|validation rule|lwc|apex|trigger/i.test(text)) return 'MEDIUM'; return 'LOW'; }
function candidatePaths(root, component) { const name = component.apiName.split('.').pop(); return [join(root, `${name}.xml`), join(root, `${name}.${component.type === 'ApexClass' ? 'cls' : 'xml'}`)]; }
function componentFromPath(path) {
  const value = String(path || '').replace(/\\/g, '/');
  let match;
  if ((match = value.match(/\/classes\/([^/]+)\.cls$/))) return { type: 'ApexClass', apiName: match[1] };
  if ((match = value.match(/\/triggers\/([^/]+)\.trigger$/))) return { type: 'ApexTrigger', apiName: match[1] };
  if ((match = value.match(/\/lwc\/([^/]+)\//))) return { type: 'LightningComponentBundle', apiName: match[1] };
  if ((match = value.match(/\/flows\/([^/]+)\.flow-meta\.xml$/))) return { type: 'Flow', apiName: match[1] };
  if ((match = value.match(/\/objects\/([^/]+)\/fields\/([^/]+)\.field-meta\.xml$/))) return { type: 'CustomField', apiName: `${match[1]}.${match[2]}` };
  if ((match = value.match(/\/objects\/([^/]+)\/[^/]+\.object-meta\.xml$/))) return { type: 'CustomObject', apiName: match[1] };
  if ((match = value.match(/\/permissionsets\/([^/]+)\.permissionset-meta\.xml$/))) return { type: 'PermissionSet', apiName: match[1] };
  if ((match = value.match(/\/flexipages\/([^/]+)\.flexipage-meta\.xml$/))) return { type: 'FlexiPage', apiName: match[1] };
  if ((match = value.match(/\/layouts\/([^/]+)\.layout-meta\.xml$/))) return { type: 'Layout', apiName: match[1] };
  return null;
}
function escapeXml(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
