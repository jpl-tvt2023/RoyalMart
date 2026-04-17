const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles } = require('../middleware/rbac');
const c = require('../controllers/supplierPO.controller');

const canView   = allowRoles('Admin','Owner','Purchase_Team','Stocks_Team');
const canCreate = allowRoles('Admin','Owner','Purchase_Team');
const canUpdate = allowRoles('Admin','Owner','Purchase_Team','Stocks_Team');

router.get('/',          auth, canView, c.list);
router.post('/',         auth, canCreate, c.create);
router.patch('/:id/status', auth, canUpdate, c.updateStatus);

module.exports = router;
