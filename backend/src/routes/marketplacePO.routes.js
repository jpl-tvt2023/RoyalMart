const router = require('express').Router();
const multer = require('multer');
const auth = require('../middleware/auth');
const { allowRoles } = require('../middleware/rbac');
const c = require('../controllers/marketplacePO.controller');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Only PDF files are accepted'));
  },
});

const guards = [auth, allowRoles('PO_Executive', 'Admin', 'Owner')];

router.post('/parse', ...guards, upload.single('file'), c.parsePreview);
router.get('/',       ...guards, c.list);
router.get('/:poId',  ...guards, c.getOne);
router.post('/',      ...guards, c.create);
router.patch('/:poId',...guards, c.update);
router.delete('/:poId',...guards, c.remove);

module.exports = router;
