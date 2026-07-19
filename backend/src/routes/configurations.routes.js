const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles, ALL_ROLES } = require('../middleware/rbac');
const cities  = require('../controllers/cities.controller');
const vendors = require('../controllers/vendors.controller');
const categories = require('../controllers/categories.controller');
const companies = require('../controllers/companies.controller');

const canView  = allowRoles(...ALL_ROLES);
// Master data is editable by any logged-in user; every change is audited.
const canAdmin = allowRoles(...ALL_ROLES);

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
router.get('/companies',        auth, canView,  companies.list);
router.post('/companies',       auth, canAdmin, companies.create);
router.patch('/companies/:id',  auth, canAdmin, companies.update);
router.delete('/companies/:id', auth, canAdmin, companies.remove);

// Vendors master
router.get('/vendors',        auth, canView,  vendors.list);
router.post('/vendors',       auth, canAdmin, vendors.create);
router.patch('/vendors/:id',  auth, canAdmin, vendors.update);
router.delete('/vendors/:id', auth, canAdmin, vendors.remove);

module.exports = router;
