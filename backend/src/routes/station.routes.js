const router = require('express').Router();
const { stationAuth } = require('../middleware/stationAuth');
const { stationPinLimiter } = require('../middleware/rateLimit');
const c = require('../controllers/barcodeStation.controller');

// The public Barcode Station (migration 098). NOT behind `auth`: warehouse
// staff use it without a portal login. POST /session trades the shared PIN for
// a device token, and everything after `router.use(stationAuth)` requires one.
// There is no allowRoles -- the station token is the whole check, like the RAMS
// integration's service token.

router.post('/session', stationPinLimiter, c.createSession);

router.use(stationAuth);

router.get('/options',                c.options);
router.get('/keys/:key',              c.findKey);
router.get('/batches',                c.list);
router.post('/batches',               c.create);
// Literal segments after :id are distinct paths, but keep them above the bare
// /:id routes anyway, per the house convention.
router.get('/batches/:id/keys',       c.keys);
router.post('/batches/:id/generate',  c.generate);
router.patch('/batches/:id',          c.update);
router.delete('/batches/:id',         c.remove);

module.exports = router;
