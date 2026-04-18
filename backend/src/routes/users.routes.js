const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles } = require('../middleware/rbac');
const c = require('../controllers/users.controller');

router.get('/',          auth, allowRoles('Admin','Owner'), c.list);
router.post('/',         auth, allowRoles('Admin','Owner'), c.create);
router.put('/:id',       auth, allowRoles('Admin','Owner'), c.update);
router.delete('/:id',    auth, allowRoles('Admin','Owner'), c.remove);
router.post('/:id/reset-password', auth, allowRoles('Admin','Owner'), c.adminResetPassword);

module.exports = router;
