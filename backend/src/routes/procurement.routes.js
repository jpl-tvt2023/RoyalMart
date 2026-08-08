const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles, ALL_ROLES } = require('../middleware/rbac');
const c = require('../controllers/procurement.controller');

const canView  = allowRoles(...ALL_ROLES);
const canWrite = allowRoles(...ALL_ROLES);

router.get('/defaults',       auth, canView,  c.getDefaults);
router.get('/requirements',   auth, canView,  c.getRequirements);
router.get('/vendor-counts',  auth, canView,  c.getVendorCounts);
router.post('/mark-ordered',  auth, canWrite, c.markOrdered);
router.get('/batches',        auth, canView,  c.listBatches);
router.delete('/batches/:id', auth, canWrite, c.undoBatch);

router.get('/outbound/defaults',       auth, canView,  c.getOutboundDefaults);
router.get('/outbound/requirements',   auth, canView,  c.getOutboundRequirements);
router.post('/outbound/mark-ordered',  auth, canWrite, c.markPackagingOrdered);
router.get('/outbound/batches',        auth, canView,  c.listPackagingBatches);
router.delete('/outbound/batches/:id', auth, canWrite, c.undoPackagingBatch);

module.exports = router;
