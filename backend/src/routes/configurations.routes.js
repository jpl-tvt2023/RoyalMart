const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles, ALL_ROLES, ADMIN_ROLES } = require('../middleware/rbac');
const cities  = require('../controllers/cities.controller');
const vendors = require('../controllers/vendors.controller');
const categories = require('../controllers/categories.controller');
const companies = require('../controllers/companies.controller');
const outboundProducts = require('../controllers/outboundProducts.controller');
const stitchingPrefixes = require('../controllers/stitchingPrefixes.controller');
const stitchingParties = require('../controllers/stitchingParties.controller');
const warehouses = require('../controllers/warehouses.controller');
const floors = require('../controllers/floors.controller');
const barcodeStationSettings = require('../controllers/barcodeStationSettings.controller');

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

// Stitching incoming-number prefixes — each declares the stage a lot was
// received at, which is what routes it to a tab on the Stitching page. Also on
// Admin -> Purchase Config, so writes are Admin/Owner only. The GET stays open:
// the outbound PO receipt row and the Stitching forward form both need it for
// their prefix dropdowns.
router.get('/stitching-prefixes',        auth, canView,      stitchingPrefixes.list);
router.post('/stitching-prefixes',       auth, canAdminOnly, stitchingPrefixes.create);
router.patch('/stitching-prefixes/:id',  auth, canAdminOnly, stitchingPrefixes.update);
router.delete('/stitching-prefixes/:id', auth, canAdminOnly, stitchingPrefixes.remove);

// Warehouses (096) — our own stock locations, each a tab on the Stitching page
// and a place goods can be sent or booked into. Admin -> Purchase Config, so
// writes are Admin/Owner only. The GET stays open: the Stitching page builds its
// tabs from it, and the challan and receipt forms their warehouse choices.
router.get('/warehouses',        auth, canView,      warehouses.list);
router.post('/warehouses',       auth, canAdminOnly, warehouses.create);
router.patch('/warehouses/:id',  auth, canAdminOnly, warehouses.update);
router.delete('/warehouses/:id', auth, canAdminOnly, warehouses.remove);

// Stitching parties — the processing houses material is sent to, and the buyers
// finished goods are sold to. Each carries the destinations it may serve, which
// is what narrows the challan form's party dropdown to parties that can actually
// do that job. Admin -> Purchase Config, so writes are Admin/Owner only. The GET
// stays open for the same reason the prefixes one does: the Stitching challan
// form needs it on every dispatch.
router.get('/stitching-parties',        auth, canView,      stitchingParties.list);
router.post('/stitching-parties',       auth, canAdminOnly, stitchingParties.create);
router.patch('/stitching-parties/:id',  auth, canAdminOnly, stitchingParties.update);
router.delete('/stitching-parties/:id', auth, canAdminOnly, stitchingParties.remove);

// Floors (098) -- where a Barcode Station batch is stored, printed on its
// stickers. Deliberately separate from warehouses. Admin -> Purchase Config,
// so writes are Admin/Owner only.
router.get('/floors',        auth, canView,      floors.list);
router.post('/floors',       auth, canAdminOnly, floors.create);
router.patch('/floors/:id',  auth, canAdminOnly, floors.update);
router.delete('/floors/:id', auth, canAdminOnly, floors.remove);

// Barcode Station settings (098) -- the shared PIN, sign-in lock and sticker
// size. Admin/Owner only, reads included: nothing here is for anyone else.
router.get('/barcode-station', auth, canAdminOnly, barcodeStationSettings.get);
router.put('/barcode-station', auth, canAdminOnly, barcodeStationSettings.update);

// Vendors master
router.get('/vendors',       auth, canView,  vendors.list);
router.post('/vendors',       auth, canAdmin, vendors.create);
router.patch('/vendors/:id',  auth, canAdmin, vendors.update);
router.delete('/vendors/:id', auth, canAdmin, vendors.remove);

module.exports = router;
