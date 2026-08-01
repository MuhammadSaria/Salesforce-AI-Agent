import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { requireSalesforceOrgId, requireSalesforceUserId } from '../utils/salesforceId.js';

export async function requireApiAuth(req, res, next) {
  if (config.nodeEnv === 'test' && !config.apiAuthToken) {
    req.actor = freezeActor({ id: String(req.get('x-agent-user-id') || 'salesforce-user').slice(0, 80), orgId: '', canImplement: false, canDeploy: false, role: String(req.get('x-agent-role') || 'developer').toLowerCase(), authMode: 'test-bypass' });
    next();
    return;
  }

  const bearer = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (config.apiAuthToken && safeEqual(bearer, config.apiAuthToken)) {
    req.actor = freezeActor({ id: 'api-client', orgId: '', canImplement: false, canDeploy: false, role: 'service', authMode: 'trusted-internal-service' });
    next();
    return;
  }

  res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } });
}

export function requireSalesforceClaims(req, res, next) {
  try {
    applySalesforceClaims(req);
    next();
  } catch (error) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: error.message } });
  }
}

export function applySalesforceClaims(req) {
  req.actor = salesforceActorFromHeaders(req);
  return req.actor;
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.actor?.role)) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'This action is not permitted.' } });
      return;
    }
    next();
  };
}

function salesforceActorFromHeaders(req) {
  const source = String(req.get('x-agent-source') || '');
  if (source !== 'Salesforce-Apex') throw new Error('Salesforce Apex source header is required.');
  const userId = requireSalesforceUserId(req.get('x-agent-user-id'), 'Salesforce user ID');
  const orgId = requireSalesforceOrgId(req.get('x-agent-org-id'));
  const canImplement = headerBoolean(req.get('x-agent-can-implement'));
  const canDeploy = headerBoolean(req.get('x-agent-can-deploy'));
  if (!isBooleanHeader(req.get('x-agent-can-implement')) || !isBooleanHeader(req.get('x-agent-can-deploy'))) {
    throw new Error('Salesforce permission claim headers are required.');
  }
  return freezeActor({
    id: userId,
    orgId,
    canImplement,
    canDeploy,
    role: 'developer',
    authMode: 'salesforce-claims'
  });
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function headerBoolean(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function isBooleanHeader(value) {
  return ['true', 'false'].includes(String(value || '').trim().toLowerCase());
}

function freezeActor(actor) {
  return Object.freeze(actor);
}
