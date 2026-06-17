const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles, ALL_ROLES, ADMIN_ROLES } = require('../middleware/rbac');
const c = require('../controllers/teams.controller');

const adminOnly = allowRoles(...ADMIN_ROLES);
const canView   = allowRoles(...ALL_ROLES);

router.get('/',                        auth, canView, c.list);
router.post('/',                       auth, adminOnly, c.create);
router.put('/:id',                     auth, adminOnly, c.update);
router.delete('/:id',                  auth, adminOnly, c.remove);
router.post('/:id/members',            auth, adminOnly, c.addMember);
router.delete('/:id/members/:memberId',auth, adminOnly, c.removeMember);

module.exports = router;
