const router = require('express').Router();
const auth = require('../middleware/auth');
const { loginLimiter } = require('../middleware/rateLimit');
const { login, refresh, changePassword, logout, mfaEnroll, mfaVerify, mfaDisable } = require('../controllers/auth.controller');

router.post('/login', loginLimiter, login);
router.post('/refresh', refresh);
router.post('/change-password', auth, changePassword);
router.post('/logout', auth, logout);
router.post('/mfa/enroll', auth, mfaEnroll);
router.post('/mfa/verify', auth, mfaVerify);
router.post('/mfa/disable', auth, mfaDisable);

module.exports = router;
