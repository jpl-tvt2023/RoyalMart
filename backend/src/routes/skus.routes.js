const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles } = require('../middleware/rbac');
const c = require('../controllers/skus.controller');

const allAuth = allowRoles('Admin','Owner','Office_POC','Purchase_Team','Stocks_Team');
const canWrite = allowRoles('Admin','Owner');

router.get('/',       auth, allAuth, c.list);
router.post('/',      auth, canWrite, c.create);
router.put('/:id',    auth, canWrite, c.update);
router.delete('/:id', auth, allowRoles('Admin'), c.remove);

module.exports = router;
