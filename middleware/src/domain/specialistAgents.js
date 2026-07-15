export const SPECIALIST_AGENT_IDS = Object.freeze({
  OBJECT_FIELD: 'OBJECT_FIELD',
  FLOW: 'FLOW',
  APEX: 'APEX',
  LWC: 'LWC',
  UI_METADATA: 'UI_METADATA',
  SECURITY_PERMISSIONS: 'SECURITY_PERMISSIONS',
  INTEGRATION: 'INTEGRATION',
  DATA: 'DATA',
  TESTING: 'TESTING',
  VALIDATION_DEPLOYMENT: 'VALIDATION_DEPLOYMENT',
  DOCUMENTATION_EXPLANATION: 'DOCUMENTATION_EXPLANATION'
});

export const WORK_ITEM_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  READY: 'READY',
  ANALYZING: 'ANALYZING',
  WAITING_FOR_DEPENDENCY: 'WAITING_FOR_DEPENDENCY',
  PROPOSAL_COMPLETE: 'PROPOSAL_COMPLETE',
  APPROVED: 'APPROVED',
  IMPLEMENTING: 'IMPLEMENTING',
  IMPLEMENTATION_COMPLETE: 'IMPLEMENTATION_COMPLETE',
  VALIDATING: 'VALIDATING',
  CHANGES_REQUIRED: 'CHANGES_REQUIRED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED'
});

export const SPECIALIST_MESSAGE_TYPES = Object.freeze({
  DEPENDENCY_FOUND: 'DEPENDENCY_FOUND',
  COMPONENT_REQUIRED: 'COMPONENT_REQUIRED',
  ANALYSIS_COMPLETE: 'ANALYSIS_COMPLETE',
  PROPOSAL_READY: 'PROPOSAL_READY',
  CONFLICT_FOUND: 'CONFLICT_FOUND',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  CORRECTION_REQUIRED: 'CORRECTION_REQUIRED',
  WORK_ITEM_COMPLETE: 'WORK_ITEM_COMPLETE'
});

const WORK_ITEM_TRANSITIONS = new Map([
  [WORK_ITEM_STATUSES.PENDING, [WORK_ITEM_STATUSES.READY, WORK_ITEM_STATUSES.ANALYZING, WORK_ITEM_STATUSES.WAITING_FOR_DEPENDENCY, WORK_ITEM_STATUSES.CANCELLED]],
  [WORK_ITEM_STATUSES.READY, [WORK_ITEM_STATUSES.ANALYZING, WORK_ITEM_STATUSES.APPROVED, WORK_ITEM_STATUSES.CANCELLED]],
  [WORK_ITEM_STATUSES.ANALYZING, [WORK_ITEM_STATUSES.PROPOSAL_COMPLETE, WORK_ITEM_STATUSES.WAITING_FOR_DEPENDENCY, WORK_ITEM_STATUSES.FAILED, WORK_ITEM_STATUSES.CANCELLED]],
  [WORK_ITEM_STATUSES.WAITING_FOR_DEPENDENCY, [WORK_ITEM_STATUSES.PROPOSAL_COMPLETE, WORK_ITEM_STATUSES.APPROVED, WORK_ITEM_STATUSES.CANCELLED]],
  [WORK_ITEM_STATUSES.PROPOSAL_COMPLETE, [WORK_ITEM_STATUSES.APPROVED, WORK_ITEM_STATUSES.CHANGES_REQUIRED, WORK_ITEM_STATUSES.CANCELLED]],
  [WORK_ITEM_STATUSES.APPROVED, [WORK_ITEM_STATUSES.IMPLEMENTING, WORK_ITEM_STATUSES.VALIDATING, WORK_ITEM_STATUSES.CHANGES_REQUIRED, WORK_ITEM_STATUSES.COMPLETED, WORK_ITEM_STATUSES.CANCELLED]],
  [WORK_ITEM_STATUSES.IMPLEMENTING, [WORK_ITEM_STATUSES.IMPLEMENTATION_COMPLETE, WORK_ITEM_STATUSES.CHANGES_REQUIRED, WORK_ITEM_STATUSES.FAILED, WORK_ITEM_STATUSES.CANCELLED]],
  [WORK_ITEM_STATUSES.IMPLEMENTATION_COMPLETE, [WORK_ITEM_STATUSES.VALIDATING, WORK_ITEM_STATUSES.COMPLETED, WORK_ITEM_STATUSES.CHANGES_REQUIRED]],
  [WORK_ITEM_STATUSES.VALIDATING, [WORK_ITEM_STATUSES.IMPLEMENTATION_COMPLETE, WORK_ITEM_STATUSES.COMPLETED, WORK_ITEM_STATUSES.CHANGES_REQUIRED, WORK_ITEM_STATUSES.FAILED]],
  [WORK_ITEM_STATUSES.CHANGES_REQUIRED, [WORK_ITEM_STATUSES.ANALYZING, WORK_ITEM_STATUSES.APPROVED, WORK_ITEM_STATUSES.VALIDATING, WORK_ITEM_STATUSES.CANCELLED]],
  [WORK_ITEM_STATUSES.FAILED, [WORK_ITEM_STATUSES.ANALYZING, WORK_ITEM_STATUSES.CANCELLED]],
  [WORK_ITEM_STATUSES.COMPLETED, []],
  [WORK_ITEM_STATUSES.CANCELLED, []]
]);

