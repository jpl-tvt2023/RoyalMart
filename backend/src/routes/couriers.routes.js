const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles, ALL_ROLES, ADMIN_ROLES } = require('../middleware/rbac');
const c = require('../controllers/couriers.controller');

const canView  = allowRoles(...ALL_ROLES);
const canAdmin = allowRoles(...ADMIN_ROLES);

router.get('/',       auth, canView,  c.list);
router.post('/',      auth, canAdmin, c.create);
router.patch('/:id',  auth, canAdmin, c.update);
router.delete('/:id', auth, canAdmin, c.remove);

module.exports = router;
