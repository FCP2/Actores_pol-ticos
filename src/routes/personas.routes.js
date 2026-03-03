const router = require('express').Router();
const ctrl = require('../controllers/personas.controller');
const { requireAuth, requireRole, requireOffice } = require('../middlewares/auth');
const { applySmartFilters } = require('../middlewares/smartFilter'); // .js!

router.post('/analista/personas/:id/verificar',
  requireAuth,
  requireRole('analista', 'superadmin'),
  requireOffice,
  ctrl.verificarPersona
);

router.post('/analista/personas/:id/desverificar',
  requireAuth,
  requireRole('analista', 'superadmin'),
  requireOffice,
  ctrl.desverificarPersona
);

router.get('/admin/resumen-por-usuario', requireAuth, requireRole('superadmin'), ctrl.resumenPersonasPorUsuario);

router.get("/admin/grid", [
  requireAuth, 
  requireRole('superadmin','analista'), 
  applySmartFilters,  // ← AGREGAR
  ctrl.listPersonasAdminGrid
]);

router.get("/admin/cards", requireAuth, requireRole('superadmin','analista'), applySmartFilters, ctrl.getAdminCards);
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

router.get('/admin/kpis/completitud', requireAuth, requireRole('superadmin','analista'), ctrl.kpiCompletitud);
router.get('/admin/kpis/municipios', requireAuth, requireRole('superadmin','analista'), ctrl.kpiMunicipios);

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
