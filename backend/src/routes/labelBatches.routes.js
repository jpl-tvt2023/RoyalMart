const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles, ADMIN_ROLES } = require('../middleware/rbac');
const c = require('../controllers/barcodeStation.controller');

// The Admin side of the Barcode Station (migrations 098-101). Only Admins see
// barcode keys (client's rule), so every route here is a portal login with the
// Admin or Owner role -- the station's PIN token gets nowhere near it.
//
// The station page calls these when the browser it runs in is also logged into
// the portal as Admin/Owner: the grid's key preview, a batch's key list, and
// the print preview. Admins only use their own machines, never the warehouse
// PC, which is why showing keys on the station page itself is acceptable.

router.use(auth, allowRoles(...ADMIN_ROLES));

router.get('/',             c.adminList);
router.get('/:id/keys',     c.keys);
router.post('/:id/print',   c.adminPrint);

module.exports = router;
