const pool = require('../db'); // ajusta si tu pool está en otra ruta



exports.getMunicipios = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id_municipio, nombre FROM municipios ORDER BY nombre'
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al obtener municipios' });
  }
};
