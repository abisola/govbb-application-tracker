# GovBB Application Tracker — pilot

A working pilot of the application tracker described in [pilot-brief.md](./pilot-brief.md). Built for the Ministry of Youth, Sport and Community Engagement (MYSCE) to use across its YDP programmes (BYAC, Get Hired, Pathways, Digital Media, YES First Contact, Job Start Plus).

It includes:

- a citizen-facing tracker page in the alpha.gov.bb visual aesthetic, with a reference-code lookup, status detail page, and a hybrid chat (chips + free text)
- a confirmation page that's shown after a form submission
- a confirmation email + status-change emails (written to `mail-out/` as HTML and text files for the pilot — open them in any browser to preview)
- an officer console with filterable caseload, drawer detail, status update, and "assign to me"
- a form-intake webhook the existing alpha.gov.bb forms can POST to on submit
- a SQLite database with the full data model from the pilot brief

## Run it

You'll need Node.js 18 or newer.

```sh
cd application-tracker
npm install
npm run seed
npm start
```

Then open <http://localhost:3030/>.

The console output prints all the URLs you care about. To start over with fresh data, run `npm run reset`.

## What to click through

1. <http://localhost:3030/> — citizen tracker landing. The list of "sample codes" at the bottom is taken from seeded data; click any to see the status page.
2. <http://localhost:3030/submit-test> — submit a test application. Pick a programme, leave the defaults, hit Submit. You'll be redirected to the confirmation page, and a confirmation email will be written to `mail-out/`.
3. <http://localhost:3030/officer/login> — sign in as `andrea / andrea` (or `trevor / trevor`, `joy / joy`).
4. In the officer console, click any row → the drawer opens with the full timeline. Change the status, add a citizen-facing message, save. A status-change email is written to `mail-out/`. Switch back to the citizen tab and refresh — the new status is there.

## Where the emails go

Open the most recently modified folder under `mail-out/`. You'll find three files per send:

- `meta.txt` — sender, recipient, subject, kind, timestamp
- `body.html` — the HTML email, exactly as a real provider would render it
- `body.txt` — plain-text fallback

Open `body.html` in a browser to see the email as the citizen would see it.

