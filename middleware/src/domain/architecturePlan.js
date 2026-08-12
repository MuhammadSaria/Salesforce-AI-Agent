import { z } from 'zod';
import { stableHash } from '../utils/hash.js';

export const SUPPORTED_ARCHITECTURE_METADATA_TYPES = Object.freeze([
  'ApexClass',
  'ApexTrigger',
  'AuraDefinitionBundle',
  'CompactLayout',
  'CustomApplication',
  'CustomField',
  'CustomMetadata',
  'CustomObject',
  'CustomPermission',
  'CustomTab',
  'ExternalCredential',
  'FlexiPage',
  'Flow',
  'FlowDefinition',
  'GlobalValueSet',
  'Layout',
  'LightningComponentBundle',
  'NamedCredential',
  'PermissionSet',
  'PermissionSetGroup',
  'Profile',
  'RecordType',
  'RemoteSiteSetting',
  'StandardValueSet',
  'ValidationRule'
]);

export const ARCHITECTURE_OWNER_IDS = Object.freeze([
  'object-field-specialist',
  'flow-specialist',
  'apex-specialist',
  'lwc-specialist',
  'ui-metadata-specialist',
  'security-specialist',
  'integration-specialist',
  'data-specialist',
  'testing-specialist',
  'validation-deployment-specialist',
  'documentation-specialist'
]);

