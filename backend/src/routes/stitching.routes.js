const router = require('express').Router();
const auth = require('../middleware/auth');
const { allowRoles, ALL_ROLES } = require('../middleware/rbac');
const stitching = require('../controllers/stitching.controller');

// Same access posture as outbound POs: every logged-in user can read and write,
// and every change is audited. The prefix master that feeds this page is the
// Admin-only part, and it lives on /api/configurations/stitching-prefixes.
const canView = allowRoles(...ALL_ROLES);
const canEdit = allowRoles(...ALL_ROLES);

router.get('/', auth, canView, stitching.list);
router.get('/parties', auth, canView, stitching.listParties);
router.get('/stage-counts', auth, canView, stitching.stageCounts);
router.get('/journey/:src/:id', auth, canView, stitching.journey);
router.post('/', auth, canEdit, stitching.create);

// Material that leaves a lot without arriving anywhere. A literal path segment,
// so it is matched before any '/:id' route rather than being read as an id.
router.post('/write-off', auth, canEdit, stitching.writeOff);

// Close/reopen take the lot TYPE as well as the id: a lot reaches Packed either
// forwarded through the chain (an entry) or bought straight at that stage (a
// receipt), and the two live in different tables. Three segments, so there is no
// clash with the two-segment /:id/restore below.
router.post('/:src/:id/close', auth, canEdit, stitching.close);
router.post('/:src/:id/reopen', auth, canEdit, stitching.reopen);

// Withdrawing a challan or a write-off that should not exist -- a correction,
// not a movement. One segment: only these can be withdrawn, and both are
// stitching_entries rows, so the id needs no lot type beside it.
router.post('/:id/remove', auth, canEdit, stitching.removeChallan);

router.patch('/:id', auth, canEdit, stitching.update);
router.delete('/:id', auth, canEdit, stitching.remove);
router.post('/:id/restore', auth, canEdit, stitching.restore);

module.exports = router;
