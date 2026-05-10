/**
 * API key authentication for the form-intake webhook.
 *
 * The alpha.gov.bb forms processor sends form submissions here over HTTPS
 * with a shared-secret API key in the X-API-Key header (or as a Bearer
 * token in the Authorization header — both accepted for caller convenience).
 *
 * Storage:
 *   - api_clients table holds one row per integrating system. The key itself
 *     is never stored — only its SHA-256 hash. Recover-by-rotation: if a key
 *     leaks, issue a new one and revoke the old by deleting its row.
 *   - SHA-256 (not bcrypt) is used because keys are high-entropy random
 *     strings and the lookup cost matters on every webhook call. Keys MUST
 *     be at least 24 random bytes (~192 bits of entropy) — use
 *     `node tools/issue-api-key.js` (not built yet) or the seed script.
 *
 * The middleware updates last_used_at on every successful auth — useful for
 * spotting clients that have gone silent and clients that should have been
 * decommissioned but weren't.
 */

const crypto = require('crypto');
const { db } = require('./db');

function hashKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

function extractKey(req) {
  const headerKey = req.header('X-API-Key');
  if (headerKey) return headerKey.trim();
  const auth = req.header('Authorization');
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return null;
}

function requireApiKey(req, res, next) {
  const raw = extractKey(req);
  if (!raw) {
    return res.status(401).json({ error: 'API key required. Send X-API-Key header or Authorization: Bearer <key>.' });
  }
  const client = db.prepare(`
    SELECT id, name, scope FROM api_clients WHERE key_hash = ?
  `).get(hashKey(raw));
  if (!client) {
    return res.status(401).json({ error: 'Invalid API key.' });
  }
  // Touch last_used_at so we can spot stale clients later.
  db.prepare(`UPDATE api_clients SET last_used_at = datetime('now') WHERE id = ?`).run(client.id);
  req.apiClient = client;
  next();
}

/** Issue a new key for a named client. Returns { id, plaintext } — show the
 *  plaintext to the operator once, then never again. */
function issueKey(name, scope = null, plaintext = null) {
  const raw = plaintext || ('sk_' + crypto.randomBytes(24).toString('base64url'));
  const hash = hashKey(raw);
  const info = db.prepare(`
    INSERT INTO api_clients (name, key_hash, scope) VALUES (?, ?, ?)
    ON CONFLICT(key_hash) DO UPDATE SET name = excluded.name, scope = excluded.scope
  `).run(name, hash, scope);
  return { id: info.lastInsertRowid, name, plaintext: raw };
}

module.exports = { requireApiKey, issueKey, hashKey };
