const router = require('express').Router();
const ctrl = require('../controllers/personas.controller');
const { requireAuth, requireRole, requireOffice } = require('../middlewares/auth');

router.get('/admin/resumen-por-usuario', requireAuth, requireRole('superadmin'), ctrl.resumenPersonasPorUsuario);
router.get("/admin/grid", requireAuth, requireRole('superadmin','analista'), ctrl.listPersonasAdminGrid);
router.get("/admin/cards", requireAuth, requireRole('superadmin','analista'), ctrl.getAdminCards);
router.get(
  '/admin/oficinas',
  requireAuth,
  requireRole('superadmin', 'analista'),
  ctrl.listOficinas
);

router.get(
  '/admin/capturistas',
  requireAuth,
  requireRole('superadmin', 'analista'),
  ctrl.listCapturistasByOficina
);

router.get('/admin/kpis/completitud', requireAuth, requireRole('superadmin'), ctrl.kpiCompletitud);
router.get('/admin/kpis/municipios', requireAuth, requireRole('superadmin'), ctrl.kpiMunicipios);

router.post(
  '/',
  requireAuth,
  requireRole('capturista', 'analista', 'superadmin'),
  requireOffice,
  ctrl.createPersonaCompleta
);

router.get(
  "/check-duplicado",
  requireAuth,
  requireRole("capturista","analista","superadmin"),
  ctrl.checkDuplicado
);

router.put('/:id', requireAuth, requireRole('capturista','analista','superadmin'), requireOffice, ctrl.updatePersonaCompleta);
router.get('/:id/payload', requireAuth, requireRole('capturista','analista','superadmin'), requireOffice, ctrl.getPayloadEdicion);
router.delete('/:id', requireAuth, requireRole('capturista','analista','superadmin'), requireOffice, ctrl.deletePersona);

router.get('/', requireAuth, requireRole('capturista', 'analista', 'superadmin'), ctrl.listPersonas);
router.get('/:id/perfil', requireAuth, requireRole('capturista', 'analista', 'superadmin'), ctrl.getPerfilCompleto);
router.get('/:id/pdf', requireAuth, requireRole('superadmin', 'analista', 'capturista'), ctrl.getPerfilPdf);






module.exports = router;
