const router = require('express').Router();
const { stationAuth } = require('../middleware/stationAuth');
const { stationPinLimiter } = require('../middleware/rateLimit');
const c = require('../controllers/barcodeStation.controller');
const counts = require('../controllers/stockCount.controller');

// The public Barcode Station (migration 098). NOT behind `auth`: warehouse
// staff use it without a portal login. POST /session trades the shared PIN for
// a device token, and everything after `router.use(stationAuth)` requires one.
// There is no allowRoles -- the station token is the whole check, like the RAMS
// integration's service token.
//
// No route here SHOWS keys -- only Admins see them (labelBatches.routes.js).
// The one route that returns keys is the logged print, whose stickers the
// station renders off-screen straight to the printer.

router.post('/session', stationPinLimiter, c.createSession);

router.use(stationAuth);

router.get('/options',                c.options);
router.get('/keys/:key',              c.findKey);
router.get('/batches',                c.list);
router.post('/batches',               c.create);
// Literal segments after :id are distinct paths, but keep them above the bare
// /:id routes anyway, per the house convention.
router.post('/batches/:id/print',     c.print);
router.post('/batches/:id/generate',  c.generate);
router.patch('/batches/:id',          c.update);
router.delete('/batches/:id',         c.remove);

// Daily stock counts (migrations 102, 103). The count is the IST day: no
// start, no close -- the day's first scan creates it and midnight finishes it.
// The results, missed scans and the cross-check are the portal's (/api/stock,
// stockReports.routes.js). No route here says whether a pack was Out: missed
// scans are Admin/Owner only.
router.get('/counts/today',           counts.today);
router.post('/counts/today/scans',    counts.scan);

module.exports = router;
