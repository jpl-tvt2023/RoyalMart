const router = require('express').Router();
const auth = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');
const { login, refresh, changePassword, logout, mfaEnroll, mfaVerify, mfaDisable } = require('../controllers/auth.controller');

router.post('/login', authLimiter, login);
router.post('/refresh', authLimiter, refresh);
router.post('/change-password', auth, changePassword);
router.post('/logout', auth, logout);
router.post('/mfa/enroll', auth, mfaEnroll);
router.post('/mfa/verify', auth, mfaVerify);
router.post('/mfa/disable', auth, mfaDisable);

module.exports = router;
