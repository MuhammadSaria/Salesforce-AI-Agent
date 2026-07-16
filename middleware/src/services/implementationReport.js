import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import PDFDocument from 'pdfkit';
import {
  AlignmentType,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  PageBreak,
  Paragraph,
  TextRun
} from 'docx';
import { config } from '../config.js';
import { isPathInside } from '../utils/paths.js';
import { sanitizeUntrustedText } from '../utils/sanitize.js';

export const IMPLEMENTATION_REPORT_FORMATS = Object.freeze({
  markdown: { extension: 'md', contentType: 'text/markdown; charset=utf-8', label: 'Markdown' },
  docx: { extension: 'docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word' },
  pdf: { extension: 'pdf', contentType: 'application/pdf', label: 'PDF' }
});

const COMPONENT_CATEGORIES = [
  'Objects',
  'Fields',
  'Flows',
  'Layouts and Lightning Pages',
  'Permission Sets and Security',
  'LWCs',
  'Apex',
  'Reports',
  'Dashboards',
  'Integrations',
  'Data',
  'Other'
];

export async function generateImplementationReport(job, deployment, paths, deploymentVersion) {
  if (!deployment?.deployedAt) throw reportError('A successful deployment is required before generating an implementation report.', 409);
  if (!Number.isInteger(deploymentVersion) || deploymentVersion < 1) throw reportError('Deployment version must be a positive integer.', 422);

  const reportId = `implementation-report-v${deploymentVersion}`;
  const fingerprint = deploymentFingerprint(job, deployment);
  const reportRoot = join(paths.deployment, 'reports');
  const targetDirectory = join(reportRoot, `v${deploymentVersion}`);
  const existing = await readExistingManifest(targetDirectory);
  if (existing) {
    if (existing.deploymentFingerprint !== fingerprint) throw reportError('An immutable report already exists for this deployment version.', 409);
    return existing;
  }

  const generatedAt = new Date().toISOString();
  const model = buildImplementationReportModel(job, deployment, { deploymentVersion, generatedAt });
  const logo = await loadConfiguredLogo();
  const markdown = Buffer.from(renderImplementationMarkdown(model), 'utf8');
  const [docx, pdf] = await Promise.all([renderImplementationDocx(model, logo), renderImplementationPdf(model, logo)]);
  const buffers = { markdown, docx, pdf };
  for (const [format, buffer] of Object.entries(buffers)) {
    if (buffer.length > config.maxImplementationReportBytes) {
      throw reportError(`${IMPLEMENTATION_REPORT_FORMATS[format].label} report exceeds the configured download size limit.`, 413);
    }
  }

  const safeIssueKey = cleanFilePart(job.jiraIssueKey || 'Salesforce');
  const baseFileName = `Implementation-Report-${safeIssueKey}-V${deploymentVersion}`;
  const formats = {};
  for (const [format, definition] of Object.entries(IMPLEMENTATION_REPORT_FORMATS)) {
    const fileName = `${baseFileName}.${definition.extension}`;
    formats[format] = {
      format,
      fileName,
      contentType: definition.contentType,
      relativePath: relative(paths.jobRoot, join(targetDirectory, fileName)).replace(/\\/g, '/'),
      sizeBytes: buffers[format].length,
      sha256: hashBuffer(buffers[format])
    };
  }

  const descriptor = {
    reportId,
    status: 'READY',
    deploymentVersion,
    planVersion: Number(job.plan?.planVersion || job.iteration || 1),
    deploymentFingerprint: fingerprint,
    title: model.cover.reportTitle,
    jiraIssueKey: model.cover.jiraIssueKey,
    customerName: model.cover.customerName,
    orgDisplayName: model.cover.salesforceOrg,
    salesforceOrganizationId: job.orgContext?.expectedOrgId || deployment.targetOrgId || '',
    environment: model.cover.environment,
    generatedAt,
    generatedBy: 'Providus Nexus',
    formats
  };

  const stagingDirectory = join(reportRoot, `.tmp-v${deploymentVersion}-${process.pid}-${Date.now()}`);
  await mkdir(stagingDirectory, { recursive: true });
  try {
    for (const [format, definition] of Object.entries(IMPLEMENTATION_REPORT_FORMATS)) {
      await writeFile(join(stagingDirectory, `${baseFileName}.${definition.extension}`), buffers[format], { mode: 0o600 });
    }
    await writeFile(join(stagingDirectory, 'report.json'), JSON.stringify(model, null, 2), { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(stagingDirectory, 'manifest.json'), JSON.stringify(descriptor, null, 2), { encoding: 'utf8', mode: 0o600 });
    await mkdir(reportRoot, { recursive: true });
    await rename(stagingDirectory, targetDirectory);
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
    const recovered = await readExistingManifest(targetDirectory);
    if (recovered?.deploymentFingerprint === fingerprint) return recovered;
    throw error;
  }
  return descriptor;
}

export function buildImplementationReportModel(job, deployment, options = {}) {
  const deploymentVersion = Number(options.deploymentVersion || 1);
  const generatedAt = options.generatedAt || new Date().toISOString();
  const summary = cleanText(job.jira?.summary || job.requirement?.summary || job.plan?.requirementSummary || 'Salesforce Implementation');
  const customerName = cleanText(job.orgContext?.customerName || job.plan?.targetCustomer || 'Customer');
  const orgDisplayName = cleanText(job.orgContext?.displayName || job.plan?.targetOrgDisplayName || 'Salesforce Org');
  const environment = friendlyEnvironment(job.orgContext?.environment || job.plan?.environment);
  const plan = job.plan || {};
  const componentCategories = categorizeComponents(deployment?.components || [], plan.fileOperations || [], plan.dataOperations || []);
  const implementationDetails = componentDetails(componentCategories, deployment?.summary);
  const existingFunctionalityReused = reusedFunctionality(plan);
  const businessRequirement = professionalRequirement(summary, plan.businessImpact, job.instructions || []);
  const solutionOverview = professionalSolution(plan, existingFunctionalityReused);
  const validationSummary = job.validation?.status === 'PASSED'
    ? 'The implementation was successfully validated against the approved Salesforce environment before deployment. Required checks completed successfully, and no blocking deployment errors were detected.'
    : 'The available deployment record indicates completion, but a detailed validation result was not available in the report source.';
  const deploymentSummary = `The approved implementation was successfully deployed to ${orgDisplayName}, classified as ${environment}.`;
  const businessImpact = sentence(cleanText(plan.businessImpact || `Users can now use the approved ${summary.toLowerCase()} capability in Salesforce.`));
  const verificationSteps = userVerificationSteps(summary, plan.acceptanceCriteria || job.requirement?.acceptanceCriteria);
  const futureRecommendations = futureRecommendationsFor(componentCategories);
  const filesChanged = friendlyFilesChanged(plan.fileOperations || [], deployment?.components || []);

  return {
    cover: {
      brand: 'Providus Nexus',
      reportTitle: `${summary} - Implementation Report`,
      jiraIssueKey: cleanText(job.jiraIssueKey || 'Not linked'),
      jiraIssueSummary: summary,
      customerName,
      salesforceOrg: orgDisplayName,
      environment,
      generatedDate: formatDate(generatedAt),
      generatedBy: 'Providus Nexus',
      deploymentVersion
    },
    executiveSummary: `The requested enhancement has been successfully implemented and deployed. ${sentence(cleanText(plan.expectedOutcome || deployment?.summary || summary))} The delivery was completed within the approved Salesforce environment and preserves unrelated business processes.`,
    businessRequirement,
    solutionOverview,
    components: componentCategories,
    implementationDetails,
    existingFunctionalityReused,
    validationSummary,
    deploymentSummary,
    businessImpact,
    userVerificationSteps: verificationSteps,
    futureRecommendations,
    appendix: {
      timeline: deploymentTimeline(job, deployment, generatedAt),
      filesChanged
    }
  };
}

export function renderImplementationMarkdown(model) {
  const lines = [
    '# ' + markdownText(model.cover.reportTitle),
    '',
    '**Providus Nexus**',
    '',
    `- **Jira Issue:** ${markdownText(model.cover.jiraIssueKey)} - ${markdownText(model.cover.jiraIssueSummary)}`,
    `- **Customer:** ${markdownText(model.cover.customerName)}`,
    `- **Salesforce Org:** ${markdownText(model.cover.salesforceOrg)}`,
    `- **Environment:** ${markdownText(model.cover.environment)}`,
    `- **Deployment Version:** ${model.cover.deploymentVersion}`,
    `- **Generated Date:** ${markdownText(model.cover.generatedDate)}`,
    '- **Generated By:** Providus Nexus',
    '',
    '## 1. Executive Summary', '', markdownText(model.executiveSummary), '',
    '## 2. Business Requirement', '', markdownText(model.businessRequirement), '',
    '## 3. Solution Overview', '', markdownText(model.solutionOverview), '',
    '## 4. Salesforce Components Modified', ''
  ];
  for (const category of model.components) {
    lines.push(`### ${category.category}`, '');
    for (const item of category.items) lines.push(`- ${markdownText(item)}`);
    lines.push('');
  }
  lines.push('## 5. Implementation Details', '');
  for (const detail of model.implementationDetails) lines.push(markdownText(detail), '');
  lines.push(
    '## 6. Existing Functionality Reused', '', markdownText(model.existingFunctionalityReused), '',
    '## 7. Validation Summary', '', markdownText(model.validationSummary), '',
    '## 8. Deployment Summary', '', markdownText(model.deploymentSummary), '',
    '## 9. Business Impact', '', markdownText(model.businessImpact), '',
    '## 10. User Verification Steps', ''
  );
  model.userVerificationSteps.forEach((step, index) => lines.push(`${index + 1}. ${markdownText(step)}`));
  lines.push('', '## 11. Future Recommendations', '');
  for (const item of model.futureRecommendations) lines.push(`- ${markdownText(item)}`);
  lines.push('', '## 12. Appendix', '', '### Deployment Timeline', '');
  for (const item of model.appendix.timeline) lines.push(`- **${markdownText(item.stage)}:** ${markdownText(item.date)}`);
  lines.push('', '### Files Changed', '', '**Created**', '');
  for (const item of model.appendix.filesChanged.created) lines.push(`- ${markdownText(item)}`);
  lines.push('', '**Modified**', '');
  for (const item of model.appendix.filesChanged.modified) lines.push(`- ${markdownText(item)}`);
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

export async function renderImplementationDocx(model, logo = null) {
  const children = [];
  if (logo) {
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ data: logo.buffer, type: logo.type, transformation: { width: 180, height: 72 } })] }));
  }
  children.push(
    new Paragraph({ text: 'Providus Nexus', heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
    new Paragraph({ text: model.cover.reportTitle, heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER }),
    ...coverParagraphs(model.cover),
    new Paragraph({ children: [new PageBreak()] })
  );
  addWordSection(children, '1. Executive Summary', [model.executiveSummary]);
  addWordSection(children, '2. Business Requirement', [model.businessRequirement]);
  addWordSection(children, '3. Solution Overview', [model.solutionOverview]);
  children.push(new Paragraph({ text: '4. Salesforce Components Modified', heading: HeadingLevel.HEADING_1 }));
  for (const category of model.components) {
    children.push(new Paragraph({ text: category.category, heading: HeadingLevel.HEADING_2 }));
    for (const item of category.items) children.push(new Paragraph({ text: item, bullet: { level: 0 } }));
  }
  addWordSection(children, '5. Implementation Details', model.implementationDetails);
  addWordSection(children, '6. Existing Functionality Reused', [model.existingFunctionalityReused]);
  addWordSection(children, '7. Validation Summary', [model.validationSummary]);
  addWordSection(children, '8. Deployment Summary', [model.deploymentSummary]);
  addWordSection(children, '9. Business Impact', [model.businessImpact]);
  children.push(new Paragraph({ text: '10. User Verification Steps', heading: HeadingLevel.HEADING_1 }));
  model.userVerificationSteps.forEach((step, index) => children.push(new Paragraph({ text: `${index + 1}. ${step}` })));
  children.push(new Paragraph({ text: '11. Future Recommendations', heading: HeadingLevel.HEADING_1 }));
  for (const item of model.futureRecommendations) children.push(new Paragraph({ text: item, bullet: { level: 0 } }));
  children.push(new Paragraph({ text: '12. Appendix', heading: HeadingLevel.HEADING_1 }), new Paragraph({ text: 'Deployment Timeline', heading: HeadingLevel.HEADING_2 }));
  for (const item of model.appendix.timeline) children.push(new Paragraph({ children: [new TextRun({ text: `${item.stage}: `, bold: true }), new TextRun(item.date)] }));
  children.push(new Paragraph({ text: 'Files Changed', heading: HeadingLevel.HEADING_2 }), new Paragraph({ children: [new TextRun({ text: 'Created', bold: true })] }));
  for (const item of model.appendix.filesChanged.created) children.push(new Paragraph({ text: item, bullet: { level: 0 } }));
  children.push(new Paragraph({ children: [new TextRun({ text: 'Modified', bold: true })] }));
  for (const item of model.appendix.filesChanged.modified) children.push(new Paragraph({ text: item, bullet: { level: 0 } }));

  return Packer.toBuffer(new Document({
    creator: 'Providus Nexus',
    title: model.cover.reportTitle,
    description: 'Salesforce implementation report',
    sections: [{ properties: {}, children }]
  }));
}

export function renderImplementationPdf(model, logo = null) {
  return new Promise((resolvePromise, rejectPromise) => {
    const document = new PDFDocument({ size: 'A4', margins: { top: 54, bottom: 54, left: 58, right: 58 }, info: { Title: model.cover.reportTitle, Author: 'Providus Nexus' } });
    const chunks = [];
    document.on('data', (chunk) => chunks.push(chunk));
    document.on('end', () => resolvePromise(Buffer.concat(chunks)));
    document.on('error', rejectPromise);
    if (logo) document.image(logo.buffer, { fit: [180, 72], align: 'center' }).moveDown(1.5);
    document.font('Helvetica-Bold').fontSize(22).fillColor('#16325c').text('Providus Nexus', { align: 'center' }).moveDown(0.7);
    document.fontSize(18).fillColor('#181818').text(model.cover.reportTitle, { align: 'center' }).moveDown(1.5);
    document.font('Helvetica').fontSize(10).fillColor('#444444');
    for (const [label, value] of coverEntries(model.cover)) document.text(`${label}: ${value}`, { align: 'center' }).moveDown(0.35);
    document.addPage();
    pdfSection(document, '1. Executive Summary', [model.executiveSummary]);
    pdfSection(document, '2. Business Requirement', [model.businessRequirement]);
    pdfSection(document, '3. Solution Overview', [model.solutionOverview]);
    pdfHeading(document, '4. Salesforce Components Modified', 15);
    for (const category of model.components) {
      pdfHeading(document, category.category, 12);
      pdfBullets(document, category.items);
    }
    pdfSection(document, '5. Implementation Details', model.implementationDetails);
    pdfSection(document, '6. Existing Functionality Reused', [model.existingFunctionalityReused]);
    pdfSection(document, '7. Validation Summary', [model.validationSummary]);
    pdfSection(document, '8. Deployment Summary', [model.deploymentSummary]);
    pdfSection(document, '9. Business Impact', [model.businessImpact]);
    pdfHeading(document, '10. User Verification Steps', 15);
    model.userVerificationSteps.forEach((step, index) => pdfParagraph(document, `${index + 1}. ${step}`));
    pdfHeading(document, '11. Future Recommendations', 15);
    pdfBullets(document, model.futureRecommendations);
    pdfHeading(document, '12. Appendix', 15);
    pdfHeading(document, 'Deployment Timeline', 12);
    for (const item of model.appendix.timeline) pdfParagraph(document, `${item.stage}: ${item.date}`);
    pdfHeading(document, 'Files Changed', 12);
    pdfParagraph(document, 'Created', true);
    pdfBullets(document, model.appendix.filesChanged.created);
    pdfParagraph(document, 'Modified', true);
    pdfBullets(document, model.appendix.filesChanged.modified);
    document.end();
  });
}

export async function readImplementationReportArtifact(job, deploymentVersion, format) {
  const normalizedFormat = String(format || '').toLowerCase();
  if (!IMPLEMENTATION_REPORT_FORMATS[normalizedFormat]) throw reportError('Unsupported implementation report format.', 422);
  const version = Number(deploymentVersion);
  if (!Number.isInteger(version) || version < 1) throw reportError('Deployment version must be a positive integer.', 422);
  const report = (job.implementationReports || []).find((item) => item.deploymentVersion === version && item.status === 'READY');
  if (!report) throw reportError('Implementation report was not found for this deployment version.', 404);
  const artifact = report.formats?.[normalizedFormat];
  if (!artifact?.relativePath) throw reportError('Requested implementation report format is unavailable.', 404);
  const jobRoot = resolve(config.workspaceRoot, 'jobs', job.jobId);
  const target = resolve(jobRoot, artifact.relativePath);
  if (!isPathInside(jobRoot, target)) throw reportError('Implementation report path is invalid.', 400);
  const buffer = await readFile(target);
  if (buffer.length !== artifact.sizeBytes || hashBuffer(buffer) !== artifact.sha256) throw reportError('Implementation report integrity verification failed.', 409);
  return { report, artifact, buffer };
}

export function publicImplementationReport(report) {
  return {
    reportId: report.reportId,
    status: report.status,
    deploymentVersion: report.deploymentVersion,
    planVersion: report.planVersion,
    title: report.title,
    jiraIssueKey: report.jiraIssueKey,
    customerName: report.customerName,
    orgDisplayName: report.orgDisplayName,
    environment: report.environment,
    generatedAt: report.generatedAt,
    generatedBy: report.generatedBy,
    formats: Object.values(report.formats || {}).map((artifact) => ({ format: artifact.format, fileName: artifact.fileName, contentType: artifact.contentType, sizeBytes: artifact.sizeBytes }))
  };
}

function categorizeComponents(components, fileOperations, dataOperations) {
  const categories = new Map(COMPONENT_CATEGORIES.map((category) => [category, []]));
  const source = components.length ? components : fileOperations.map((operation) => ({ displayName: operation.metadataType || operation.componentType || '', apiName: operation.apiName || operation.path || '' }));
  for (const component of source) {
    const category = categoryFor(component.displayName);
    const name = friendlyComponentName(component.apiName || component.displayName);
    if (name && !categories.get(category).includes(name)) categories.get(category).push(name);
  }
  for (const operation of dataOperations) {
    const name = `${titleCase(operation.operation || 'Record change')} on ${friendlyComponentName(operation.objectApiName || 'Salesforce record')}`;
    if (!categories.get('Data').includes(name)) categories.get('Data').push(name);
  }
  return [...categories.entries()].map(([category, items]) => ({ category, items: items.length ? items : ['None'] }));
}

function categoryFor(type) {
  const value = String(type || '').toLowerCase();
  if (/customobject|object/.test(value)) return 'Objects';
  if (/customfield|field|valueset|recordtype|validationrule/.test(value)) return 'Fields';
  if (/flow/.test(value)) return 'Flows';
  if (/layout|flexipage|lightning page|customtab|application/.test(value)) return 'Layouts and Lightning Pages';
  if (/permission|profile|security/.test(value)) return 'Permission Sets and Security';
  if (/lightningcomponent|aura|lwc/.test(value)) return 'LWCs';
  if (/apex|trigger/.test(value)) return 'Apex';
  if (/report/.test(value)) return 'Reports';
  if (/dashboard/.test(value)) return 'Dashboards';
  if (/credential|connectedapp|authprovider|remote|integration|platformevent/.test(value)) return 'Integrations';
  if (/record|data/.test(value)) return 'Data';
  return 'Other';
}

function componentDetails(categories, deploymentSummary) {
  const details = [];
  for (const category of categories) {
    const items = category.items.filter((item) => item !== 'None');
    if (items.length) details.push(`${category.category}: ${items.join(', ')}. These approved components were successfully included in the deployment.`);
  }
  if (!details.length) details.push(sentence(cleanText(deploymentSummary || 'The approved Salesforce change was deployed successfully.')));
  return details;
}

function reusedFunctionality(plan) {
  const existing = (plan.existingRelevantMetadata || []).map((item) => friendlyComponentName(item.apiName || item)).filter(Boolean);
  if (existing.length) return `The implementation reused and extended the existing ${existing.join(', ')} configuration. No duplicate replacement was introduced where the established Salesforce design could be safely retained.`;
  return 'The implementation retained the existing Salesforce configuration wherever possible and limited the deployment to the approved business requirement. Unrelated functionality was not replaced.';
}

function professionalRequirement(summary, businessImpact, instructions) {
  const impact = cleanText(businessImpact || 'improve the relevant Salesforce business process');
  const followUp = instructions.length ? ` The final delivery also reflects ${instructions.length} approved follow-up instruction${instructions.length === 1 ? '' : 's'} provided during review.` : '';
  return `The customer required Salesforce to support ${lowerFirst(summary)}. The objective was to ${lowerFirst(impact.replace(/[.!?]+$/, ''))} while preserving unrelated business behavior.${followUp}`;
}

function professionalSolution(plan, reused) {
  const implementation = sentence(cleanText(plan.proposedImplementation || plan.expectedOutcome || 'The approved Salesforce configuration was updated'));
  return `${implementation} This approach was selected because it delivers the approved outcome with a limited change surface and follows the existing Salesforce design. ${reused}`;
}

function userVerificationSteps(summary, acceptanceCriteria) {
  const criteria = cleanText(acceptanceCriteria, 500);
  return [
    'Sign in to the approved Salesforce environment using a user with the expected business permissions.',
    `Open the Salesforce area related to ${lowerFirst(summary)}.`,
    criteria ? `Complete the expected business scenario and confirm this outcome: ${sentence(criteria)}` : 'Complete the expected business scenario described in the Jira ticket.',
    'Confirm that the updated behavior is visible and that unrelated Salesforce processes continue to work normally.',
    'Record any unexpected result in the Jira ticket for follow-up.'
  ];
}

function futureRecommendationsFor(categories) {
  const active = categories.filter((category) => !category.items.includes('None')).map((category) => category.category);
  const recommendations = [
    'Monitor user feedback during the first business cycle after deployment.',
    'Keep regression tests and administrator documentation current as the business process evolves.'
  ];
  if (active.includes('Flows') || active.includes('Apex') || active.includes('Integrations')) recommendations.push('Review operational error monitoring regularly so unexpected processing issues are identified early.');
  else recommendations.push('Review access and page configuration periodically to ensure they continue to match user responsibilities.');
  return recommendations;
}

function friendlyFilesChanged(fileOperations, deploymentComponents) {
  const created = [];
  const modified = [];
  for (const operation of fileOperations) {
    const name = friendlyComponentName(operation.apiName || operation.fullName || operation.path || operation.metadataType);
    const action = String(operation.operation || operation.action || '').toLowerCase();
    const target = action === 'create' || action === 'add' ? created : modified;
    if (name && !target.includes(name)) target.push(name);
  }
  if (!created.length && !modified.length) {
    for (const component of deploymentComponents) {
      const name = friendlyComponentName(component.apiName || component.displayName);
      if (name && !modified.includes(name)) modified.push(name);
    }
  }
  return { created: created.length ? created : ['None'], modified: modified.length ? modified : ['None'] };
}

function deploymentTimeline(job, deployment, generatedAt) {
  return [
    { stage: 'Requirement received', date: formatDateTime(job.createdAt) },
    { stage: 'Implementation completed', date: formatDateTime(job.implementation?.implementedAt) },
    { stage: 'Validation completed', date: formatDateTime(job.validation?.timestamp) },
    { stage: 'Deployment completed', date: formatDateTime(deployment.deployedAt) },
    { stage: 'Implementation report generated', date: formatDateTime(generatedAt) }
  ];
}

function coverEntries(cover) {
  return [
    ['Jira Issue', `${cover.jiraIssueKey} - ${cover.jiraIssueSummary}`],
    ['Customer', cover.customerName],
    ['Salesforce Org', cover.salesforceOrg],
    ['Environment', cover.environment],
    ['Deployment Version', cover.deploymentVersion],
    ['Generated Date', cover.generatedDate],
    ['Generated By', cover.generatedBy]
  ];
}

function coverParagraphs(cover) {
  return coverEntries(cover).map(([label, value]) => new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `${label}: `, bold: true }), new TextRun(String(value))] }));
}