const AGENTS = [
  {
    id: SPECIALIST_AGENT_IDS.OBJECT_FIELD,
    name: 'Object and Field Agent',
    section: 'Object and field changes',
    role: 'Owns Salesforce object, field, relationship, value-set, formula, and object-level metadata changes.',
    metadataTypes: ['CustomObject', 'CustomField', 'GlobalValueSet', 'StandardValueSet', 'RecordType', 'ValidationRule', 'CustomSettings'],
    pathRoots: ['objects', 'globalValueSets', 'standardValueSets'],
    inspectionChecklist: ['Existing objects and fields', 'Similar API names', 'Relationships and field dependencies', 'References from automation, code, layouts, and reports']
  },
  {
    id: SPECIALIST_AGENT_IDS.FLOW,
    name: 'Flow Agent',
    section: 'Automation changes',
    role: 'Owns Flow metadata, including trigger behavior, subflows, fault paths, ordering, and bulk-safe automation design.',
    metadataTypes: ['Flow', 'FlowDefinition'],
    pathRoots: ['flows', 'flowDefinitions'],
    inspectionChecklist: ['Existing active and inactive Flow versions', 'Trigger order and entry criteria', 'Subflows and Apex actions', 'Recursion, bulk behavior, and fault handling']
  },
  {
    id: SPECIALIST_AGENT_IDS.APEX,
    name: 'Apex Agent',
    section: 'Apex changes',
    role: 'Owns Apex classes, triggers, handlers, asynchronous Apex, REST services, callout code, and Apex tests.',
    metadataTypes: ['ApexClass', 'ApexTrigger'],
    pathRoots: ['classes', 'triggers'],
    inspectionChecklist: ['Trigger and service frameworks', 'Sharing and security enforcement', 'Governor-limit risks', 'Existing test factories and callout patterns']
  },
  {
    id: SPECIALIST_AGENT_IDS.LWC,
    name: 'LWC Agent',
    section: 'LWC changes',
    role: 'Owns Lightning Web Component source, interaction states, accessibility, responsive behavior, and Jest tests.',
    metadataTypes: ['LightningComponentBundle', 'AuraDefinitionBundle'],
    pathRoots: ['lwc', 'aura'],
    inspectionChecklist: ['Existing component structure', 'Reusable components and Apex contracts', 'SLDS and accessibility patterns', 'Loading, error, and test coverage']
  },
  {
    id: SPECIALIST_AGENT_IDS.UI_METADATA,
    name: 'UI Metadata Agent',
    section: 'UI metadata changes',
    role: 'Owns layouts, Lightning pages, compact layouts, tabs, applications, related lists, and visibility rules.',
    metadataTypes: ['Layout', 'FlexiPage', 'CompactLayout', 'CustomTab', 'CustomApplication'],
    pathRoots: ['layouts', 'flexipages', 'compactLayouts', 'tabs', 'applications'],
    inspectionChecklist: ['Layouts and record type assignments', 'Lightning page and app assignments', 'Form factors and field placement', 'Component visibility rules']
  },
  {
    id: SPECIALIST_AGENT_IDS.SECURITY_PERMISSIONS,
    name: 'Security and Permissions Agent',
    section: 'Permission changes',
    role: 'Owns least-privilege access through permission sets, groups, object and field access, custom permissions, tabs, record types, Apex, and Flow access.',
    metadataTypes: ['PermissionSet', 'PermissionSetGroup', 'MutingPermissionSet', 'Profile', 'CustomPermission'],
    pathRoots: ['permissionsets', 'permissionsetgroups', 'mutingpermissionsets', 'profiles', 'customPermissions'],
    inspectionChecklist: ['Existing permission sets and groups', 'Object and field access', 'Apex and Flow access', 'Least-privilege alternatives and escalation risk']
  },
  {
    id: SPECIALIST_AGENT_IDS.INTEGRATION,
    name: 'Integration Agent',
    section: 'Integration changes',
    role: 'Owns non-secret integration metadata and coordinates callout code and access requirements with Apex and Security agents.',
    metadataTypes: ['NamedCredential', 'ExternalCredential', 'RemoteSiteSetting', 'AuthProvider', 'ConnectedApp', 'CustomMetadata', 'PlatformEventSubscriberConfig'],
    pathRoots: ['namedCredentials', 'externalCredentials', 'remoteSiteSettings', 'authproviders', 'connectedApps', 'customMetadata', 'platformEventSubscriberConfigs'],
    inspectionChecklist: ['Existing credentials without secret values', 'Endpoint and authentication metadata', 'Callout and webhook dependencies', 'Required Apex and permission coordination']
  },
  {
    id: SPECIALIST_AGENT_IDS.DATA,
    name: 'Data Agent',
    section: 'Data changes',
    role: 'Owns read-only data analysis, impact assessment, migration and backfill plans, and separately approved structured record operations.',
    metadataTypes: [],
    pathRoots: [],
    ownsDataOperations: true,
    inspectionChecklist: ['Record volume and data quality', 'Duplicate and relationship impact', 'Backfill or migration sequence', 'Rollback and explicit data-change approval']
  },
  {
    id: SPECIALIST_AGENT_IDS.TESTING,
    name: 'Testing Agent',
    section: 'Testing approach',
    role: 'Independently verifies the combined solution against acceptance criteria, positive, negative, bulk, permission, integration, and regression scenarios.',
    metadataTypes: [],
    pathRoots: [],
    inspectionChecklist: ['Acceptance criteria', 'Unit and metadata tests', 'Positive, negative, and bulk scenarios', 'Regression and manual verification']
  },
  {
    id: SPECIALIST_AGENT_IDS.VALIDATION_DEPLOYMENT,
    name: 'Validation and Deployment Agent',
    section: 'Validation and deployment',
    role: 'Owns the minimal manifest, target-org and hash checks, validation, and deployment after the separate approval. It cannot edit implementation files.',
    metadataTypes: [],
    pathRoots: [],
    inspectionChecklist: ['Exact org identity', 'Approved files and minimal manifest', 'Source, commit, and package hashes', 'Validation expiry and deployment approval']
  },
  {
    id: SPECIALIST_AGENT_IDS.DOCUMENTATION_EXPLANATION,
    name: 'Documentation and Explanation Agent',
    section: 'Human-readable explanation',
    role: 'Consolidates technical specialist results into one plain-language plan, validation result, deployment result, and user verification summary.',
    metadataTypes: [],
    pathRoots: [],
    inspectionChecklist: ['Requested business behavior', 'Existing functionality reused', 'Observable changes and test results', 'Deployment outcome and user verification']
  }
];

