const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { JWT_ACCESS_SECRET } = require('../config/env');
const { barcodeStationUser } = require('../services/systemUser.service');

// Device auth for the public Barcode Station (/api/station, migration 098).
//
// Nobody logs in at the station. A device that enters the shared PIN gets a
// station token, and every later request carries it as a Bearer header.
//
// The token is signed with a secret DERIVED from JWT_ACCESS_SECRET, never the
// secret itself: auth.js verifies user tokens with JWT_ACCESS_SECRET and checks
// no claims, so a station token signed with that secret would pass as a user
// with no roles. With the derived key it fails auth.js's signature check
// outright -- and a user token fails this one. Rotating JWT_ACCESS_SECRET
// therefore signs every station out too.
//
// The token carries the PIN version it was issued under (pv). That is compared
// with the stored pin_version on EVERY request -- one indexed single-row read,
// no cache -- so changing the PIN, or "sign out all devices", takes effect at
// once on every serverless instance.
const STATION_SCOPE = 'barcode-station';
const STATION_TOKEN_TTL = '90d';
const STATION_SECRET = crypto.createHmac('sha256', JWT_ACCESS_SECRET).update('roms:barcode-station:v1').digest();

// `code` lets the station page say WHY it is asking for the PIN again.
const NO_SESSION = { message: 'Enter the station PIN to continue', code: 'NO_SESSION' };
const SESSION_EXPIRED = { message: 'Your station session has expired — enter the PIN again', code: 'SESSION_EXPIRED' };
const PIN_CHANGED = { message: 'The station PIN has changed — enter the new PIN', code: 'PIN_CHANGED' };
const NOT_SET_UP_MESSAGE = 'The Barcode Station has not been set up yet — ask an Admin to set a PIN in Purchase Config';

function signStationToken(pinVersion) {
  return jwt.sign({ scope: STATION_SCOPE, pv: Number(pinVersion) }, STATION_SECRET, {
    algorithm: 'HS256',
    expiresIn: STATION_TOKEN_TTL,
  });
}

async function stationAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return res.status(401).json(NO_SESSION);

    let payload;
    try {
      payload = jwt.verify(token, STATION_SECRET, { algorithms: ['HS256'] });
    } catch {
      return res.status(401).json(SESSION_EXPIRED);
    }
    if (!payload || payload.scope !== STATION_SCOPE) return res.status(401).json(SESSION_EXPIRED);

    const { rows } = await db.execute('SELECT pin_hash, pin_version FROM barcode_station_settings WHERE id = 1');
    const settings = rows[0];
    if (!settings || !settings.pin_hash) return res.status(503).json({ message: NOT_SET_UP_MESSAGE });
    if (Number(payload.pv) !== Number(settings.pin_version)) return res.status(401).json(PIN_CHANGED);

    const user = await barcodeStationUser();
    if (!user) return res.status(503).json({ message: 'The barcode-station user is missing — apply migration 098' });

    req.user = user;
    req.stationPinVersion = Number(settings.pin_version);
    next();
  } catch (err) { next(err); }
}

module.exports = { stationAuth, signStationToken, STATION_SCOPE, STATION_SECRET, NOT_SET_UP_MESSAGE };
