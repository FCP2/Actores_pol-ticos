const router = require('express').Router();
const ctrl = require('../controllers/catalogos.controller');

router.get('/redes', ctrl.getRedes);
router.get('/controversias', ctrl.getControversias);
router.get('/partidos', ctrl.getPartidos);
router.get('/temas-interes', ctrl.getTemasInteres);
router.get('/grupos-postulacion', ctrl.getGruposPostulacion);
router.get('/ideologias', ctrl.getIdeologias);
router.get('/relacion-sentimental', ctrl.getRelacionesSentimentales);
router.get('/orden-gobierno', ctrl.getOrdenGobierno);
router.get('/cargos-eleccion', ctrl.getCargosEleccion); // acepta ?id_orden=#


module.exports = router;
