const router = require('express').Router();
const ctrl = require('../controllers/municipios.controller');

router.get('/', ctrl.getMunicipios);

module.exports = router;