export const SPECIALIST_AGENTS = Object.freeze(Object.fromEntries(AGENTS.map((agent) => [agent.id, Object.freeze(agent)])));

const TYPE_OWNERS = new Map(AGENTS.flatMap((agent) => agent.metadataTypes.map((type) => [type, agent.id])));
const PATH_OWNERS = new Map(AGENTS.flatMap((agent) => agent.pathRoots.map((root) => [root, agent.id])));

export function specialistAgent(agentId) {
  const agent = SPECIALIST_AGENTS[agentId];
  if (!agent) throw Object.assign(new Error(`Unknown specialist agent: ${agentId}`), { code: 'UNKNOWN_SPECIALIST_AGENT' });
  return agent;
}

export function assertWorkItemTransition(from, to) {
  if (!Object.values(WORK_ITEM_STATUSES).includes(to)) throw Object.assign(new Error(`Unknown work-item status: ${to}`), { code: 'UNKNOWN_WORK_ITEM_STATUS' });
  if (!(WORK_ITEM_TRANSITIONS.get(from) || []).includes(to)) throw Object.assign(new Error(`Invalid specialist work-item transition: ${from} -> ${to}`), { statusCode: 409, code: 'INVALID_WORK_ITEM_TRANSITION' });
}

export function ownerForMetadataType(type) {
  return TYPE_OWNERS.get(String(type || '')) || '';
}

