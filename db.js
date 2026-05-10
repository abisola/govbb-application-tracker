/**
 * SQLite schema + helpers for the GovBB application tracker pilot.
 *
 * Tables follow the data model in pilot-brief.md:
 *   programmes         master list of services that can be tracked
 *   applicants         person who applied (PII source of truth)
 *   applications       one row per submission, with cached current status
 *   officers           back-office users (synced from SSO in production)
 *   status_events      append-only audit log of every status change
 *   notifications      audit log of every email we sent
 *
 * Design choices for the pilot:
 *   - SQLite (better-sqlite3) — zero install, single file at data/tracker.db.
 *     Production should swap for Postgres; the schema is portable.
 *   - status_events is the source of truth. applications.current_status is
 *     a denormalised cache for fast list/filter, kept in sync inside a
 *     transaction whenever a new event is inserted.
 *   - allowed_statuses on programmes is a JSON array so different programmes
 *     can have different state machines without schema changes.
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.TRACKER_DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'tracker.db');
const db = new Database(DB_PATH);
// WAL is the recommended mode for production. Some filesystems (e.g. fuse
// mounts and certain network shares) don't support it; fall back silently
// so the pilot keeps working on developer machines and CI.
try { db.pragma('journal_mode = WAL'); }
catch (e) { /* fall back to default rollback journal */ }
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS programmes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  ministry TEXT NOT NULL,
  default_sla_days INTEGER NOT NULL DEFAULT 14,
  allowed_statuses TEXT NOT NULL,
  contact_email TEXT,
  contact_phone TEXT
);

CREATE TABLE IF NOT EXISTS applicants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS officers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  ministry TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  programme_id INTEGER NOT NULL REFERENCES programmes(id),
  applicant_id INTEGER NOT NULL REFERENCES applicants(id),
  current_status TEXT NOT NULL,
  current_status_at TEXT NOT NULL,
  assigned_officer_id INTEGER REFERENCES officers(id),
  form_data TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS status_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id),
  status TEXT NOT NULL,
  citizen_message TEXT,
  internal_note TEXT,
  by_officer_id INTEGER REFERENCES officers(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id),
  kind TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  recipient TEXT NOT NULL,
  subject TEXT,
  body_path TEXT,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scope TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(current_status);
CREATE INDEX IF NOT EXISTS idx_applications_programme ON applications(programme_id);
CREATE INDEX IF NOT EXISTS idx_status_events_app ON status_events(application_id);
CREATE INDEX IF NOT EXISTS idx_notifications_app ON notifications(application_id);
CREATE INDEX IF NOT EXISTS idx_api_clients_keyhash ON api_clients(key_hash);
`);

/* =========================================================
   Helpers
   ========================================================= */

/**
 * Insert a status event AND update the cached current_status on the
 * application, atomically. Returns the inserted event row.
 */
const insertStatusEvent = db.transaction((event) => {
  const stmt = db.prepare(`
    INSERT INTO status_events (application_id, status, citizen_message, internal_note, by_officer_id)
    VALUES (@application_id, @status, @citizen_message, @internal_note, @by_officer_id)
  `);
  const info = stmt.run({
    application_id: event.application_id,
    status: event.status,
    citizen_message: event.citizen_message || null,
    internal_note: event.internal_note || null,
    by_officer_id: event.by_officer_id || null
  });
  db.prepare(`
    UPDATE applications
    SET current_status = ?, current_status_at = datetime('now')
    WHERE id = ?
  `).run(event.status, event.application_id);
  return db.prepare('SELECT * FROM status_events WHERE id = ?').get(info.lastInsertRowid);
});

/** Fetch one application by reference code, joined with programme + applicant + timeline. */
function getApplicationByCode(code) {
  const app = db.prepare(`
    SELECT a.*, p.code AS programme_code, p.name AS programme_name, p.ministry,
           p.contact_email, p.contact_phone, p.default_sla_days,
           ap.name AS applicant_name, ap.email AS applicant_email, ap.phone AS applicant_phone,
           o.name AS assigned_officer_name, o.email AS assigned_officer_email
    FROM applications a
    JOIN programmes p ON p.id = a.programme_id
    JOIN applicants ap ON ap.id = a.applicant_id
    LEFT JOIN officers o ON o.id = a.assigned_officer_id
    WHERE a.code = ?
  `).get(code);
  if (!app) return null;
  app.timeline = db.prepare(`
    SELECT se.id, se.status, se.citizen_message, se.internal_note, se.created_at,
           o.name AS by_officer_name
    FROM status_events se
    LEFT JOIN officers o ON o.id = se.by_officer_id
    WHERE se.application_id = ?
    ORDER BY se.created_at ASC, se.id ASC
  `).all(app.id);
  return app;
}

/** List for the officer console. Includes the same joins. */
function listApplicationsForOfficer() {
  return db.prepare(`
    SELECT a.id, a.code, a.current_status, a.current_status_at, a.created_at,
           p.code AS programme_code, p.name AS programme_name, p.ministry,
           ap.name AS applicant_name, ap.email AS applicant_email,
           o.id AS assigned_officer_id, o.name AS assigned_officer_name
    FROM applications a
    JOIN programmes p ON p.id = a.programme_id
    JOIN applicants ap ON ap.id = a.applicant_id
    LEFT JOIN officers o ON o.id = a.assigned_officer_id
    ORDER BY a.current_status_at DESC
  `).all();
}

function getApplicationById(id) {
  const app = db.prepare(`
    SELECT a.*, p.code AS programme_code, p.name AS programme_name, p.ministry,
           p.contact_email, p.contact_phone,
           ap.name AS applicant_name, ap.email AS applicant_email, ap.phone AS applicant_phone,
           o.name AS assigned_officer_name
    FROM applications a
    JOIN programmes p ON p.id = a.programme_id
    JOIN applicants ap ON ap.id = a.applicant_id
    LEFT JOIN officers o ON o.id = a.assigned_officer_id
    WHERE a.id = ?
  `).get(id);
  if (!app) return null;
  // Parse the JSON-encoded form_data so the officer view can render it
  // without any JSON.parse on the client. Returned as null if missing or
  // unparseable; never throws.
  try { app.form_data = app.form_data ? JSON.parse(app.form_data) : null; }
  catch (_) { app.form_data = null; }
  app.timeline = db.prepare(`
    SELECT se.id, se.status, se.citizen_message, se.internal_note, se.created_at,
           o.name AS by_officer_name
    FROM status_events se
    LEFT JOIN officers o ON o.id = se.by_officer_id
    WHERE se.application_id = ?
    ORDER BY se.created_at ASC, se.id ASC
  `).all(app.id);
  return app;
}

module.exports = {
  db,
  insertStatusEvent,
  getApplicationByCode,
  getApplicationById,
  listApplicationsForOfficer
};
