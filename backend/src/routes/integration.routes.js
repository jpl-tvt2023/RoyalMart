const router = require('express').Router();
const serviceAuth = require('../middleware/serviceAuth');
const c = require('../controllers/integration.controller');

// RAMS only (Tally -> RAMS -> ROMS). A bearer INTEGRATION_TOKEN, not a user
// login: serviceAuth runs every request as the tally-sync system user, so no
// allowRoles here -- the token is the whole gate.
router.get('/refs/:resource', serviceAuth, c.refs);
router.post('/autofill', serviceAuth, c.autofill);

module.exports = router;
