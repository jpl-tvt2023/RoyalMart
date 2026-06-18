const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles, ALL_ROLES } = require('../middleware/rbac');
const c = require('../controllers/procurement.controller');

const canView  = allowRoles(...ALL_ROLES);
const canWrite = allowRoles(...ALL_ROLES);

router.get('/requirements',   auth, canView,  c.getRequirements);
router.post('/mark-ordered',  auth, canWrite, c.markOrdered);
router.get('/batches',        auth, canView,  c.listBatches);
router.delete('/batches/:id', auth, canWrite, c.undoBatch);

module.exports = router;
