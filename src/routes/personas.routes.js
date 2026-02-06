const router = require('express').Router();
const ctrl = require('../controllers/personas.controller');
const { requireAuth, requireRole, requireOffice } = require('../middlewares/auth');

router.get('/admin/usuarios', requireAuth, requireRole('superadmin'), ctrl.listUsuariosParaFiltro);
router.get('/admin/resumen-por-usuario', requireAuth, requireRole('superadmin'), ctrl.resumenPersonasPorUsuario);
router.get('/admin/grid', requireAuth, requireRole('superadmin'), ctrl.listPersonasAdminGrid);

router.post(
  '/',
  requireAuth,
  requireRole('capturista', 'analista', 'superadmin'),
  requireOffice,
  ctrl.createPersonaCompleta
);

router.put('/:id', requireAuth, requireRole('capturista','analista','superadmin'), requireOffice, ctrl.updatePersonaCompleta);
router.get('/:id/payload', requireAuth, requireRole('capturista','analista','superadmin'), requireOffice, ctrl.getPayloadEdicion);
router.delete('/:id', requireAuth, requireRole('capturista','analista','superadmin'), requireOffice, ctrl.deletePersona);

router.get('/', requireAuth, requireRole('capturista', 'analista', 'superadmin'), ctrl.listPersonas);
router.get('/:id/perfil', requireAuth, requireRole('capturista', 'analista', 'superadmin'), ctrl.getPerfilCompleto);
router.get('/:id/pdf', requireAuth, requireRole('superadmin', 'analista', 'capturista'), ctrl.getPerfilPdf);

router.get('/admin/kpis/completitud', requireAuth, requireRole('superadmin'), ctrl.kpiCompletitud);
router.get('/admin/kpis/municipios', requireAuth, requireRole('superadmin'), ctrl.kpiMunicipios);

router.get(
  "/check-duplicado",
  requireAuth,
  requireRole("capturista","analista","superadmin"),
  ctrl.checkDuplicado
);




module.exports = router;
