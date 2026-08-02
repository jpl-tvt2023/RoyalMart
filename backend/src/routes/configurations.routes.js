const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles, ALL_ROLES, ADMIN_ROLES } = require('../middleware/rbac');
const cities  = require('../controllers/cities.controller');
const vendors = require('../controllers/vendors.controller');
const categories = require('../controllers/categories.controller');
const companies = require('../controllers/companies.controller');
const outboundCategories = require('../controllers/outboundCategories.controller');

const canView  = allowRoles(...ALL_ROLES);
// Master data is editable by any logged-in user; every change is audited.
const canAdmin = allowRoles(...ALL_ROLES);
// Companies (Global Config) is managed by Admin/Owner only. GET stays open to
// ALL_ROLES since Outbound PO creation (open to all roles) reads the company
// list for its dropdown.
const canAdminOnly = allowRoles(...ADMIN_ROLES);

// Cities master
router.get('/cities',         auth, canView,  cities.list);
router.post('/cities',        auth, canAdmin, cities.create);
router.patch('/cities/:id',   auth, canAdmin, cities.update);
router.delete('/cities/:id',  auth, canAdmin, cities.remove);

// Categories master
router.get('/categories',         auth, canView,  categories.list);
router.post('/categories',        auth, canAdmin, categories.create);
router.patch('/categories/:id',   auth, canAdmin, categories.update);
router.delete('/categories/:id',  auth, canAdmin, categories.remove);

// Outbound Categories master
router.get('/outbound-categories',        auth, canView,  outboundCategories.list);
router.post('/outbound-categories',       auth, canAdmin, outboundCategories.create);
router.patch('/outbound-categories/:id',  auth, canAdmin, outboundCategories.update);
router.delete('/outbound-categories/:id', auth, canAdmin, outboundCategories.remove);

// Companies master
router.get('/companies',        auth, canView,      companies.list);
router.post('/companies',       auth, canAdminOnly, companies.create);
router.patch('/companies/:id',  auth, canAdminOnly, companies.update);
router.delete('/companies/:id', auth, canAdminOnly, companies.remove);

// Vendors master
router.get('/vendors',        auth, canView,  vendors.list);
router.post('/vendors',       auth, canAdmin, vendors.create);
router.patch('/vendors/:id',  auth, canAdmin, vendors.update);
router.delete('/vendors/:id', auth, canAdmin, vendors.remove);

module.exports = router;
