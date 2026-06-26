const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles, ALL_ROLES } = require('../middleware/rbac');
const c = require('../controllers/orderSummary.controller');

const canView  = allowRoles(...ALL_ROLES);
const canWrite = allowRoles(...ALL_ROLES);

router.get('/',                   auth, canView,  c.list);
router.get('/counts-by-vendor',   auth, canView,  c.countsByVendor);
router.get('/counts-by-poc',      auth, canView,  c.countsByPoc);
router.get('/grn-appointments',   auth, canView,  c.grnAppointments);
router.get('/grn-appointment-counts', auth, canView, c.grnAppointmentCounts);
router.get('/poc-users',          auth, canView,  c.pocUsers);
router.patch('/bulk',             auth, canWrite, c.bulkUpdate);
router.patch('/:poId',            auth, canWrite, c.updateOne);

module.exports = router;
