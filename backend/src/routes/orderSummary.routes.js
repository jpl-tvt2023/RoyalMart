const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles } = require('../middleware/rbac');
const c = require('../controllers/orderSummary.controller');

const canView  = allowRoles('Admin', 'Owner', 'Office_POC', 'Warehouse_POC', 'Purchase_Team', 'PO_Executive');
const canWrite = allowRoles('Admin', 'Owner', 'Office_POC', 'Warehouse_POC', 'Purchase_Team', 'PO_Executive');

router.get('/',          auth, canView,  c.list);
router.patch('/bulk',    auth, canWrite, c.bulkUpdate);
router.patch('/:poId',   auth, canWrite, c.updateOne);

module.exports = router;
