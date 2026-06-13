const rateLimit = require('express-rate-limit');

// Looser global limiter — guards every endpoint against abuse / scraping.
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,                 // per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests, please try again later.' },
});

// Strict limiter for credential endpoints — brute-force / credential-stuffing
// protection. Counts only failed responses so a busy legitimate user who keeps
// logging in successfully is not penalised.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                  // failed attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { message: 'Too many login attempts. Please try again in 15 minutes.' },
});

module.exports = { globalLimiter, authLimiter };
