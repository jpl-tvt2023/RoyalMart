const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles, ALL_ROLES } = require('../middleware/rbac');
const c = require('../controllers/couriers.controller');

const canView  = allowRoles(...ALL_ROLES);
// Master data is editable by any logged-in user; every change is audited.
const canAdmin = allowRoles(...ALL_ROLES);

router.get('/',       auth, canView,  c.list);
router.post('/',      auth, canAdmin, c.create);
router.patch('/:id',  auth, canAdmin, c.update);
router.delete('/:id', auth, canAdmin, c.remove);

module.exports = router;
