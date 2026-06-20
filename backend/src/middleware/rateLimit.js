const rateLimit = require('express-rate-limit');

// Looser global limiter — guards every endpoint against abuse / scraping.
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,                 // per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests, please try again later.' },
});

module.exports = { globalLimiter };
