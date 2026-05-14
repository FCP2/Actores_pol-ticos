const router = require('express').Router();
const ctrl = require('../controllers/personas.controller');
const reportesCtrl = require('../controllers/reportes.controller');
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

router.post('/analista/personas/:id/devolver-final',
  requireAuth,
  requireRole('analista', 'superadmin'),
  requireOffice,
  ctrl.devolverPersonaFinal
);

router.post('/analista/personas/observaciones/:idObservacion/atender',
  requireAuth,
  requireRole('capturista', 'analista', 'superadmin'),
  requireOffice,
  applySmartFilters,
  ctrl.atenderObservacionPersona
);

router.get('/analista/personas/:id/observaciones',
  requireAuth,
  requireRole('capturista', 'analista', 'superadmin'),
  requireOffice,
  applySmartFilters,
  ctrl.listObservacionesPersona
);

router.get('/dashboard/kpi/alertas',
  requireAuth,
  applySmartFilters,
  ctrl.kpiAlertasDashboard
);

router.get('/dashboard/notificaciones',
  requireAuth,
  applySmartFilters,
  ctrl.listNotificacionesDashboard
);

router.post('/dashboard/notificaciones/:idObservacion/leida',
  requireAuth,
  ctrl.marcarNotificacionLeida
);

router.get('/admin/resumen-por-usuario', requireAuth, requireRole('superadmin'), ctrl.resumenPersonasPorUsuario);

router.get("/admin/grid", [
  requireAuth, 
  requireRole('superadmin','analista'), 
  applySmartFilters,  // ← AGREGAR
  ctrl.listPersonasAdminGrid
]);

router.get(
  '/admin/grid/mapa-municipios',
  requireAuth,
  requireRole('analista', 'superadmin'),
  requireOffice,
  applySmartFilters,
  ctrl.listPersonasAdminGridMapaMunicipios
);

router.get(
  '/:id/municipios-trabajo',
  requireAuth,
  requireRole('analista', 'superadmin'),
  requireOffice,
  applySmartFilters,
  ctrl.getPersonaMunicipiosTrabajo
);

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



router.get('/admin/kpis/completitud', requireAuth, requireRole('superadmin','analista'), applySmartFilters, ctrl.kpiCompletitud);
router.get('/admin/kpis/municipios', requireAuth, requireRole('superadmin','analista'), applySmartFilters,  ctrl.kpiMunicipios);

router.get('/dashboard/kpi/verificacion', requireAuth, applySmartFilters, ctrl.kpiVerificacion);
router.get('/dashboard/kpi/oficinas', requireAuth, applySmartFilters, ctrl.kpiOficinas);

router.get(
  '/admin/kpis/resumen-ejecutivo',
  requireAuth,
  requireRole('superadmin','analista'),
  applySmartFilters,
  ctrl.kpiResumenEjecutivo
);

router.get('/reportes/ejecutivo',
  requireAuth,
  applySmartFilters,
  ctrl.reporteEjecutivo
);

router.get('/reportes/municipios',
  requireAuth,
  requireRole('superadmin'),
  reportesCtrl.reporteMunicipios
);

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
//buscar personas en index.html filtro 
router.get(
  '/',
  requireAuth,
  requireRole('capturista','analista','superadmin'),
  requireOffice,
  applySmartFilters,   // 👈 este es el clave
  ctrl.listPersonas
);

router.patch('/:id/oculto', requireAuth, requireRole('superadmin'), ctrl.toggleOcultoPersona);

router.get('/:id/perfil', requireAuth, requireRole('capturista', 'analista', 'superadmin'), ctrl.getPerfilCompleto);
router.get('/:id/pdf', requireAuth, requireRole('superadmin', 'analista', 'capturista'), ctrl.getPerfilPdf);






module.exports = router;
