const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles } = require('../middleware/rbac');
const c = require('../controllers/couriers.controller');

const canView  = allowRoles('Admin', 'Owner', 'Office_POC', 'Warehouse_POC', 'Purchase_Team', 'PO_Executive');
const canAdmin = allowRoles('Admin', 'Owner');

router.get('/',       auth, canView,  c.list);
router.post('/',      auth, canAdmin, c.create);
router.patch('/:id',  auth, canAdmin, c.update);
router.delete('/:id', auth, canAdmin, c.remove);

module.exports = router;
