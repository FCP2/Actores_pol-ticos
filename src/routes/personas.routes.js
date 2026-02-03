const router = require('express').Router();
const ctrl = require('../controllers/personas.controller');
const { requireAuth, requireRole } = require('../middlewares/auth');


router.get('/admin/usuarios', requireAuth, requireRole('superadmin'), ctrl.listUsuariosParaFiltro);
router.get('/admin/resumen-por-usuario', requireAuth, requireRole('superadmin'), ctrl.resumenPersonasPorUsuario);
router.get('/admin/grid', requireAuth, requireRole('superadmin'), ctrl.listPersonasAdminGrid);

router.post('/', requireAuth, requireRole('capturista','analista','superadmin'), ctrl.createPersonaCompleta);
router.get('/', requireAuth, requireRole('capturista','analista','superadmin'), ctrl.listPersonas);
router.get('/:id/perfil', requireAuth, requireRole('capturista','analista','superadmin'), ctrl.getPerfilCompleto);
router.get('/:id/pdf', requireAuth, requireRole('superadmin','analista','capturista'), ctrl.getPerfilPdf);


module.exports = router;
