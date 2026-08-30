const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles, ALL_ROLES } = require('../middleware/rbac');
const c = require('../controllers/leadTime.controller');

// Read-only report: no write endpoints, so every route is view-access only.
const canView = allowRoles(...ALL_ROLES);

router.get('/',                  auth, canView, c.list);
router.get('/counts-by-vendor',  auth, canView, c.countsByVendor);

module.exports = router;