export function ownerForFile(path) {
  const normalized = String(path || '').replace(/\\/g, '/');
  if (/^force-app\/main\/default\/objects\/[^/]+\/compactLayouts\//.test(normalized)) return SPECIALIST_AGENT_IDS.UI_METADATA;
  const match = normalized.match(/^force-app\/main\/default\/([^/]+)\//);
  return match ? (PATH_OWNERS.get(match[1]) || '') : '';
}

export function assertSpecialistOwnsFile(agentId, path) {
  const owner = ownerForFile(path);
  if (!owner) throw Object.assign(new Error(`No specialist boundary is configured for ${path}.`), { code: 'UNOWNED_SPECIALIST_FILE' });
  if (owner !== agentId) throw Object.assign(new Error(`${specialistAgent(agentId).name} cannot modify ${path}; it belongs to ${specialistAgent(owner).name}.`), { code: 'SPECIALIST_BOUNDARY_VIOLATION' });
  return true;
}

export function selectSpecialistAgents(requirement, metadataScope = {}, plan = {}) {
  const text = [
    requirement?.summary,
    requirement?.businessRequirement,
    requirement?.acceptanceCriteria,
    ...(requirement?.userInstructions || [])
  ].filter(Boolean).join('\n');
  const selected = new Set();

  for (const component of [...(metadataScope.primaryMetadata || []), ...(metadataScope.dependencies || [])]) {
    const owner = ownerForMetadataType(component.type);
    if (owner) selected.add(owner);
  }
  for (const operation of plan.fileOperations || []) {
    const owner = ownerForFile(operation.path);
    if (owner) selected.add(owner);
  }
  if ((plan.dataOperations || []).length || /\b(data|record|backfill|migration|migrate|duplicate|soql|update accounts?|delete (?:a |the )?record)\b/i.test(text)) selected.add(SPECIALIST_AGENT_IDS.DATA);
  if (/\b(object|field|picklist|lookup|master.?detail|formula|roll.?up|relationship|external id|record type)\b/i.test(text)) selected.add(SPECIALIST_AGENT_IDS.OBJECT_FIELD);
  if (/\b(flow|automation|automate|screen flow|record.?triggered|scheduled.?triggered|subflow)\b/i.test(text)) selected.add(SPECIALIST_AGENT_IDS.FLOW);
  if (/\b(apex|trigger|queueable|batch apex|scheduled apex|invocable|rest endpoint|callout service)\b/i.test(text)) selected.add(SPECIALIST_AGENT_IDS.APEX);
  if (/\b(lwc|lightning web component|component javascript|jest)\b/i.test(text)) selected.add(SPECIALIST_AGENT_IDS.LWC);
  if (/\b(layout|lightning page|record page|flexipage|compact layout|related list|dynamic forms?|tab visibility|app page)\b/i.test(text)) selected.add(SPECIALIST_AGENT_IDS.UI_METADATA);
  if (/\b(permission|access|security|field.level|fls|profile|permission set|custom permission|least privilege)\b/i.test(text)) selected.add(SPECIALIST_AGENT_IDS.SECURITY_PERMISSIONS);
  if (/\b(integration|named credential|external credential|remote site|webhook|platform event|external service|connected app|auth provider)\b/i.test(text)) selected.add(SPECIALIST_AGENT_IDS.INTEGRATION);

  if (selected.has(SPECIALIST_AGENT_IDS.OBJECT_FIELD)) {
    selected.add(SPECIALIST_AGENT_IDS.SECURITY_PERMISSIONS);
    selected.add(SPECIALIST_AGENT_IDS.UI_METADATA);
  }
  if (selected.has(SPECIALIST_AGENT_IDS.LWC) && /\b(apex|server|controller|call)\b/i.test(text)) selected.add(SPECIALIST_AGENT_IDS.APEX);
  if (selected.has(SPECIALIST_AGENT_IDS.INTEGRATION)) selected.add(SPECIALIST_AGENT_IDS.SECURITY_PERMISSIONS);

  selected.add(SPECIALIST_AGENT_IDS.TESTING);
  selected.add(SPECIALIST_AGENT_IDS.VALIDATION_DEPLOYMENT);
  selected.add(SPECIALIST_AGENT_IDS.DOCUMENTATION_EXPLANATION);
  return [...selected];
}

export function selectAffectedSpecialistAgents(instruction) {
  const text = String(instruction || '');
  const selected = new Set();
  const changes = '(?:create|add|modify|change|rename|delete|remove|convert|update)';
  const selectsChange = (subject) => new RegExp(`\\b${changes}\\b.{0,60}\\b${subject}\\b|\\b${subject}\\b.{0,60}\\b${changes}\\b`, 'i').test(text);
  if (selectsChange('(?:object|field|picklist|lookup|relationship|formula|roll.?up|record type)')) selected.add(SPECIALIST_AGENT_IDS.OBJECT_FIELD);
  if (/\b(flow|automation|automate|subflow)\b/i.test(text)) selected.add(SPECIALIST_AGENT_IDS.FLOW);
  if (/\b(apex|trigger|queueable|batch|invocable|rest endpoint|server controller)\b/i.test(text)) selected.add(SPECIALIST_AGENT_IDS.APEX);
  if (/\b(lwc|lightning web component|component javascript|jest)\b/i.test(text)) selected.add(SPECIALIST_AGENT_IDS.LWC);
  if (/\b(layout|lightning page|record page|flexipage|compact layout|related list|dynamic forms?|tab|app page)\b/i.test(text)) selected.add(SPECIALIST_AGENT_IDS.UI_METADATA);
  if (/\b(permission|access|security|field.level|fls|profile|permission set|custom permission)\b/i.test(text)) selected.add(SPECIALIST_AGENT_IDS.SECURITY_PERMISSIONS);
  if (/\b(integration|named credential|external credential|remote site|webhook|platform event|external service|connected app|auth provider)\b/i.test(text)) selected.add(SPECIALIST_AGENT_IDS.INTEGRATION);
  if (/\b(data|record|backfill|migration|migrate|duplicate|soql)\b/i.test(text) && /\b(create|update|delete|analy|check|plan|backfill|migrate)\b/i.test(text)) selected.add(SPECIALIST_AGENT_IDS.DATA);
  if (selected.has(SPECIALIST_AGENT_IDS.OBJECT_FIELD)) {
    selected.add(SPECIALIST_AGENT_IDS.SECURITY_PERMISSIONS);
    selected.add(SPECIALIST_AGENT_IDS.UI_METADATA);
  }
  selected.add(SPECIALIST_AGENT_IDS.TESTING);
  selected.add(SPECIALIST_AGENT_IDS.VALIDATION_DEPLOYMENT);
  selected.add(SPECIALIST_AGENT_IDS.DOCUMENTATION_EXPLANATION);
  return [...selected];
}

export function implementationAgentIds(agentIds) {
  const coordinating = new Set([SPECIALIST_AGENT_IDS.TESTING, SPECIALIST_AGENT_IDS.VALIDATION_DEPLOYMENT, SPECIALIST_AGENT_IDS.DOCUMENTATION_EXPLANATION]);
  return agentIds.filter((agentId) => !coordinating.has(agentId));
}
