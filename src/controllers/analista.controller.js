const pool = require('../db');
//cobertura por municipio (solo su oficina) analista
exports.coberturaMunicipios = async (req, res) => {
  const client = await pool.connect();
  try {
    const roles = req.user?.roles || [];
    const isSuperadmin = roles.includes("superadmin");
    const isAnalista   = roles.includes("analista");

    if (!isSuperadmin && !isAnalista) {
      return res.status(403).json({ error: "Prohibido" });
    }

    // ✅ usa smartFilters para que cuente EXACTAMENTE lo que el usuario puede ver
    const { addFullFilter } = req.smartFilters;
    const params = [];
    const where = [];
    addFullFilter(params, where);

    // ✅ opcional: si superadmin manda oficinaId, se aplica como filtro adicional
    const oficinaId = req.query.oficinaId ? Number(req.query.oficinaId) : null;
    if (isSuperadmin && oficinaId) {
      params.push(oficinaId);
      where.push(`p.id_oficina = $${params.length}`);
    }

    // municipio obligatorio
    where.push(`p.municipio_trabajo_politico IS NOT NULL`);

    const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const { rows } = await client.query(
      `
      SELECT
        p.municipio_trabajo_politico AS id_municipio,
        m.nombre AS municipio,
        COUNT(*)::int AS total,
        COUNT(p.verificado_at)::int AS verificados,
        (COUNT(*) - COUNT(p.verificado_at))::int AS pendientes
      FROM personas p
      LEFT JOIN municipios m ON m.id_municipio = p.municipio_trabajo_politico
      ${whereSQL}
      GROUP BY p.municipio_trabajo_politico, m.nombre
      ORDER BY m.nombre ASC
      `,
      params
    );

    return res.json({ ok: true, data: rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Error cobertura municipios", detail: e.message });
  } finally {
    client.release();
  }
};

//Endpoint: personas por municipio (solo su oficina) analista

exports.personasPorMunicipio = async (req, res) => {
  const client = await pool.connect();
  try {
    const roles = req.user?.roles || [];
    const isSuperadmin = roles.includes('superadmin');
    const isAnalista = roles.includes('analista');
    if (!isSuperadmin && !isAnalista) return res.status(403).json({ error: 'Prohibido' });

    const oficinaId = isSuperadmin
      ? (req.query.oficinaId ? Number(req.query.oficinaId) : null)
      : Number(req.user.id_oficina || 0);

    if (!oficinaId) return res.status(403).json({ error: 'Usuario sin oficina asignada' });

    const idMun = Number(req.query.municipio || 0);
    if (!idMun) return res.status(400).json({ error: 'municipio es obligatorio' });

    const ver = (req.query.verificado === "1" || req.query.verificado === "0") ? req.query.verificado : "all";
    const q = (req.query.search || "").trim();

    const params = [oficinaId, idMun];
    const where = [`p.id_oficina = $1`, `p.municipio_trabajo_politico = $2`];

    if (!isSuperadmin) where.push(`p.oculto = false`);

    if (ver === "1") where.push(`p.verificado_at IS NOT NULL`);
    if (ver === "0") where.push(`p.verificado_at IS NULL`);

    if (q) {
      params.push(`%${q}%`);
      const i = params.length;
      where.push(`(
        COALESCE(p.nombre,'') ILIKE $${i}
        OR COALESCE(p.apellido_paterno,'') ILIKE $${i}
        OR COALESCE(p.apellido_materno,'') ILIKE $${i}
        OR COALESCE(p.curp,'') ILIKE $${i}
      )`);
    }

    const { rows } = await client.query(
      `
      SELECT
        p.id_persona,
        (p.nombre || ' ' || COALESCE(p.apellido_paterno,'') || ' ' || COALESCE(p.apellido_materno,'')) AS nombre_completo,
        p.verificado_at,
        p.created_at,
        p.updated_at
      FROM personas p
      WHERE ${where.join(" AND ")}
      ORDER BY p.updated_at DESC, p.id_persona DESC
      LIMIT 500
      `,
      params
    );

    res.json({ ok: true, data: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error personas por municipio', detail: e.message });
  } finally {
    client.release();
  }
};
