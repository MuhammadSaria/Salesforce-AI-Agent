import { parseMetadataXml } from './metadataXml.js';

export function validateRecurringDonationFlow(source, context) {
  const xml = parseMetadataXml(source, 'Flow');
  return validateRecurringDonationFlowDocument(xml, context);
}

export function validateRecurringDonationFlowDocument(xml, context) {
  const root = xml.root;
  const statuses = xml.children(root, 'status').map((node) => node.text.trim());
  if (statuses.length !== 1 || statuses[0] !== 'Draft') throw flowError('FLOW_MUST_BE_INACTIVE', 'Flow must contain exactly one Draft status.');
  const start = one(xml, root, 'start');
  if (!start || text(xml, start, 'object') !== context.objectApiName || text(xml, start, 'recordTriggerType') !== 'CreateAndUpdate' || text(xml, start, 'triggerType') !== 'RecordBeforeSave' || text(xml, start, 'doesRequireRecordChangedToMeetCriteria') !== 'true') throw invalid('Flow start does not implement create-and-update transition behavior.');
  if (!hasFilter(xml, start, context.statusField, 'EqualTo', 'stringValue', context.completedValue) || !hasFilter(xml, start, context.installmentField, 'IsNull', 'booleanValue', 'true')) throw invalid('Flow start lacks verified status or non-overwrite criteria.');
  const lookup = xml.children(root, 'recordLookups').find((node) => text(xml, node, 'object') === context.objectApiName && text(xml, node, 'sortField') === context.installmentField);
  if (!lookup || !hasFilter(xml, lookup, context.relationshipField, 'EqualTo', 'elementReference', `$Record.${context.relationshipField}`) || !hasFilter(xml, lookup, context.installmentField, 'IsNull', 'booleanValue', 'false') || text(xml, lookup, 'sortOrder') !== 'Desc' || text(xml, lookup, 'getFirstRecordOnly') !== 'true') throw invalid('Flow lookup is not same-parent highest-number lookup.');
  const lookupName = text(xml, lookup, 'name');
  const formula = xml.children(root, 'formulas').find((node) => normalizeReferenceExpression(text(xml, node, 'expression')) === `${lookupName}.${context.installmentField}+1`);
  if (!formula) throw invalid('Flow must calculate previous installment plus one.');
  const formulaName = text(xml, formula, 'name');
  const assignments = xml.children(root, 'assignments');
  const first = assignments.find((node) => assignment(xml, node, context.installmentField, 'numberValue', '1'));
  const increment = assignments.find((node) => assignment(xml, node, context.installmentField, 'elementReference', formulaName));
  if (!first || !increment) throw invalid('Flow must assign first and increment branches to the verified field.');
  if (assignments.some((node) => text(xml, one(xml, node, 'assignmentItems'), 'assignToReference') === `$Record.${context.installmentField}` && ![first, increment].includes(node))) throw invalid('Flow contains an unapproved installment reassignment or clear.');
  const decisions = xml.children(root, 'decisions');
  const decision = decisions.find((node) => text(xml, node, 'name'));
  if (!decision) throw invalid('Flow decision is missing.');
  const nodes = new Map();
  nodes.set('start', start);
  for (const elements of [xml.children(root, 'recordLookups'), decisions, assignments]) for (const node of elements) if (node) nodes.set(text(xml, node, 'name'), node);
  const reachable = new Set(); const queue = [connectorTarget(xml, start)];
  while (queue.length) {
    const name = queue.shift(); if (!name || reachable.has(name)) continue;
    const node = nodes.get(name); if (!node) throw invalid(`Flow connector references missing node ${name}.`);
    reachable.add(name);
    for (const target of connectorTargets(xml, node)) queue.push(target);
  }
  for (const required of [text(xml, lookup, 'name'), text(xml, decision, 'name'), text(xml, first, 'name'), text(xml, increment, 'name')]) if (!reachable.has(required)) throw invalid(`Flow node ${required} is unreachable from start.`);
  for (const name of nodes.keys()) if (name !== 'start' && !reachable.has(name)) throw invalid(`Flow node ${name} is orphaned or unreachable from start.`);
  return { xml, reachable };
}

function hasFilter(xml, node, field, operator, valueTag, value) { return xml.children(node, 'filters').some((filter) => text(xml, filter, 'field') === field && text(xml, filter, 'operator') === operator && text(xml, one(xml, filter, 'value'), valueTag) === value); }
function assignment(xml, node, field, valueTag, value) { const item = one(xml, node, 'assignmentItems'); return text(xml, item, 'assignToReference') === `$Record.${field}` && text(xml, one(xml, item, 'value'), valueTag) === value; }
function one(xml, node, name) { return xml.child(node, name); }
function text(xml, node, name) { return node ? xml.text(node, name) : ''; }
function connectorTarget(xml, node) { return text(xml, one(xml, node, 'connector'), 'targetReference'); }
function connectorTargets(xml, node) {
  const targets = [];
  const add = (connector) => { const target = text(xml, connector, 'targetReference'); if (target) targets.push(target); };
  add(one(xml, node, 'connector')); add(one(xml, node, 'defaultConnector'));
  for (const rule of xml.children(node, 'rules')) add(one(xml, rule, 'connector'));
  return targets;
}
function invalid(message) { return flowError('SPECIALIST_FLOW_INVALID', message); }
function flowError(code, message) { return Object.assign(new Error(message), { code, statusCode: 409 }); }
function normalizeReferenceExpression(value) { return String(value || '').replace(/[{}!\s]/g, ''); }
