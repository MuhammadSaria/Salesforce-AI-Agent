import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { loadOrgRegistry } from '../services/orgRegistry.js';

export async function requireApiAuth(req, res, next) {
  if (config.nodeEnv === 'test' && !config.apiAuthToken) {
    req.actor = actorFromHeaders(req);
    next();
    return;
  }

  const bearer = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (config.apiAuthToken && safeEqual(bearer, config.apiAuthToken)) {
    req.actor = actorFromHeaders(req);
    next();
    return;
  }

  if (await isTrustedSalesforceContext(req)) {
    req.actor = actorFromHeaders(req);
    req.actor.authMethod = 'salesforce-apex';
    next();
    return;
  }

  res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } });
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
  const canImplement = headerBoolean(req.get('x-agent-can-implement'));
  const canDeploy = headerBoolean(req.get('x-agent-can-deploy'));
  const source = String(req.get('x-agent-source') || '').trim().toLowerCase();
  const headerRole = String(req.get('x-agent-role') || '').toLowerCase();
  return {
    id: String(req.get('x-agent-user-id') || 'salesforce-user').slice(0, 80),
    orgId: normalizeOrgId(req.get('x-agent-org-id')),
    canImplement,
    canDeploy,
    role: canImplement ? 'admin' : (canDeploy ? 'deployer' : (source === 'salesforce-apex' ? 'developer' : (headerRole || 'developer')))
  };
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function isTrustedSalesforceContext(req) {
  const source = String(req.get('x-agent-source') || '').trim().toLowerCase();
  const orgId = normalizeOrgId(req.get('x-agent-org-id'));
  const userId = String(req.get('x-agent-user-id') || '').trim();
  const canImplement = req.get('x-agent-can-implement');
  const canDeploy = req.get('x-agent-can-deploy');
  if (source !== 'salesforce-apex' || !orgId || !userId || !isBooleanHeader(canImplement) || !isBooleanHeader(canDeploy)) {
    return false;
  }

  const registry = await loadOrgRegistry().catch(() => null);
  if (!registry) return false;
  return registry.orgs.some((org) => org.active && org.authenticationStatus === 'connected' && normalizeOrgId(org.expectedOrgId) === orgId);
}

function normalizeOrgId(value) {
  return String(value || '').trim().slice(0, 15).toUpperCase();
}

function headerBoolean(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function isBooleanHeader(value) {
  return ['true', 'false'].includes(String(value || '').trim().toLowerCase());
}
