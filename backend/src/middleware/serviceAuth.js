const crypto = require('crypto');
const { tallySyncUser } = require('../services/systemUser.service');

// Machine-to-machine auth for the RAMS integration (/api/integration).
//
// RAMS holds a bearer INTEGRATION_TOKEN, not a user login. The token is
// compared in constant time -- both sides are hashed to equal length first, so
// timingSafeEqual cannot throw on a length mismatch or leak the length. A good
// token makes the request run as the tally-sync system user (migration 094), so
// every write is audited as "Tally Sync".
//
// INTEGRATION_TOKEN is optional and read per request, not through env.js:
// unset means the integration is switched off and every call is a 503.
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

module.exports = async (req, res, next) => {
  try {
    const expected = process.env.INTEGRATION_TOKEN;
    if (!expected) return res.status(503).json({ message: 'The integration is not configured' });

    const header = req.headers.authorization || '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!given || !crypto.timingSafeEqual(digest(given), digest(expected))) {
      return res.status(401).json({ message: 'Invalid integration token' });
    }

    const user = await tallySyncUser();
    if (!user) return res.status(503).json({ message: 'The tally-sync user is missing — apply migration 094' });
    req.user = user;
    next();
  } catch (err) { next(err); }
};