const sourceTerms = [
  /<\?xml/i,
  /<\/?[A-Za-z][^>]*>/,
  /```/,
  /\bpublic\s+class\b/i,
  /\bprivate\s+class\b/i,
  /\bglobal\s+class\b/i,
  /\btrigger\s+\w+\s+on\b/i,
  /\bSystem\.debug\b/i,
  /\b(?:const|let|var)\s+\w+\s*=/,
  /\bfunction\s+\w+\s*\(/,
  /=>\s*[{(]/,
  /\bimport\s+[\w{]/,
  /\bexport\s+(?:default\s+)?(?:class|function|const|let|var)\b/,
  /\b(?:bash|sh|cmd|powershell|pwsh)(?:\.exe)?\s+/i,
  /\bsf(?:\.cmd)?\s+[A-Za-z]/i,
  /\bsfdx\s+[A-Za-z]/i,
  /\bgit\s+(?:add|commit|push|checkout|reset|clean|worktree|rm|mv|switch|merge|rebase|pull)\b/i,
  /\bnpm(?:\.cmd)?\s+(?:run|install|test|exec|start)\b/i,
  /\bpowershell\s+-/i,
  /\bpwd\b/i,
  /\b(?:rm|del|copy|move|mkdir|cat|curl|wget)\s+[-./\\\w]/i,
  /(?:^|[\s'"])(?:force-app|src|classes|triggers|lwc|aura|objects|flows)[/\\][^\s'"]+/i,
  /\b[A-Za-z]:\\[^\s'"]+/,
  /(?:^|[\s'"])\.{0,2}[/\\][^\s'"]+\.(?:cls|trigger|js|html|css|xml|json|yml|yaml|sh|ps1|cmd|bat)\b/i,
  /\b[A-Za-z0-9+/]{24,}={0,2}\b/,
  /%(?:20|2f|5c|3b|26|7c|60)/i,
  /\\u00(?:20|2f|5c|3b|26|7c|60|66)/i
];

const sourceFreeString = (max) => z.string().min(1).max(max).superRefine((value, ctx) => {
  const normalized = value.replace(/\r\n?/g, '\n');
  const decoded = decodeSuspicious(normalized);
  if (/[\r\n]/.test(value) || sourceTerms.some((pattern) => pattern.test(normalized) || pattern.test(decoded))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Architecture plans must not contain source code, XML, JavaScript, Apex, or shell commands.' });
  }
});
const apiName = z.string().min(1).max(255).superRefine((value, ctx) => {
  if (sourceTerms.some((pattern) => pattern.test(value))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Architecture plans must not contain file paths, file operations, generated files, or component source.' });
  }
});
const evidenceId = z.string().min(1).max(200).regex(/^[A-Za-z0-9:._-]+$/, 'Invalid evidence identifier.').superRefine((value, ctx) => {
  if (sourceTerms.some((pattern) => pattern.test(value))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Architecture plans must not contain source code, XML, JavaScript, Apex, or shell commands.' });
  }
});

function decodeSuspicious(value) {
  const variants = [value];
  try { variants.push(decodeURIComponent(value)); } catch {}
  variants.push(value.replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(Number.parseInt(code, 16))));
  for (const token of value.match(/\b[A-Za-z0-9+/]{4,256}={0,2}(?=\b|$)/g) || []) {
    if (token.length % 4 !== 0) continue;
    try {
      const decoded = Buffer.from(token, 'base64').toString('utf8');
      if (/^[\x09\x0a\x0d\x20-\x7e]{2,256}$/.test(decoded)) variants.push(decoded);
    } catch {}
  }
  return variants.join('\n');
}

const API_NAME_PATTERNS = {
  ApexClass: /^[A-Za-z][A-Za-z0-9_]*$/,
  ApexTrigger: /^[A-Za-z][A-Za-z0-9_]*$/,
  AuraDefinitionBundle: /^[A-Za-z][A-Za-z0-9_]*$/,
  CompactLayout: /^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/,
  CustomApplication: /^[A-Za-z][A-Za-z0-9_]*$/,
  CustomField: /^[A-Za-z][A-Za-z0-9_]*(?:__c)?\.[A-Za-z][A-Za-z0-9_]*(?:__(?:c|pc|r)|Id|_?[A-Za-z0-9]*)?$/,
  CustomMetadata: /^[A-Za-z][A-Za-z0-9_]*__mdt(?:\.[A-Za-z][A-Za-z0-9_]*)?$/,
  CustomObject: /^[A-Za-z][A-Za-z0-9_]*(?:__c)?$/,
  CustomPermission: /^[A-Za-z][A-Za-z0-9_]*$/,
  CustomTab: /^[A-Za-z][A-Za-z0-9_]*(?:__c)?$/,
  ExternalCredential: /^[A-Za-z][A-Za-z0-9_]*$/,
  FlexiPage: /^[A-Za-z][A-Za-z0-9_]*$/,
  Flow: /^[A-Za-z][A-Za-z0-9_]*$/,
  FlowDefinition: /^[A-Za-z][A-Za-z0-9_]*$/,
  GlobalValueSet: /^[A-Za-z][A-Za-z0-9_]*$/,
  Layout: /^[A-Za-z][A-Za-z0-9_]*(?:__c)?-[A-Za-z0-9_ ]+$/,
  LightningComponentBundle: /^[a-z][A-Za-z0-9_]*$/,
  NamedCredential: /^[A-Za-z][A-Za-z0-9_]*$/,
  PermissionSet: /^[A-Za-z][A-Za-z0-9_]*$/,
  PermissionSetGroup: /^[A-Za-z][A-Za-z0-9_]*$/,
  Profile: /^[A-Za-z0-9_ .-]+$/,
  RecordType: /^[A-Za-z][A-Za-z0-9_]*(?:__c)?\.[A-Za-z][A-Za-z0-9_]*$/,
  RemoteSiteSetting: /^[A-Za-z][A-Za-z0-9_]*$/,
  StandardValueSet: /^[A-Za-z][A-Za-z0-9_]*$/,
  ValidationRule: /^[A-Za-z][A-Za-z0-9_]*(?:__c)?\.[A-Za-z][A-Za-z0-9_]*$/
};

export const ARCHITECTURE_PLAN_SCHEMA = z.object({
  requirement: sourceFreeString(8000),
  acceptanceCriteria: z.array(sourceFreeString(1000)).min(1).max(25),
  assumptions: z.array(sourceFreeString(1000)).max(20),
  evidenceIds: z.array(evidenceId).min(1).max(100),
  components: z.array(z.object({
    operation: z.enum(['create', 'modify', 'delete']),
    metadataType: z.enum(SUPPORTED_ARCHITECTURE_METADATA_TYPES),
    apiName,
    owner: z.enum(ARCHITECTURE_OWNER_IDS),
    reason: sourceFreeString(1000)
  }).strict().superRefine((component, ctx) => {
    const pattern = API_NAME_PATTERNS[component.metadataType];
    if (!pattern?.test(component.apiName)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['apiName'], message: `Invalid ${component.metadataType} API name.` });
    }
  })).min(1).max(50),
  expectedBehavior: z.array(sourceFreeString(1000)).min(1).max(30),
  testingStrategy: z.array(sourceFreeString(1000)).min(1).max(30),
  risks: z.array(sourceFreeString(1000)).max(30),
  rollbackStrategy: sourceFreeString(2000)
}).strict().superRefine((plan, ctx) => {
  const serialized = JSON.stringify(plan);
  if (/\b(fileOperations|generatedFiles|completeFiles|filesToCreate|filesToModify|writeFile|readFile|path|content)\b/i.test(serialized)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Architecture plans must not contain source-generation fields.' });
  }
});

export function parseArchitecturePlan(plan) {
  return ARCHITECTURE_PLAN_SCHEMA.parse(plan);
}

export function architecturePlanCore(plan) {
  return parseArchitecturePlan({
    requirement: plan?.requirement,
    acceptanceCriteria: plan?.acceptanceCriteria,
    assumptions: plan?.assumptions,
    evidenceIds: plan?.evidenceIds,
    components: plan?.components,
    expectedBehavior: plan?.expectedBehavior,
    testingStrategy: plan?.testingStrategy,
    risks: plan?.risks,
    rollbackStrategy: plan?.rollbackStrategy
  });
}

export function architecturePlanHashes(plan) {
  const core = architecturePlanCore(plan);
  const binding = trustedBindingCore(plan?.trustedBinding);
  return {
    planHash: stableHash({ core, binding }),
    scopeHash: stableHash(core.components.map(({ operation, metadataType, apiName, owner }) => ({ operation, metadataType, apiName, owner })))
  };
}

export function trustedBindingCore(binding = {}) {
  return {
    inspectionHash: String(binding.inspectionHash || ''),
    sourceOrgId: String(binding.sourceOrgId || '')
  };
}
