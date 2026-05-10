/**
 * GovBB Application Tracker — pilot server.
 *
 * Routes:
 *   GET  /                          citizen tracker landing
 *   GET  /track/:code               citizen tracker detail (deeplinkable)
 *   GET  /chat                      citizen tracker, full chat
 *   GET  /confirmation/:code        confirmation page after submitting a form
 *   GET  /submit-test               demo: pretend to submit a form
 *   GET  /officer/login             officer sign-in page
 *   GET  /officer                   officer console (auth required)
 *
 *   POST /api/officer/login         sign in
 *   POST /api/officer/logout        sign out
 *   GET  /api/me                    current officer or 401
 *
 *   GET  /api/programmes            list of programmes (for the test form)
 *   GET  /api/sample-codes          list of seeded codes (for the demo)
 *
 *   POST /api/webhooks/form-submitted   form intake (called by alpha.gov.bb forms)
 *   GET  /api/applications/:code        public lookup by reference code
 *
 *   GET    /api/officer/applications        list (auth)
 *   GET    /api/officer/applications/:id    detail (auth)
 *   PATCH  /api/officer/applications/:id    update status (auth)
 *   POST   /api/officer/applications/:id/assign-me  (auth)
 */

const path = require('path');
const express = require('express');
const session = require('express-session');

const {
  db,
  insertStatusEvent,
  getApplicationByCode,
  getApplicationById,
  listApplicationsForOfficer
} = require('./db');
const { generateUniqueCode } = require('./codes');
const { authenticateOfficer, requireOfficer } = require('./auth');
const { requireApiKey } = require('./apikey');
const {
  sendSubmissionEmail,
  sendStatusChangeEmail,
  emailConfig,
  sendTestEmail
} = require('./notifications');

const app = express();
const PORT = process.env.PORT || 3030;
const IS_PROD = process.env.NODE_ENV === 'production';

// Render terminates HTTPS at its edge and forwards via HTTP. Without this,
// Express won't honour X-Forwarded-Proto / X-Forwarded-For, so secure cookies
// and IP detection would break.
app.set('trust proxy', 1);

// Fail fast in production if the session secret hasn't been set. In dev a
// hard-coded fallback is fine; in production it would let attackers forge
// session cookies.
if (IS_PROD && !process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET must be set in production.');
  process.exit(1);
}

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-only-pilot-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,                 // HTTPS-only in production
    maxAge: 1000 * 60 * 60 * 8
  }
}));

// Lightweight health check for Render's load balancer.
app.get('/healthz', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Email config check — public, no secrets exposed. Tells you whether the key
// is present, the From address, and whether the mail-out dir is writable.
app.get('/healthz/email', (req, res) => {
  const cfg = emailConfig();
  res.json({
    ok: cfg.resend_api_key_set && cfg.mail_out_writable,
    config: cfg,
    instructions: cfg.resend_api_key_set
      ? 'Looks configured. POST /api/officer/test-email with {"to":"you@example.com"} to send a real test (officer auth required).'
      : 'RESEND_API_KEY is not set — emails will land on disk only. Set it in Render env vars to enable real send.'
  });
});

// Officer-only: actually send a real test email. Auth required so this isn't
// an open relay.
app.post('/api/officer/test-email', requireOfficer, async (req, res) => {
  const { to } = req.body || {};
  const result = await sendTestEmail({
    to: (to || '').trim() || req.session.officer.email || null,
    sentByOfficer: req.session.officer.username
  });
  res.status(result.ok ? 200 : 502).json(result);
});

/* =========================================================
   Static + page routes
   ========================================================= */

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/track', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/track/:code', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/confirmation/:code', (req, res) => res.sendFile(path.join(__dirname, 'confirmation.html')));
app.get('/submit-test', (req, res) => res.sendFile(path.join(__dirname, 'submit-test.html')));
app.get('/officer/login', (req, res) => res.sendFile(path.join(__dirname, 'officer-login.html')));
app.get('/officer', requireOfficer, (req, res) => res.sendFile(path.join(__dirname, 'officer.html')));

/* =========================================================
   Auth API
   ========================================================= */

app.post('/api/officer/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const officer = authenticateOfficer(username, password);
  if (!officer) return res.status(401).json({ error: 'Invalid username or password' });
  req.session.officer = officer;
  res.json({ officer });
});

app.post('/api/officer/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.officer) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ officer: req.session.officer });
});

/* =========================================================
   Public API
   ========================================================= */

app.get('/api/programmes', (req, res) => {
  const rows = db.prepare(`
    SELECT code, name, ministry, default_sla_days, contact_email, contact_phone
    FROM programmes
    ORDER BY name
  `).all();
  res.json({ programmes: rows });
});

