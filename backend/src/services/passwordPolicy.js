const crypto = require('crypto');

const MIN_LENGTH = 8;
const MAX_LENGTH = 128; // guard against absurd inputs (bcrypt only uses first 72 bytes)

// Complexity check — runs offline. Returns an error string, or null if OK.
function validateComplexity(password) {
  if (typeof password !== 'string') return 'Password is required';
  if (password.length < MIN_LENGTH) return `Password must be at least ${MIN_LENGTH} characters`;
  if (password.length > MAX_LENGTH) return `Password must be at most ${MAX_LENGTH} characters`;
  if (!/[a-z]/.test(password)) return 'Password must include a lowercase letter';
  if (!/[A-Z]/.test(password)) return 'Password must include an uppercase letter';
  if (!/[0-9]/.test(password)) return 'Password must include a number';
  if (!/[^A-Za-z0-9]/.test(password)) return 'Password must include a symbol';
  return null;
}

// Breached-password check via HaveIBeenPwned k-anonymity range API.
// Only the first 5 chars of the SHA-1 hash leave the server; the full password
// (and full hash) never do. Fails open on network/API error so a HIBP outage
// can't lock users out of changing their password.
async function isBreached(password) {
  try {
    const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true' },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const body = await res.text();
    for (const line of body.split('\n')) {
      const [hashSuffix, count] = line.trim().split(':');
      if (hashSuffix === suffix && Number(count) > 0) return true;
    }
    return false;
  } catch {
    return false; // fail open
  }
}

// Full validation: complexity (sync) then breach check (async).
// Returns an error string, or null if the password is acceptable.
async function validatePassword(password) {
  const complexityError = validateComplexity(password);
  if (complexityError) return complexityError;
  if (await isBreached(password)) {
    return 'This password has appeared in a known data breach. Please choose a different one.';
  }
  return null;
}

module.exports = { validateComplexity, isBreached, validatePassword, MIN_LENGTH, MAX_LENGTH };
