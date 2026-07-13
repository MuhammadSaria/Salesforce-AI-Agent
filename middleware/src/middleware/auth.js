import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

export function requireApiAuth(req, res, next) {
  if (config.nodeEnv === 'test' && !config.apiAuthToken) {
    req.actor = actorFromHeaders(req);
    next();
    return;
  }

  const bearer = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!config.apiAuthToken || !safeEqual(bearer, config.apiAuthToken)) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } });
    return;
  }
  req.actor = actorFromHeaders(req);
  next();
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
  return {
    id: String(req.get('x-agent-user-id') || 'salesforce-user').slice(0, 80),
    role: String(req.get('x-agent-role') || 'developer').toLowerCase()
  };
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
