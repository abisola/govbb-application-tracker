/**
 * Reference-code generator.
 *
 * Format: PROGRAMME-YEAR-XXXXXXX (e.g. BYAC-2026-A4F2K9X)
 *
 *   - PROGRAMME comes from programmes.code (already short, e.g. BYAC, HIRED).
 *   - YEAR is the current calendar year — useful for support staff and easy
 *     to read off; not the entropy.
 *   - XXXXXXX is 7 random characters from a base32 alphabet that excludes
 *     0, O, I and 1 (the four most-confused glyphs on phone screens).
 *     32 - 4 = 28 symbols. 28^7 ≈ 1.3 × 10^10 codes per programme/year,
 *     and roughly 33.5 bits of entropy — enough that brute-force lookup
 *     against the public API is impractical with even modest rate limiting.
 *
 * The reference code IS the authentication for the citizen-facing tracker.
 * Treat it as a moderate secret — link in confirmation email + tracker URL,
 * never displayed in URLs other code can scrape, never put in logs.
 */

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // base32 minus 0, O, I, 1

function randomChar() {
  // crypto.randomInt is uniform in [0, max).
  return ALPHABET[crypto.randomInt(ALPHABET.length)];
}

function generateCode(programmeCode, year = new Date().getFullYear()) {
  let suffix = '';
  for (let i = 0; i < 7; i++) suffix += randomChar();
  return `${programmeCode}-${year}-${suffix}`;
}

/** Generate a code that doesn't already exist in the given DB. */
function generateUniqueCode(db, programmeCode) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateCode(programmeCode);
    const exists = db.prepare('SELECT 1 FROM applications WHERE code = ?').get(code);
    if (!exists) return code;
  }
  // Astronomically unlikely; fall back to a longer suffix.
  let suffix = '';
  for (let i = 0; i < 11; i++) suffix += randomChar();
  return `${programmeCode}-${new Date().getFullYear()}-${suffix}`;
}

module.exports = { generateCode, generateUniqueCode };
