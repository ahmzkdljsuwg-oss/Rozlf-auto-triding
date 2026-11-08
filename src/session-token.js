'use strict';

/**
 * Accept either the raw ExpertOption `token` cookie value or a copied
 * semicolon-delimited cookie string. Only the `token` value is returned.
 * Never pass a full cookie header upstream: it may contain unrelated session
 * identifiers and profile metadata.
 */
function normalizeExpertOptionToken(input) {
  if (typeof input !== 'string') return '';
  const value = input.trim().replace(/^(["'])(.*)\1$/s, '$2').trim();
  if (!value) return '';

  const cookieLike = value.includes(';') && /(?:^|;)\s*[^;=]+\s*=/.test(value);
  const parts = value.split(';').map((part) => part.trim()).filter(Boolean);
  const tokenPart = parts.find((part) => /^token\s*=/i.test(part));
  if (tokenPart) {
    const raw = tokenPart.slice(tokenPart.indexOf('=') + 1).trim();
    if (!raw) return '';
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  if (cookieLike || /^token\s*=/i.test(value)) return '';
  return value;
}

module.exports = { normalizeExpertOptionToken };
