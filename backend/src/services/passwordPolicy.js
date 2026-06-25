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

// Full validation: complexity only. (Breach check removed — any password meeting
// the complexity criteria is accepted.) Kept async so callers can keep awaiting it.
async function validatePassword(password) {
  return validateComplexity(password);
}

module.exports = { validateComplexity, validatePassword, MIN_LENGTH, MAX_LENGTH };
