const router = require('express').Router();
const auth = require('../middleware/auth');
const { login, refresh, changePassword, logout } = require('../controllers/auth.controller');

router.post('/login', login);
router.post('/refresh', refresh);
router.post('/change-password', auth, changePassword);
router.post('/logout', auth, logout);

module.exports = router;
