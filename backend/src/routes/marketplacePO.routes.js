const router = require('express').Router();
const multer = require('multer');
const auth = require('../middleware/auth');
const { allowRoles, ALL_ROLES } = require('../middleware/rbac');
const c = require('../controllers/marketplacePO.controller');

// Accept PDF (most vendors) and Excel (Flipkart Minutes ships legacy binary
// .xls). Browsers report .xls inconsistently (often application/octet-stream),
// so gate on the extension as the primary signal.
const ACCEPTED_MIME = new Set([
  'application/pdf',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(pdf|xls|xlsx)$/i.test(file.originalname) || ACCEPTED_MIME.has(file.mimetype)) cb(null, true);
    else cb(new Error('Only PDF or Excel (.xls/.xlsx) files are accepted'));
  },
});

const guards = [auth, allowRoles(...ALL_ROLES)];

router.post('/parse', ...guards, upload.single('file'), c.parsePreview);
router.get('/',       ...guards, c.list);
router.get('/:poId',  ...guards, c.getOne);
router.post('/',      ...guards, c.create);
router.patch('/:poId',...guards, c.update);
router.delete('/:poId',...guards, c.remove);
router.post('/:poId/restore',...guards, c.restore);

module.exports = router;
