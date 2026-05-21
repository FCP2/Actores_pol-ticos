const router = require('express').Router();
const ctrl = require('../controllers/analista.controller');
const { requireAuth, requireRole, requireOffice } = require('../middlewares/auth');
const { applySmartFilters } = require('../middlewares/smartFilter'); // .js!

router.get('/municipios/cobertura', requireAuth, requireRole('analista','superadmin'), requireOffice, applySmartFilters, ctrl.coberturaMunicipios);
router.get('/municipios/capas',    requireAuth, requireRole('analista','superadmin'), requireOffice, applySmartFilters, ctrl.capasMapaMunicipios);
router.get('/personas',            requireAuth, requireRole('analista','superadmin'), requireOffice, ctrl.personasPorMunicipio);

module.exports = router;
