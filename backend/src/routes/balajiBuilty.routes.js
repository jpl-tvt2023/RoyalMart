const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles, ALL_ROLES } = require('../middleware/rbac');
const c = require('../controllers/balajiBuilty.controller');

const canView  = allowRoles(...ALL_ROLES);
const canWrite = allowRoles(...ALL_ROLES);

// Literal segments before /:id -- express 5 matches in order.
router.get('/',        auth, canView,  c.list);
router.get('/tabs',    auth, canView,  c.tabs);
router.get('/options', auth, canView,  c.options);
router.post('/',       auth, canWrite, c.create);
router.patch('/:id',   auth, canWrite, c.update);
router.delete('/:id',  auth, canWrite, c.remove);

module.exports = router;