app.get('/api/sample-codes', (req, res) => {
  const rows = db.prepare(`
    SELECT a.code, p.name AS programme_name, ap.name AS applicant_name, a.current_status
    FROM applications a
    JOIN programmes p ON p.id = a.programme_id
    JOIN applicants ap ON ap.id = a.applicant_id
    ORDER BY a.created_at DESC
    LIMIT 12
  `).all();
  res.json({ codes: rows });
});

app.get('/api/applications/:code', (req, res) => {
  const app = getApplicationByCode(req.params.code.toUpperCase().trim());
  if (!app) return res.status(404).json({ error: 'Application not found' });
  // Citizen view sees a redacted shape — no internal notes, no last name in
  // the object even though we still echo the full applicant_name (they
  // already know it).
  res.json({
    application: {
      code: app.code,
      programme_code: app.programme_code,
      programme_name: app.programme_name,
      ministry: app.ministry,
      contact_email: app.contact_email,
      contact_phone: app.contact_phone,
      default_sla_days: app.default_sla_days,
      applicant_name: app.applicant_name,
      submitted_at: app.created_at,
      current_status: app.current_status,
      current_status_at: app.current_status_at,
      assigned_officer_name: app.assigned_officer_name,
      timeline: app.timeline.map(t => ({
        status: t.status,
        message: t.citizen_message,
        at: t.created_at
      }))
    }
  });
});

/* =========================================================
   Form intake webhook — secured with API key.
   Called by the alpha.gov.bb forms processor on every submission.
   The CALLER generates the reference code; we just store what we're given.
   Idempotent on code: re-posting the same code returns the existing record
   without creating duplicates or re-sending email.
   ========================================================= */

const CODE_PATTERN = /^[A-Z][A-Z0-9_-]*-\d{4}-[A-Z0-9]{6,16}$/;

app.post('/api/webhooks/form-submitted', requireApiKey, (req, res) => {
  const { code, programme_code, applicant, form_data, submitted_at } = req.body || {};

  // Validate code (caller-supplied).
  if (typeof code !== 'string' || !CODE_PATTERN.test(code)) {
    return res.status(400).json({ error: 'code required, format: PROGRAMME-YEAR-XXXXXXX (uppercase letters/digits, 6–16 char suffix).' });
  }
  if (!programme_code) return res.status(400).json({ error: 'programme_code required' });
  if (!applicant || !applicant.name || !applicant.email) {
    return res.status(400).json({ error: 'applicant.name and applicant.email required' });
  }
  if (form_data !== undefined && (form_data === null || typeof form_data !== 'object' || Array.isArray(form_data))) {
    return res.status(400).json({ error: 'form_data must be a JSON object if present' });
  }

  const programme = db.prepare('SELECT * FROM programmes WHERE code = ?').get(programme_code);
  if (!programme) return res.status(404).json({ error: `Unknown programme: ${programme_code}` });

  // Idempotency: if this code already exists, return the existing record.
  // If the existing record is for a different programme or applicant email,
  // that's a clash — return 409 so the caller can investigate.
  const existing = db.prepare(`
    SELECT a.id, a.code, a.programme_id, ap.email AS applicant_email
    FROM applications a JOIN applicants ap ON ap.id = a.applicant_id
    WHERE a.code = ?
  `).get(code);
  if (existing) {
    if (existing.programme_id !== programme.id || existing.applicant_email !== applicant.email) {
      return res.status(409).json({
        error: `Code ${code} is already in use for a different submission.`,
        existing_application_id: existing.id
      });
    }
    return res.status(200).json({
      code: existing.code,
      idempotent: true,
      tracker_url: `/track/${encodeURIComponent(existing.code)}`,
      confirmation_url: `/confirmation/${encodeURIComponent(existing.code)}`
    });
  }

  // Allow caller to specify the submission time (handy if the upstream system
  // queues submissions). Default to "now" otherwise.
  const submittedSql = submitted_at && /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?(\.\d+)?(Z)?$/.test(submitted_at)
    ? submitted_at.replace('T', ' ').replace('Z', '').split('.')[0]
    : null;

  const applicantId = db.prepare(`
    INSERT INTO applicants (name, email, phone) VALUES (?, ?, ?)
  `).run(applicant.name, applicant.email, applicant.phone || null).lastInsertRowid;

  const result = submittedSql
    ? db.prepare(`
        INSERT INTO applications (code, programme_id, applicant_id, current_status, current_status_at, form_data, created_at)
        VALUES (?, ?, ?, 'received', ?, ?, ?)
      `).run(code, programme.id, applicantId, submittedSql, JSON.stringify(form_data || {}), submittedSql)
    : db.prepare(`
        INSERT INTO applications (code, programme_id, applicant_id, current_status, current_status_at, form_data)
        VALUES (?, ?, ?, 'received', datetime('now'), ?)
      `).run(code, programme.id, applicantId, JSON.stringify(form_data || {}));

  const applicationId = result.lastInsertRowid;

  insertStatusEvent({
    application_id: applicationId,
    status: 'received',
    citizen_message: 'Application received and acknowledged.',
    internal_note: `Pushed via API by client #${req.apiClient.id} (${req.apiClient.name}).`,
    by_officer_id: null
  });

  const fullApp = getApplicationById(applicationId);
  // Fire and forget; errors are logged but don't block the HTTP response.
  sendSubmissionEmail(fullApp).catch(e => console.error('Submission email failed:', e));

  res.status(201).json({
    code,
    tracker_url: `/track/${encodeURIComponent(code)}`,
    confirmation_url: `/confirmation/${encodeURIComponent(code)}`
  });
});