function addWordSection(children, heading, paragraphs) {
  children.push(new Paragraph({ text: heading, heading: HeadingLevel.HEADING_1 }));
  for (const paragraph of paragraphs) children.push(new Paragraph({ text: paragraph }));
}

function pdfHeading(document, text, size) {
  if (document.y > 730) document.addPage();
  document.moveDown(0.7).font('Helvetica-Bold').fontSize(size).fillColor('#16325c').text(text).moveDown(0.35);
}

function pdfParagraph(document, text, bold = false) {
  if (document.y > 740) document.addPage();
  document.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10.5).fillColor('#181818').text(text, { lineGap: 2 }).moveDown(0.55);
}

function pdfSection(document, heading, paragraphs) {
  pdfHeading(document, heading, 15);
  for (const paragraph of paragraphs) pdfParagraph(document, paragraph);
}

function pdfBullets(document, items) {
  for (const item of items) {
    if (document.y > 740) document.addPage();
    document.font('Helvetica').fontSize(10.5).fillColor('#181818').text(`- ${item}`, { indent: 12, lineGap: 2 }).moveDown(0.35);
  }
}

async function loadConfiguredLogo() {
  if (!config.implementationReportLogoPath) return null;
  const root = resolve(config.projectRoot);
  const path = resolve(root, config.implementationReportLogoPath);
  if (!isPathInside(root, path)) return null;
  const extension = extname(path).toLowerCase();
  if (!['.png', '.jpg', '.jpeg'].includes(extension)) return null;
  try {
    return { buffer: await readFile(path), type: extension === '.png' ? 'png' : 'jpg' };
  } catch {
    return null;
  }
}

