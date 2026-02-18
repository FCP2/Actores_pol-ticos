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
       ORDER BY 
         CASE siglas 
           WHEN 'MORENA' THEN 1
           WHEN 'PRD' THEN 2  
           WHEN 'PAN' THEN 3
           WHEN 'PRI' THEN 4
           WHEN 'PVEM' THEN 5
           WHEN 'PT' THEN 6
           WHEN 'MC' THEN 7
           WHEN 'IND' THEN 8
           WHEN 'OTRO' THEN 9 
         END`
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
       ORDER BY 
         CASE 
           WHEN nombre = 'Otro' THEN 999
           ELSE id_tema 
         END`
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

exports.getRelacionesSentimentales = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT id_relacion_sentimental, nombre
      FROM catalogo_relacion_sentimental
      WHERE activo = true
      ORDER BY COALESCE(orden, 999), id_relacion_sentimental
      `
    );

    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al obtener relaciones sentimentales' });
  }
};

exports.getOrdenGobierno = async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id_orden, nombre
      FROM catalogo_orden_gobierno
      WHERE activo = true
      ORDER BY COALESCE(orden, 999), id_orden
    `);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al obtener orden de gobierno' });
  }
};

exports.getCargosEleccion = async (req, res) => {
  try {
    const idOrden = Number(req.query.id_orden || 0) || null;

    const { rows } = await pool.query(
      `
      SELECT id_cargo, id_orden, nombre
      FROM catalogo_cargo_eleccion
      WHERE activo = true
        AND ($1::int IS NULL OR id_orden = $1::int)
      ORDER BY COALESCE(orden, 999), id_cargo
      `,
      [idOrden]
    );

    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al obtener cargos de elección' });
  }
};
