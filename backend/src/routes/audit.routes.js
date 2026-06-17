const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles, ALL_ROLES } = require('../middleware/rbac');
const c = require('../controllers/audit.controller');

router.get('/', auth, allowRoles(...ALL_ROLES), c.getEntityHistory);

module.exports = router;
