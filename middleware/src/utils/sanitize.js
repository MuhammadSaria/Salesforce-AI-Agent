const SECRET_PATTERNS = [
  /(?<=Authorization:\s*(?:Bearer|Basic)\s+)[^\s]+/gi,
  /\bsk-[a-zA-Z0-9_-]+\b/g,
  /\b(?:access_token|refresh_token|api_token|client_secret|session_id)\b\s*[:=]\s*["']?[^\s,"'}]+/gi,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g
];

export function sanitizePrompt(prompt, maxLength) {
  const clean = String(prompt || '').replace(/\u0000/g, '').trim();
  if (!clean) {
    throw new Error('Prompt is required.');
  }
  if (clean.length > maxLength) {
    throw new Error(`Prompt exceeds ${maxLength} characters.`);
  }
  return clean;
}

export function redactSecrets(value) {
  let output = String(value || '');
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, '[REDACTED]');
  }
  return output;
}

export function sanitizeUntrustedText(value, maxLength = 20000) {
  return redactSecrets(String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, maxLength));
}
