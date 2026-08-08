const rateLimit = require('express-rate-limit');

// Looser global limiter — guards every endpoint against abuse / scraping.
// Disabled under test: the suite drives hundreds of requests from one IP in a
// few minutes, so the limiter would start returning 429 partway through and
// fail every remaining test for reasons unrelated to what they assert.
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,                 // per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests, please try again later.' },
  skip: () => process.env.NODE_ENV === 'test',
});

module.exports = { globalLimiter };
