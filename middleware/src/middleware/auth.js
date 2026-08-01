import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

export async function requireApiAuth(req, res, next) {
  if (config.nodeEnv === 'test' && !config.apiAuthToken) {
    req.actor = actorFromHeaders(req);
    req.actor.authMethod = 'test-bypass';
    next();
    return;
  }

  const bearer = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (config.apiAuthToken && safeEqual(bearer, config.apiAuthToken)) {
    req.actor = actorFromHeaders(req);
    req.actor.authMethod = 'bearer-token';
    next();
    return;
  }

  res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } });
}

export function requireSalesforceClaims(req, res, next) {
  try {
    req.actor = salesforceActorFromHeaders(req);
    next();
  } catch (error) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: error.message } });
  }
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

function actorFromHeaders(req) {
  if (String(req.get('x-agent-source') || '').trim().toLowerCase() === 'salesforce-apex') {
    try {
      return salesforceActorFromHeaders(req);
    } catch {
      return { id: 'salesforce-user', role: 'developer', canImplement: false, canDeploy: false, orgId: '' };
    }
  }
  return {
    id: String(req.get('x-agent-user-id') || 'salesforce-user').slice(0, 80),
    orgId: '',
    canImplement: false,
    canDeploy: false,
    role: String(req.get('x-agent-role') || 'developer').toLowerCase()
  };
}

function salesforceActorFromHeaders(req) {
  const source = String(req.get('x-agent-source') || '').trim().toLowerCase();
  if (source !== 'salesforce-apex') throw new Error('Salesforce Apex source header is required.');
  const userId = requireSalesforceId(req.get('x-agent-user-id'), 'Salesforce user ID');
  const orgId = requireSalesforceOrgId(req.get('x-agent-org-id'));
  const canImplement = headerBoolean(req.get('x-agent-can-implement'));
  const canDeploy = headerBoolean(req.get('x-agent-can-deploy'));
  if (!isBooleanHeader(req.get('x-agent-can-implement')) || !isBooleanHeader(req.get('x-agent-can-deploy'))) {
    throw new Error('Salesforce permission claim headers are required.');
  }
  return {
    id: userId,
    orgId,
    canImplement,
    canDeploy,
    role: 'developer',
    authMethod: 'salesforce-apex'
  };
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

function requireSalesforceOrgId(value) {
  const id = requireSalesforceId(value, 'Salesforce org ID');
  if (!id.startsWith('00D')) throw new Error('Salesforce org ID header is malformed.');
  return id;
}

function requireSalesforceId(value, label) {
  const text = String(value || '');
  if (text !== text.trim() || !/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(text.trim())) {
    throw new Error(`${label} header is malformed.`);
  }
  return text.trim();
}
