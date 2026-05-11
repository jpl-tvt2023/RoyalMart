const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles } = require('../middleware/rbac');
const cities  = require('../controllers/cities.controller');
const vendors = require('../controllers/vendors.controller');

const canView  = allowRoles('Admin','Owner','Office_POC','Warehouse_POC','Purchase_Team','PO_Executive');
const canAdmin = allowRoles('Admin','Owner');

// Cities master
router.get('/cities',         auth, canView,  cities.list);
router.post('/cities',        auth, canAdmin, cities.create);
router.patch('/cities/:id',   auth, canAdmin, cities.update);
router.delete('/cities/:id',  auth, canAdmin, cities.remove);

// Vendors master
router.get('/vendors',        auth, canView,  vendors.list);
router.post('/vendors',       auth, canAdmin, vendors.create);
router.patch('/vendors/:id',  auth, canAdmin, vendors.update);
router.delete('/vendors/:id', auth, canAdmin, vendors.remove);

module.exports = router;
