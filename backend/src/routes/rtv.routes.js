const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles, ALL_ROLES } = require('../middleware/rbac');
const c = require('../controllers/rtv.controller');

// Same gate as the GRN page it is fed from: any logged-in user. Rows are opened
// by the GRN save, never here, so there is no POST.
const canView = allowRoles(...ALL_ROLES);
const canWrite = allowRoles(...ALL_ROLES);

// Literal segments before /:id -- express 5 matches in order.
router.get('/',                 auth, canView,  c.list);
router.get('/counts-by-vendor', auth, canView,  c.countsByVendor);
router.patch('/:id',            auth, canWrite, c.update);

module.exports = router;