async function readExistingManifest(directory) {
  try {
    return JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function deploymentFingerprint(job, deployment) {
  return createHash('sha256').update(JSON.stringify({
    sourceHash: deployment.sourceHash || '',
    packageHash: deployment.packageHash || '',
    planVersion: job.plan?.planVersion || job.iteration || 1,
    targetOrg: deployment.targetOrgId || job.orgContext?.expectedOrgId || ''
  })).digest('hex');
}

function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function friendlyComponentName(value) {
  let text = cleanText(value, 300).replace(/\\/g, '/');
  if (text.includes('/')) text = basename(text);
  text = text
    .replace(/\.(?:field|flow|layout|flexipage|permissionset|profile|report|dashboard|cls|trigger)-meta\.xml$/i, '')
    .replace(/\.(?:xml|cls|trigger)$/i, '')
    .split('.').pop()
    .replace(/__(?:c|mdt|e|x)$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? titleCase(text) : '';
}

function cleanText(value, maxLength = 2000) {
  return sanitizeUntrustedText(String(value || ''), maxLength)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanFilePart(value) {
  return String(value || '').replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 60) || 'Salesforce';
}

function markdownText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_{}[\]()#+!|])/g, '\\$1');
}

function titleCase(value) {
  return String(value || '').toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function lowerFirst(value) {
  const text = String(value || '').trim();
  return text ? `${text[0].toLowerCase()}${text.slice(1)}` : '';
}

function sentence(value) {
  const text = String(value || '').trim();
  return text && !/[.!?]$/.test(text) ? `${text}.` : text;
}

function friendlyEnvironment(value) {
  return titleCase(String(value || 'Salesforce environment').replace(/[_-]+/g, ' '));
}

function formatDate(value) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? 'Not available' : new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(date);
}

function formatDateTime(value) {
  if (!value) return 'Not available';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not available' : new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date);
}

function reportError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode, code: 'IMPLEMENTATION_REPORT_ERROR' });
}
