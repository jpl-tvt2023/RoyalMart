const rateLimit = require('express-rate-limit');

// Looser global limiter — guards every endpoint against abuse / scraping.
//
// Sized for how this app actually behaves rather than for a generic API: the
// Dashboard alone fires ~10 parallel calls per mount, and a normal working
// session runs to hundreds of requests an hour. The previous 300/15min cap was
// tripping real users mid-session — and because it sits in front of every
// route, it 429'd /auth/login too, so a rate-limited user could not even get
// back in. Note the default store is in-memory, so on Vercel this counts
// per-lambda-instance, not globally.
// Disabled under test: the suite drives hundreds of requests from one IP in a
// few minutes, so the limiter would start returning 429 partway through and
// fail every remaining test for reasons unrelated to what they assert.
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 3000,              // per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests, please try again later.' },
  skip: () => process.env.NODE_ENV === 'test',
});

// Tight limiter for the one unauthenticated write in the app. Counts only
// failed attempts (skipSuccessfulRequests), so a user who logs in normally —
// or who gets it right on the fourth try — is never locked out by their own
// traffic; only sustained wrong guessing trips it.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 20,                // failed attempts per IP per window
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many failed login attempts. Please try again in a few minutes.' },
  skip: () => process.env.NODE_ENV === 'test',
});

module.exports = { globalLimiter, loginLimiter };
