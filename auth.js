/**
 * Officer authentication.
 *
 * For the pilot: username + password against the officers table.
 * Production should swap this for SSO against the ministry directory.
 *
 * Roles:
 *   - is_admin = 1: full system access (manage users, programmes, see audit log
 *     and dashboard, see all applications across programmes).
 *   - is_admin = 0: regular officer; sees only applications in programmes
 *     they're assigned to via officer_programmes.
 *
 *   - is_active = 0: officer cannot log in. Their historical actions remain in
 *     the audit log; this is a soft delete.
 */

const bcrypt = require('bcryptjs');
const { db } = require('./db');

function authenticateOfficer(username, password) {
  const officer = db.prepare(`
    SELECT id, username, password_hash, name, email, ministry, role,
           is_admin, is_active
    FROM officers
    WHERE username = ?
  `).get(username);
  if (!officer) return null;
  if (!officer.is_active) return { _inactive: true };
  const ok = bcrypt.compareSync(password, officer.password_hash);
  if (!ok) return null;
  // Don't leak the hash to callers; coerce booleans.
  delete officer.password_hash;
  officer.is_admin = Boolean(officer.is_admin);
  officer.is_active = Boolean(officer.is_active);
  return officer;
}

function requireOfficer(req, res, next) {
  if (req.session && req.session.officer) return next();
  if (req.accepts('html') && !req.path.startsWith('/api/')) {
    return res.redirect('/officer/login?next=' + encodeURIComponent(req.originalUrl));
  }
  return res.status(401).json({ error: 'Not authenticated' });
}

/** Reject non-admins with 403. Use AFTER requireOfficer. */
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.officer) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (!req.session.officer.is_admin) {
    return res.status(403).json({ error: 'Admin role required' });
  }
  return next();
}

module.exports = { authenticateOfficer, requireOfficer, requireAdmin };
