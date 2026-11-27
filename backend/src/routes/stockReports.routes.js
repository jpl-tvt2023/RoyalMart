const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles, ALL_ROLES, ADMIN_ROLES } = require('../middleware/rbac');
const c = require('../controllers/stockCount.controller');

// Stock from the daily counts (migrations 102, 103), in the portal. A portal
// login for everything -- the station's PIN token fails auth.js outright.
//
// Everyone logged in sees stock and each day's count, with packs named by
// batch # and label no. Admin/Owner alone see missed scans (the scanner's
// mistakes), the cross-check against dispatches and sticker keys. The page
// hides those tabs too, but this is the check that counts. There is nothing
// to reopen since 103: a count is a day, finished at midnight IST.

const everyone = allowRoles(...ALL_ROLES);
const admins = allowRoles(...ADMIN_ROLES);

router.use(auth);

router.get('/summary',             everyone, c.summary);
router.get('/counts',              everyone, c.listCounts);
router.get('/counts/:id/packs',    everyone, c.countPacks);
router.get('/counts/:id',          everyone, c.getCount);
router.get('/missed',              admins,   c.missedByCount);
router.get('/missed/:id',          admins,   c.missedPacks);
router.get('/cross-check',         admins,   c.crossCheck);
router.get('/keys',                admins,   c.stickerList);   // the Current stock download
router.get('/keys/:key',           admins,   c.keyHistory);

module.exports = router;
