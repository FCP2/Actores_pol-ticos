const router = require('express').Router();
const ctrl = require('../controllers/borradores.controller');
const { requireAuth, requireRole } = require('../middlewares/auth');

router.use(requireAuth, requireRole('capturista','analista','superadmin'));

router.get('/mios', ctrl.listMine);
router.get('/:id', ctrl.getOneMine);
router.post('/', ctrl.create);
router.put('/:id', ctrl.updateMine);
router.delete('/:id', ctrl.deleteMine);

module.exports = router;