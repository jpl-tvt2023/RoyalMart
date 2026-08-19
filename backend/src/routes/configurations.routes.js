const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles, ALL_ROLES, ADMIN_ROLES } = require('../middleware/rbac');
const cities  = require('../controllers/cities.controller');
const vendors = require('../controllers/vendors.controller');
const categories = require('../controllers/categories.controller');
const companies = require('../controllers/companies.controller');
const outboundProducts = require('../controllers/outboundProducts.controller');

const canView  = allowRoles(...ALL_ROLES);
// Master data is editable by any logged-in user; every change is audited.
const canAdmin = allowRoles(...ALL_ROLES);
// The two masters that live on Admin -> Purchase Config (companies and the
// outbound product list) are managed by Admin/Owner only. Their GETs stay open
// to ALL_ROLES: Outbound PO creation reads the company list for its dropdown,
// and Packaging Items reads the outbound product list for its pickers.
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

// Companies master
router.get('/companies',        auth, canView,      companies.list);
router.post('/companies',       auth, canAdminOnly, companies.create);
router.patch('/companies/:id',  auth, canAdminOnly, companies.update);
router.delete('/companies/:id', auth, canAdminOnly, companies.remove);

// Outbound Product List master — the Category / Item Name / Unit Metric
// taxonomy that packaging product onboarding validates against. Editing it
// reshapes every downstream catalog, so writes are Admin/Owner only.
router.get('/outbound-products',        auth, canView,      outboundProducts.list);
router.post('/outbound-products',       auth, canAdminOnly, outboundProducts.create);
router.patch('/outbound-products/:id',  auth, canAdminOnly, outboundProducts.update);
router.delete('/outbound-products/:id', auth, canAdminOnly, outboundProducts.remove);

// Vendors master
router.get('/vendors',        auth, canView,  vendors.list);
router.post('/vendors',       auth, canAdmin, vendors.create);
router.patch('/vendors/:id',  auth, canAdmin, vendors.update);
router.delete('/vendors/:id', auth, canAdmin, vendors.remove);

module.exports = router;