In production, swap `notifications.js` for a real transport (SES, Mailgun, GovBB's own SMTP relay) — the `writeEmailToDisk` function is the only thing that changes.

### Email diagnostics

Two endpoints help confirm the email pipeline is working end-to-end:

- `GET /healthz/email` — public. Reports whether `RESEND_API_KEY` is set, the `FROM_EMAIL`, the tracker base URL, and whether the mail-out directory is writable. No secrets exposed. Returns `{ "ok": true }` only when the key is present and the disk is writable.
- `POST /api/officer/test-email` — officer auth required. Body: `{"to": "you@example.com"}` (optional – defaults to the signed-in officer's email). Sends a real test email through Resend, writes the audit copy to disk, and returns the Resend message id (`re_…`) on success or the Resend error text on failure. Auth is required so the endpoint isn't an open relay.

A typical post-deploy check from a terminal:

```sh
# 1. Config is wired up?
curl https://your-service.onrender.com/healthz/email

# 2. Sign in, then send a real test
curl -c cookies.txt -X POST https://your-service.onrender.com/api/officer/login \
  -H "Content-Type: application/json" \
  -d '{"username":"andrea","password":"<from deploy logs>"}'

curl -b cookies.txt -X POST https://your-service.onrender.com/api/officer/test-email \
  -H "Content-Type: application/json" \
  -d '{"to":"you@example.com"}'
```

A `200` response with `"delivered_via": "resend"` and a `message_id` starting `re_` confirms full delivery. A `502` with a Resend error in the body tells you exactly what's misconfigured (most often: `FROM_EMAIL` uses a domain that isn't verified yet).

## How the existing alpha.gov.bb forms wire in

The forms processor on alpha.gov.bb POSTs every submission to this tracker over HTTPS, in addition to its existing email-the-MDA flow. The processor generates the reference code (so the citizen's confirmation email and the tracker have the same code from the moment of submission) and sends it across.

```http
POST /api/webhooks/form-submitted
Content-Type: application/json
X-API-Key: <shared secret issued by GovTech>

{
  "code": "BYAC-2026-A4F2K9X",
  "programme_code": "BYAC",
  "applicant": {
    "name": "Kareem Walcott",
    "email": "kareem@example.com",
    "phone": "(246) 555-0102"
  },
  "form_data": { ... whatever the form collected, as JSON ... },
  "submitted_at": "2026-05-09T10:30:00Z"
}
```

`submitted_at` is optional; if omitted, the server stamps with its own clock. `form_data` is whatever JSON the form produced — names, dates, free text, nested objects, arrays — there is no per-programme schema. The officer console renders it as a key/value tree (see "Form data rendering" below).

The response on first submission:

```json
{
  "code": "BYAC-2026-A4F2K9X",
  "tracker_url": "/track/BYAC-2026-A4F2K9X",
  "confirmation_url": "/confirmation/BYAC-2026-A4F2K9X"
}
```

If the same code is POSTed twice (e.g. a network retry from the forms processor), the response is `200` with `"idempotent": true` and no email is re-sent — the original submission is preserved. If a different submission tries to use a code that's already in use, the server returns `409 Conflict`.

The form processor still redirects the citizen to its own existing confirmation page; this tracker also exposes `/confirmation/:code` if a unified confirmation experience is wanted later.

### API key handling

The seed script creates one client called `alpha.gov.bb forms processor (dev)` with a fixed dev key:

```
dev-key-alpha-gov-bb-forms-DO-NOT-USE-IN-PROD
```

Re-run `npm run seed` to rotate it (you'll see the new key printed). For production, replace the `issueKey(...)` call in `seed.js` with one that takes the key from an environment variable, or write a small `tools/issue-api-key.js` that prints a fresh random key and adds the row.

Keys are stored as SHA-256 hashes — the plaintext is never written to disk after issue. Auth fails with `401` if the header is missing or the key is unknown.

### Programmes

The seed loads six: `BYAC`, `HIRED`, `PATH`, `DMP`, `YES`, `JOBSTART`. Add more by editing `PROGRAMMES` in `seed.js`.

### Form data rendering

The officer drawer has a "Submission" section that renders whatever `form_data` came in. The renderer is generic: keys are humanised (`first_name` → "First name", `dateOfBirth` → "Date of birth"), booleans become "Yes"/"No", URLs become links, multi-line strings keep their line breaks, arrays of primitives become comma-separated lists, arrays of objects become numbered sub-trees, and nested objects indent. There is deliberately no per-programme schema — the MVP trusts the upstream form to send sensible data, and falls back gracefully on missing or oddly-typed values.

If you later want field-level intelligence (for example, redacting NRN in the officer view, or showing CV uploads as clickable file links), the renderer is at the bottom of `officer.html` — small additions to `renderValue` will do it.

## Deploy to Render

The repo ships with a Dockerfile and a `render.yaml` Blueprint, so deployment is mostly clicks. Cost is around $7/month for always-on hosting plus $1/month for the persistent disk on the smallest tier; both are right-sizable later.

**1. Push the repo to GitHub.** Either as its own repo, or as a folder inside a wider GovTech monorepo — Render can deploy from a subdirectory.

**2. Sign up for Resend.** Free tier covers the pilot. Get an API key from <https://resend.com/api-keys>. To start, you can use their `onboarding@resend.dev` From address; for "real" branding, verify a sending domain (e.g. `tracker.alpha.gov.bb`) by adding the DNS records Resend gives you.

**3. Create the Render service.** From the Render dashboard: "New +" → "Blueprint" → point at the GitHub repo. Render reads `render.yaml`, creates the web service and the persistent disk in one go.

**4. Set the secret env vars.** In the Render UI, fill in the variables marked `sync: false`:

   - `TRACKER_BASE_URL` — your public URL (Render gives you one like `https://govbb-tracker.onrender.com`; you can swap to `tracker.alpha.gov.bb` later).
   - `RESEND_API_KEY` — from step 2.
   - `FROM_EMAIL` — `GovBB Tracker <onboarding@resend.dev>` to start, or `GovBB Tracker <no-reply@your-verified-domain>` once DNS is verified.
   - `INCOMING_API_KEY` — leave blank on first deploy. The seed will generate one and print it to the logs.
   - `OFFICER_PASSWORD_ANDREA`, `_TREVOR`, `_JOY` — set strong passwords or leave blank to have the seed generate them on first deploy.

   `SESSION_SECRET` is auto-generated by Render and you can ignore it.

**5. Deploy.** Render builds the container, starts it, and runs `node seed.js` once. Watch the logs:

   - Any generated officer passwords print between fenced banners. **Copy them to a password manager immediately** — they aren't stored in plaintext anywhere and re-running the seed won't re-print them.
   - The generated API key for the forms processor prints the same way.

**6. Smoke test.** Visit `https://your-service.onrender.com/healthz` — should return JSON. Then `/officer/login` with the credentials from the logs. Submit a test form via `/submit-test` (paste the seeded API key into the form). Check that the confirmation email arrives at the address you used (Resend's free tier does send to real inboxes).

**7. Custom domain (optional).** Once the ministry has agreed a hostname (e.g. `tracker.alpha.gov.bb`), add it in Render's "Custom Domains" tab and create the CNAME they tell you to. Update `TRACKER_BASE_URL` to match. Update `FROM_EMAIL` to the verified sending address. Tell the alpha.gov.bb forms processor team about the new URL and the production API key.

**Subsequent deploys.** Push to the configured branch (`main` by default) — Render auto-deploys. The seed runs on every boot but is idempotent in production: programmes/officers/api_clients are upserted, application data is never touched. To rotate an officer password, set the env var and redeploy. To rotate the API key, delete `INCOMING_API_KEY` from env, redeploy, and copy the new key from the logs (then issue it to the forms processor team and update the env var to keep it stable).

**Watching production.** Render's logs pane shows every email sent (`[mail] submission → ...`) and every status update. The persistent disk also keeps a copy of every email at `/var/data/mail-out/` — accessible via Render's web shell if you need to debug a non-delivery.

## Architecture

```
application-tracker/
├── server.js              Express app, all routes
├── db.js                  SQLite schema + query helpers
├── codes.js               Reference code generator
├── auth.js                Officer authentication middleware
├── notifications.js       Submission + status-change email
├── seed.js                Sample programmes/officers/applications
├── package.json
├── data/tracker.db        SQLite database file
├── mail-out/              Outgoing emails (one folder per send)
├── index.html             Citizen tracker (path-routed SPA)
├── confirmation.html      "Application sent" page
├── officer.html           Officer console
├── officer-login.html     Sign-in page
├── submit-test.html       Demo form (calls the webhook)
├── pilot-brief.md         Strategic brief
└── README.md              This file
```

The data model has six tables: `programmes`, `applicants`, `applications`, `officers`, `status_events` (append-only timeline), `notifications` (audit log of what we sent). The `status_events` table is the source of truth; `applications.current_status` is a denormalised cache kept in sync inside a transaction whenever a new event is inserted.

## Pilot decisions worth flagging

**The reference code IS the authentication.** No password for citizens — knowing your code is the entire access control. Codes are 7 characters of base32 (minus easily-confused glyphs) appended to a programme prefix and year, giving roughly 33.5 bits of entropy per code. That's enough to make brute-force lookup against the public API impractical with even modest rate limiting; production should add explicit per-IP rate limits to `/api/applications/:code`.

**Emails are nudges, not payloads.** No PII in the body other than the applicant's first name. The link to the tracker is the entire mechanism for actually showing the detail.

**Notifications fire on every status change.** Per request, the "significant transitions only" filter and the 24-hour throttle from the pilot brief are intentionally not in place. Expected behaviour: every status change writes one email file to `mail-out/`. To re-enable the filter later, edit the PATCH handler in `server.js` to skip non-significant transitions.

**Officer auth is username/password against the local DB.** Production should swap `auth.js` for SSO against the ministry directory (Microsoft Entra/Azure AD or similar). Officers' sessions are kept in memory; restarts will sign people out.

**Status taxonomy is shared across all programmes.** The data model supports per-programme taxonomies via `programmes.allowed_statuses`, but the seed sets all six programmes to the same six statuses. Co-design with officers in week 3 of the pilot will tell you whether that holds up.

## Production hardening checklist

When this graduates from pilot to live, these are the items to address:

- Switch SQLite to Postgres; the schema is portable.
- Replace file-based email with a real SMTP/SES transport.
- Replace officer username/password with SSO.
- Add per-IP rate limiting to `/api/applications/:code` and the form-intake webhook.
- Move the session secret to an environment variable / secret manager.
- Add HTTPS termination at the load balancer; set the session cookie to `secure: true`.
- Add the "significant transitions only + 24h throttle" rule to the notification dispatcher.
- Add an officer-facing audit log view (the `notifications` and `status_events` tables already record everything).
- Add a "I lost my code" recovery flow that routes to an officer rather than auto-recovering.
- Decide retention: how long do applications stay in the tracker after the cohort ends?
