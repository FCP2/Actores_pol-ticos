const router = require('express').Router();

router.use('/auth', require('./auth.routes'));
router.use('/personas', require('./personas.routes'));
router.use('/municipios', require('./municipios.routes'));
router.use('/catalogos', require('./catalogos.routes'));
router.use('/borradores', require('./borradores.routes'));

router.get('/ping', (req, res) => res.json({ ok: true }));

module.exports = router;