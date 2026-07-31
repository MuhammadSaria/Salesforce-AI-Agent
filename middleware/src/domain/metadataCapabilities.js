const GENERAL_CAPABILITIES = Object.freeze([
  capability('Report', 'reports', ['.report-meta.xml'], true),
  capability('Dashboard', 'dashboards', ['.dashboard-meta.xml'], true),
  capability('ReportType', 'reportTypes', ['.reportType-meta.xml']),
  capability('EmailTemplate', 'email', ['.email', '.email-meta.xml'], true),
  capability('ApexPage', 'pages', ['.page', '.page-meta.xml']),
  capability('ApexComponent', 'components', ['.component', '.component-meta.xml']),
  capability('ExperienceBundle', 'experiences', ['.json', '.site-meta.xml'], true),
  capability('Network', 'networks', ['.network-meta.xml']),
  capability('CustomSite', 'sites', ['.site-meta.xml']),
  capability('AssignmentRules', 'assignmentRules', ['.assignmentRules-meta.xml']),
  capability('AutoResponseRules', 'autoResponseRules', ['.autoResponseRules-meta.xml']),
  capability('EscalationRules', 'escalationRules', ['.escalationRules-meta.xml']),
  capability('MatchingRules', 'matchingRules', ['.matchingRule-meta.xml']),
  capability('DuplicateRule', 'duplicateRules', ['.duplicateRule-meta.xml']),
  capability('Translations', 'translations', ['.translation-meta.xml']),
  capability('CustomObjectTranslation', 'objectTranslations', ['.objectTranslation-meta.xml'], true),
  capability('CustomLabels', 'labels', ['.labels-meta.xml']),
  capability('Workflow', 'workflows', ['.workflow-meta.xml']),
  capability('SharingRules', 'sharingRules', ['.sharingRules-meta.xml']),
  capability('ApprovalProcess', 'approvalProcesses', ['.approvalProcess-meta.xml']),
  capability('Queue', 'queues', ['.queue-meta.xml']),
  capability('Group', 'groups', ['.group-meta.xml']),
  capability('Role', 'roles', ['.role-meta.xml']),
  capability('QuickAction', 'quickActions', ['.quickAction-meta.xml']),
  capability('HomePageLayout', 'homePageLayouts', ['.homePageLayout-meta.xml']),
  capability('CustomNotificationType', 'notificationtypes', ['.notiftype-meta.xml']),
  capability('Settings', 'settings', ['.settings-meta.xml'])
]);

const SPECIALIST_ROOTS = new Set([
  'objects', 'globalValueSets', 'standardValueSets', 'flows', 'flowDefinitions', 'classes', 'triggers', 'lwc', 'aura',
  'layouts', 'flexipages', 'compactLayouts', 'tabs', 'applications', 'permissionsets', 'permissionsetgroups',
  'mutingpermissionsets', 'profiles', 'customPermissions', 'namedCredentials', 'externalCredentials', 'remoteSiteSettings',
  'authproviders', 'connectedApps', 'customMetadata', 'platformEventSubscriberConfigs'
]);
const SAFE_EXTENSIONS = new Set(['.xml', '.cls', '.trigger', '.js', '.html', '.css', '.json', '.cmp', '.app', '.evt', '.intf', '.design', '.auradoc', '.svg', '.page', '.component', '.email']);
const GENERAL_BY_ROOT = new Map(GENERAL_CAPABILITIES.map((item) => [item.root, item]));

export const GENERAL_METADATA_TYPES = Object.freeze([...new Set(GENERAL_CAPABILITIES.map((item) => item.metadataType))]);
export const GENERAL_METADATA_PATH_ROOTS = Object.freeze([...new Set(GENERAL_CAPABILITIES.map((item) => item.root))]);

export function metadataComponentFromPath(path) {
  const parsed = parseSourcePath(path);
  if (!parsed) return null;
  const capabilityDefinition = GENERAL_BY_ROOT.get(parsed.root);
  if (!capabilityDefinition) return null;
  const suffix = capabilityDefinition.suffixes.find((candidate) => parsed.relativePath.endsWith(candidate));
  if (!suffix) return null;
  const apiName = parsed.relativePath.slice(0, -suffix.length).replace(/\\/g, '/');
  if (!apiName || (!capabilityDefinition.nested && apiName.includes('/'))) return null;
  return { type: capabilityDefinition.metadataType, apiName };
}

export function isSafeSalesforceSourcePath(path) {
  const parsed = parseSourcePath(path);
  if (!parsed) return false;
  if (!SPECIALIST_ROOTS.has(parsed.root) && !GENERAL_BY_ROOT.has(parsed.root)) return false;
  if (/(?:^|\/)(?:\.env(?:\.|$)|id_rsa|credentials?|secrets?)(?:\/|\.|$)/i.test(parsed.normalized)) return false;
  const extension = parsed.normalized.slice(parsed.normalized.lastIndexOf('.')).toLowerCase();
  if (!SAFE_EXTENSIONS.has(extension)) return false;
  const general = GENERAL_BY_ROOT.get(parsed.root);
  return !general || Boolean(metadataComponentFromPath(parsed.normalized));
}

function parseSourcePath(path) {
  const normalized = String(path || '').replace(/\\/g, '/');
  if (!normalized || normalized.includes('\u0000') || normalized.split('/').includes('..')) return null;
  const match = normalized.match(/^force-app\/main\/default\/([^/]+)\/(.+)$/);
  if (!match || !match[2] || match[2].startsWith('/')) return null;
  return { normalized, root: match[1], relativePath: match[2] };
}

function capability(metadataType, root, suffixes, nested = false) {
  return Object.freeze({ metadataType, root, suffixes: Object.freeze(suffixes), nested });
}
