const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles } = require('../middleware/rbac');
const c = require('../controllers/inventory.controller');

const allAuth = allowRoles('Admin','Owner','Office_POC','Purchase_Team','Stocks_Team');

router.get('/',              auth, allAuth, c.list);
router.get('/:skuId/audit',  auth, allAuth, c.auditHistory);

module.exports = router;
