/**
 * Officer authentication.
 *
 * For the pilot: username + password against the officers table.
 * Production should swap this for SSO against the ministry directory.
 */

const bcrypt = require('bcryptjs');
const { db } = require('./db');

function authenticateOfficer(username, password) {
  const officer = db.prepare(`
    SELECT id, username, password_hash, name, email, ministry, role
    FROM officers
    WHERE username = ?
  `).get(username);
  if (!officer) return null;
  const ok = bcrypt.compareSync(password, officer.password_hash);
  if (!ok) return null;
  // Don't leak the hash to callers.
  delete officer.password_hash;
  return officer;
}

function requireOfficer(req, res, next) {
  if (req.session && req.session.officer) return next();
  if (req.accepts('html') && !req.path.startsWith('/api/')) {
    return res.redirect('/officer/login?next=' + encodeURIComponent(req.originalUrl));
  }
  return res.status(401).json({ error: 'Not authenticated' });
}

module.exports = { authenticateOfficer, requireOfficer };