/* =========================================================
   Officer API
   ========================================================= */

app.get('/api/officer/applications', requireOfficer, (req, res) => {
  res.json({ applications: listApplicationsForOfficer() });
});

app.get('/api/officer/applications/:id', requireOfficer, (req, res) => {
  const app = getApplicationById(parseInt(req.params.id, 10));
  if (!app) return res.status(404).json({ error: 'Not found' });
  res.json({ application: app });
});

app.patch('/api/officer/applications/:id', requireOfficer, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const app = getApplicationById(id);
  if (!app) return res.status(404).json({ error: 'Not found' });

  const { status, citizen_message, internal_note } = req.body || {};
  if (!status) return res.status(400).json({ error: 'status required' });

  const allowed = JSON.parse(db.prepare('SELECT allowed_statuses FROM programmes WHERE id = ?').get(app.programme_id).allowed_statuses);
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `Status ${status} not allowed for this programme` });
  }

  // Default citizen message if blank — keep this in sync with the UI hint.
  const defaults = {
    received: 'Application received.',
    under_review: 'An officer is now reviewing your application.',
    action_needed: 'We need something from you. Please check your email.',
    approved: 'Decision: approved.',
    rejected: 'Decision: not approved.',
    completed: 'Your application is complete.'
  };
  const finalCitizenMessage = (citizen_message && citizen_message.trim()) || defaults[status] || 'Status updated.';

  insertStatusEvent({
    application_id: id,
    status,
    citizen_message: finalCitizenMessage,
    internal_note: (internal_note && internal_note.trim()) || null,
    by_officer_id: req.session.officer.id
  });

  // Send a status-change email on EVERY change (no throttling, per request).
  // The "significant transitions only + 24h cap" rule is documented in
  // pilot-brief.md and intentionally left off for the pilot demo so every
  // transition produces a visible email.
  const fullApp = getApplicationById(id);
  const lastEvent = fullApp.timeline[fullApp.timeline.length - 1];
  sendStatusChangeEmail(fullApp, lastEvent).catch(e => console.error('Status email failed:', e));

  res.json({ application: getApplicationById(id) });
});

app.post('/api/officer/applications/:id/assign-me', requireOfficer, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const app = getApplicationById(id);
  if (!app) return res.status(404).json({ error: 'Not found' });

  db.prepare('UPDATE applications SET assigned_officer_id = ? WHERE id = ?')
    .run(req.session.officer.id, id);

  insertStatusEvent({
    application_id: id,
    status: app.current_status,
    citizen_message: null,
    internal_note: `Assigned to ${req.session.officer.name}.`,
    by_officer_id: req.session.officer.id
  });

  res.json({ application: getApplicationById(id) });
});

/* =========================================================
   Boot
   ========================================================= */

const programmesCount = db.prepare('SELECT COUNT(*) AS n FROM programmes').get().n;
if (programmesCount === 0) {
  console.log('No programmes found. Run "npm run seed" first.');
}

app.listen(PORT, () => {
  console.log(`\nGovBB Application Tracker pilot`);
  console.log(`  http://localhost:${PORT}/                  citizen tracker`);
  console.log(`  http://localhost:${PORT}/submit-test       demo form submission`);
  console.log(`  http://localhost:${PORT}/officer/login     officer console (andrea / andrea)`);
  console.log(`  Emails written to:  ./mail-out/`);
  console.log(`  Database:           ./data/tracker.db`);
});
