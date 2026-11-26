const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles, ALL_ROLES, ADMIN_ROLES } = require('../middleware/rbac');
const c = require('../controllers/stockCount.controller');

// Stock from the daily counts (migration 102), in the portal. A portal login
// for everything -- the station's PIN token fails auth.js outright.
//
// Everyone logged in sees stock and each count's results, with packs named by
// batch # and label no. Admin/Owner alone see missed scans (the scanner's
// mistakes), the cross-check against dispatches, sticker keys, and can reopen
// a count closed too early. The page hides those tabs too, but this is the
// check that counts.

const everyone = allowRoles(...ALL_ROLES);
const admins = allowRoles(...ADMIN_ROLES);

router.use(auth);

router.get('/summary',             everyone, c.summary);
router.get('/counts',              everyone, c.listCounts);
router.get('/counts/:id/packs',    everyone, c.countPacks);
router.get('/counts/:id',          everyone, c.getCount);
router.post('/counts/:id/reopen',  admins,   c.reopen);
router.get('/missed',              admins,   c.missedByCount);
router.get('/missed/:id',          admins,   c.missedPacks);
router.get('/cross-check',         admins,   c.crossCheck);
router.get('/keys/:key',           admins,   c.keyHistory);

module.exports = router;
