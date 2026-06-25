// Password complexity rules mirrored from the backend
// (backend/src/services/passwordPolicy.js). The backend remains the source of truth and
// also runs the HaveIBeenPwned breach check; this is only for live UI feedback.
export const PASSWORD_RULES = [
  { label: 'At least 8 characters', test: (p) => p.length >= 8 },
  { label: 'A lowercase letter', test: (p) => /[a-z]/.test(p) },
  { label: 'An uppercase letter', test: (p) => /[A-Z]/.test(p) },
  { label: 'A number', test: (p) => /[0-9]/.test(p) },
  { label: 'A symbol', test: (p) => /[^A-Za-z0-9]/.test(p) },
];

// True when every complexity rule passes (breach check is server-side only).
export function meetsPasswordPolicy(password) {
  return PASSWORD_RULES.every((r) => r.test(password || ''));
}
