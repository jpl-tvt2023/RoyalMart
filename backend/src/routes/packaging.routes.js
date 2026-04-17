const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles } = require('../middleware/rbac');
const c = require('../controllers/packaging.controller');

const canView   = allowRoles('Admin','Owner','Stocks_Team');
const canWrite  = allowRoles('Admin','Owner');
const canQty    = allowRoles('Admin','Owner','Stocks_Team');

router.get('/',              auth, canView,  c.list);
router.post('/',             auth, canWrite, c.create);
router.put('/:id',           auth, canWrite, c.update);
router.patch('/:id/qty',     auth, canQty,   c.updateQty);
router.delete('/:id',        auth, canWrite, c.remove);
router.get('/:id/audit',     auth, canView,  c.auditHistory);

module.exports = router;
