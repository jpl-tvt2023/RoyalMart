const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles, ALL_ROLES } = require('../middleware/rbac');
const c = require('../controllers/packagingProducts.controller');

const allAuth = allowRoles(...ALL_ROLES);

router.get('/', auth, allAuth, c.list);

module.exports = router;
