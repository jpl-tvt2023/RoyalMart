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
router.post('/', auth, canEdit, stitching.create);
router.patch('/:id', auth, canEdit, stitching.update);
router.delete('/:id', auth, canEdit, stitching.remove);
router.post('/:id/restore', auth, canEdit, stitching.restore);

module.exports = router;
