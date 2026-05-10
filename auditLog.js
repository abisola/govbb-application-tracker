/**
 * Audit log helper.
 *
 * One function — logAction() — used by every meaningful route in server.js.
 * The schema is intentionally flexible: action is a free-text string that
 * follows a "<entity>.<verb>" convention so the admin view can group and
 * filter cleanly without an enum to maintain.
 *
 * Conventions:
 *   actor          - the officer performing the action (or null for system /
 *                    webhook events). actor_label is denormalised so the row
 *                    survives the officer being later deactivated/renamed.
 *   action         - "officer.create", "officer.update", "officer.deactivate",
 *                    "officer.password_reset",
 *                    "officer.programmes_update",
 *                    "programme.create", "programme.update",
 *                    "programme.toggle_accepting",
 *                    "application.status_change", "application.assign",
 *                    "application.intake" (from webhook),
 *                    "login.success", "login.fail", "logout",
 *                    "test_email.send"
 *   target_kind    - 'officer' | 'programme' | 'application' | 'session' |
 *                    'api_client' | null
 *   target_id      - the row id of the target, when applicable
 *   before / after - JSON snapshots of relevant fields. Either may be null
 *                    (creates have no `before`; deletes have no `after`).
 *   metadata       - free-form bag for ip, user agent, application code, etc.
 */

const { db } = require('./db');

const insertAuditRow = db.prepare(`
  INSERT INTO audit_log (
    actor_officer_id, actor_label,
    action, target_kind, target_id,
    before_json, after_json, metadata_json
  ) VALUES (
    @actor_officer_id, @actor_label,
    @action, @target_kind, @target_id,
    @before_json, @after_json, @metadata_json
  )
`);

function safeJson(v) {
  if (v == null) return null;
  try { return JSON.stringify(v); } catch (_) { return null; }
}

/**
 * Log an action. Never throws — audit failures must not break the user-facing
 * action. Returns the inserted row id, or null on failure.
 */
function logAction({
  actor = null,            // req.session.officer or null
  action,
  target_kind = null,
  target_id = null,
  before = null,
  after = null,
  metadata = null
}) {
  try {
    const info = insertAuditRow.run({
      actor_officer_id: actor && actor.id ? actor.id : null,
      actor_label: actor ? `${actor.username} (${actor.name})` : null,
      action,
      target_kind,
      target_id: target_id == null ? null : Number(target_id),
      before_json: safeJson(before),
      after_json: safeJson(after),
      metadata_json: safeJson(metadata)
    });
    return info.lastInsertRowid;
  } catch (e) {
    console.error('[audit] failed to write audit row:', e.message);
    return null;
  }
}

/** Helper: pull an actor object from an Express req. */
function actorFromReq(req) {
  return (req && req.session && req.session.officer) || null;
}

/** Helper: capture ip + user agent for the metadata bag. */
function requestMeta(req, extra = {}) {
  return {
    ip: req && (req.ip || (req.connection && req.connection.remoteAddress)) || null,
    user_agent: req && req.headers && req.headers['user-agent'] || null,
    ...extra
  };
}

/**
 * Paginated read for the admin UI. `before` is an audit_log.id; pass it to
 * page back through history (keyset pagination — stable under inserts).
 */
function listAuditLog({ limit = 50, before = null, action = null, target_kind = null, target_id = null } = {}) {
  const where = [];
  const params = [];
  if (before != null) { where.push('id < ?'); params.push(Number(before)); }
  if (action) { where.push('action = ?'); params.push(action); }
  if (target_kind) { where.push('target_kind = ?'); params.push(target_kind); }
  if (target_id != null) { where.push('target_id = ?'); params.push(Number(target_id)); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT id, actor_officer_id, actor_label, action,
           target_kind, target_id,
           before_json, after_json, metadata_json,
           created_at
    FROM audit_log
    ${whereSql}
    ORDER BY id DESC
    LIMIT ?
  `).all(...params, Math.max(1, Math.min(500, Number(limit) || 50)));
  return rows.map(r => ({
    ...r,
    before: r.before_json ? safeParse(r.before_json) : null,
    after:  r.after_json  ? safeParse(r.after_json)  : null,
    metadata: r.metadata_json ? safeParse(r.metadata_json) : null
  }));
}

function safeParse(s) { try { return JSON.parse(s); } catch (_) { return null; } }

module.exports = { logAction, actorFromReq, requestMeta, listAuditLog };
