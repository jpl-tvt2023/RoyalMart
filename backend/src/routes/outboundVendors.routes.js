const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles, ALL_ROLES } = require('../middleware/rbac');
const outboundVendors = require('../controllers/outboundVendors.controller');

const canView  = allowRoles(...ALL_ROLES);
// Master data is editable by any logged-in user; every change is audited.
const canAdmin = allowRoles(...ALL_ROLES);

router.get('/',        auth, canView,  outboundVendors.list);
router.post('/',       auth, canAdmin, outboundVendors.create);
router.post('/bulk',   auth, canAdmin, outboundVendors.bulkUpsert);
router.patch('/:id',   auth, canAdmin, outboundVendors.update);
router.delete('/:id',  auth, canAdmin, outboundVendors.remove);

module.exports = router;
