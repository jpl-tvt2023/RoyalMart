const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles, ALL_ROLES, ADMIN_ROLES } = require('../middleware/rbac');
const cities  = require('../controllers/cities.controller');
const vendors = require('../controllers/vendors.controller');
const categories = require('../controllers/categories.controller');

const canView  = allowRoles(...ALL_ROLES);
const canAdmin = allowRoles(...ADMIN_ROLES);

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

// Vendors master
router.get('/vendors',        auth, canView,  vendors.list);
router.post('/vendors',       auth, canAdmin, vendors.create);
router.patch('/vendors/:id',  auth, canAdmin, vendors.update);
router.delete('/vendors/:id', auth, canAdmin, vendors.remove);

module.exports = router;
