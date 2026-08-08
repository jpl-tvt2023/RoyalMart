const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles, ALL_ROLES } = require('../middleware/rbac');
const outboundPOs = require('../controllers/outboundPOs.controller');

const canView  = allowRoles(...ALL_ROLES);
// Outbound POs are editable by any logged-in user; every change is audited.
const canAdmin = allowRoles(...ALL_ROLES);

router.get('/',                 auth, canView,  outboundPOs.list);
router.get('/item-name-counts', auth, canView,  outboundPOs.getItemNameCounts);
router.get('/:id',              auth, canView,  outboundPOs.getOne);
router.post('/',                auth, canAdmin, outboundPOs.create);
router.patch('/:id',            auth, canAdmin, outboundPOs.update);
router.delete('/:id',           auth, canAdmin, outboundPOs.remove);
router.post('/:id/restore',     auth, canAdmin, outboundPOs.restore);

router.patch('/:id/lines/:lineId',                            auth, canAdmin, outboundPOs.updateLineShort);
router.post('/:id/lines/:lineId/receipts',                    auth, canAdmin, outboundPOs.createReceipt);
router.patch('/:id/lines/:lineId/receipts/:receiptId',        auth, canAdmin, outboundPOs.updateReceipt);
router.delete('/:id/lines/:lineId/receipts/:receiptId',       auth, canAdmin, outboundPOs.deleteReceipt);
router.post('/:id/lines/:lineId/receipts/:receiptId/restore', auth, canAdmin, outboundPOs.restoreReceipt);

module.exports = router;
