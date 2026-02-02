const router = require('express').Router();
const ctrl = require('../controllers/catalogos.controller');

router.get('/redes', ctrl.getRedes);
router.get('/controversias', ctrl.getControversias);
router.get('/partidos', ctrl.getPartidos);
router.get('/temas-interes', ctrl.getTemasInteres);
router.get('/grupos-postulacion', ctrl.getGruposPostulacion);
router.get('/ideologias', ctrl.getIdeologias);

module.exports = router;