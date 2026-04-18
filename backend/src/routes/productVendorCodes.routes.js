const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles } = require('../middleware/rbac');
const c = require('../controllers/productVendorCodes.controller');

const allAuth = allowRoles('Admin', 'Owner', 'Office_POC', 'Purchase_Team', 'Stocks_Team', 'PO_Executive');
const canWrite = allowRoles('Admin', 'Owner', 'PO_Executive');

router.get('/',       auth, allAuth,  c.list);
router.post('/',      auth, canWrite, c.create);
router.put('/:id',    auth, canWrite, c.update);
router.delete('/:id', auth, canWrite, c.remove);

module.exports = router;
