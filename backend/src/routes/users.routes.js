const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles } = require('../middleware/rbac');
const c = require('../controllers/users.controller');

router.get('/',          auth, allowRoles('Admin','Owner'), c.list);
router.post('/',         auth, allowRoles('Admin'), c.create);
router.put('/:id',       auth, allowRoles('Admin'), c.update);
router.delete('/:id',    auth, allowRoles('Admin'), c.remove);
router.post('/:id/reset-password', auth, allowRoles('Admin'), c.adminResetPassword);

module.exports = router;
