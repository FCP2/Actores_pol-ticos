const pool = require('../db'); // ajusta si tu pool está en otra ruta

exports.getRedes = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id_red, nombre FROM catalogo_redes_sociales ORDER BY id_red'
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al obtener redes' });
  }
};

exports.getControversias = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id_tipo, tipo FROM catalogo_controversias ORDER BY id_tipo'
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al obtener controversias' });
  }
};

exports.getPartidos = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id_partido, nombre, siglas
       FROM catalogo_partidos
       WHERE activo = true
       ORDER BY nombre`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al obtener partidos' });
  }
};

exports.getTemasInteres = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id_tema, nombre, requiere_otro_texto
       FROM catalogo_temas_interes
       WHERE activo = true
       ORDER BY id_tema`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al obtener temas de interés' });
  }
};

exports.getGruposPostulacion = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id_grupo, nombre
       FROM catalogo_grupos_postulacion
       WHERE activo = true
       ORDER BY id_grupo`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al obtener grupos de postulación' });
  }
};

exports.getIdeologias = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id_ideologia, nombre
       FROM catalogo_ideologia_politica
       WHERE activo = true
       ORDER BY id_ideologia`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al obtener ideologías' });
  }
};