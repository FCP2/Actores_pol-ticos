const pool = require('../db');
function normalizePeriodo(str) {
  return (str || "").toString().replace(/\s+/g, "").trim(); // "2015 - 2025" => "2015-2025"
}

function isPeriodoValido(p) {
  if (!p) return true; // null permitido
  if (!/^(\d{4}|\d{4}-\d{4})$/.test(p)) return false;

  const m = p.match(/^(\d{4})-(\d{4})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (b < a) return false;
  }
  return true;
}

  async function assertCanMutatePersona(client, req, id_persona) {
    const roles = req.user?.roles || [];
    const isSuperadmin = roles.includes("superadmin");
    const isAnalista   = roles.includes("analista");
    const isCapturista = roles.includes("capturista");

    const { rows } = await client.query(
      `SELECT id_persona, id_oficina, creado_por FROM personas WHERE id_persona = $1`,
      [id_persona]
    );

    if (!rows.length) {
      const err = new Error("Persona no encontrada");
      err.status = 404;
      throw err;
    }

    const p = rows[0];
    if (isSuperadmin) return p;

    // capturista puro: solo los suyos
    if (isCapturista && !isAnalista) {
      if (Number(p.creado_por) !== Number(req.user.id_usuario)) {
        const err = new Error("No autorizado");
        err.status = 403;
        throw err;
      }
      return p;
    }

    // analista (y no-superadmin): solo su oficina
    if (!req.user?.id_oficina) {
      const err = new Error("Usuario sin oficina asignada");
      err.status = 403;
      throw err;
    }

    if (Number(p.id_oficina) !== Number(req.user.id_oficina)) {
      const err = new Error("No autorizado");
      err.status = 403;
      throw err;
    }

    return p;
  }



  function isSuperadmin(req) {
    return (req.user?.roles || []).includes('superadmin');
  }
  function isAnalista(req) {
    return (req.user?.roles || []).includes('analista');
  }
  function isCapturista(req) {
    return (req.user?.roles || []).includes('capturista');
  }

  function canEditDelete(req, personaRow) {
    if (!personaRow) return false;

    if (isSuperadmin(req)) return true;

    // analista: misma oficina
    if (isAnalista(req)) {
      return req.user?.id_oficina && personaRow.id_oficina === req.user.id_oficina;
    }

    // capturista: misma oficina + creado_por
    if (isCapturista(req)) {
      return req.user?.id_oficina
        && personaRow.id_oficina === req.user.id_oficina
        && personaRow.creado_por === req.user.id_usuario;
    }

    return false;
  }

// 1) LISTA (para mapa o tablas)
// /api/personas?municipio_trabajo=34
// /api/personas?search=juan&limit=30
exports.listPersonas = async (req, res) => {
  const client = await pool.connect();
  try {
    const { municipio_trabajo, search } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit || "100", 10), 1), 500);

    const params = [];
    const where = [];

    // ✅ NUEVO: aplicar SMART FILTERS (scope/area/oficina/self/all)
    // (esto reemplaza la lógica manual por roles)
    const { addFullFilter } = req.smartFilters;
    addFullFilter(params, where);

    // filtro municipio trabajo (para tu dashboard/mapa)
    const idMun = Number(municipio_trabajo);
    if (Number.isFinite(idMun) && idMun > 0) {
      params.push(idMun);
      where.push(`p.municipio_trabajo_politico = $${params.length}`);
    }

    // búsqueda (panel edición)
    const q = (search || "").trim();
    if (q) {
      params.push(`%${q}%`);
      const i = params.length;
      where.push(`
        (
          COALESCE(p.nombre,'') ILIKE $${i}
          OR COALESCE(p.apellido_paterno,'') ILIKE $${i}
          OR COALESCE(p.apellido_materno,'') ILIKE $${i}
          OR COALESCE(p.curp,'') ILIKE $${i}
          OR COALESCE(p.rfc,'') ILIKE $${i}
          OR COALESCE(p.clave_elector,'') ILIKE $${i}
        )
      `);
    }

    const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // limit al final
    params.push(limit);

    const { rows } = await client.query(
      `
      SELECT
        p.id_persona,
        p.nombre,
        p.apellido_paterno,
        p.apellido_materno,
        p.escala_influencia,
        p.created_at,
        p.id_oficina,
        p.creado_por
      FROM personas p
      ${sqlWhere}
      ORDER BY p.id_persona DESC
      LIMIT $${params.length}
      `,
      params
    );

    return res.json(rows);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Error al listar personas", detail: e.message });
  } finally {
    client.release();
  }
};


//1.1. listar personas usuarios
exports.listPersonasAdminGrid = async (req, res) => {
  const client = await pool.connect();
  try {
    // -------- paginación
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const size = Math.min(Math.max(parseInt(req.query.size || "25", 10), 1), 200);
    const offset = (page - 1) * size;

    // -------- filtros

    let oficinaId = req.query.oficinaId ? Number(req.query.oficinaId) : null;
    const capturistaId = req.query.capturistaId ? Number(req.query.capturistaId) : null;
    const idMunTrabajo = req.query.municipio_trabajo ? Number(req.query.municipio_trabajo) : null;
    const partidoIdRaw = String(req.query.partidoId || "").trim();
    const confiabilidad = (req.query.confiabilidad || "").trim().toLowerCase();
    const liderazgo = (req.query.liderazgo || "").trim().toLowerCase();
    const controversias =
    (req.query.controversias === "1" || req.query.controversias === "0")
      ? req.query.controversias
      : null;
    const referente = (req.query.referente || "").trim();
    const referenteCargo = (req.query.referenteCargo || "").trim();
    const refNivelRaw = (req.query.refNivel || "").trim().toLowerCase();
    const refNivel = ["municipal", "regional", "distrital", "estatal", "nacional"].includes(refNivelRaw)
      ? refNivelRaw
      : "";

    const fechaDesde = String(req.query.fechaDesde || "").trim();
    const fechaHasta = String(req.query.fechaHasta || "").trim();
      
    //filtro un municipio de trabajpo político y mas de un municipio de trabajo politico
    const q = (req.query.q || "").trim();
    const multiplesMunicipios =
      (req.query.multiples_municipios === "1" || req.query.multiples_municipios === "0")
        ? req.query.multiples_municipios
        : null;

    // 👇 este filtro lo dejamos como “FINAL” (superadmin)
    const verificado = (req.query.verificado === "1" || req.query.verificado === "0")
      ? req.query.verificado
      : null;
    //filtro verificado, por area, office o all
    const verifLevel = String(req.query.verifLevel || "").trim().toLowerCase();

    // -------- ordenamiento
    const sortDir = (String(req.query.sortDir || "desc").toLowerCase() === "asc") ? "ASC" : "DESC";
    const sortFieldRaw = String(req.query.sortField || "updated_at").trim();
    const SORT_WHITELIST = new Set([
      "id_persona",
      "created_at",
      "updated_at",
      "nombre",
      "apellido_paterno",
      "apellido_materno"
    ]);
    const sortField = SORT_WHITELIST.has(sortFieldRaw) ? sortFieldRaw : "updated_at";

    // -------- SMART FILTERS
    const { addFullFilter } = req.smartFilters;
    const params = [];
    const where = [];
    addFullFilter(params, where);

    // -------- filtros manuales
    if (oficinaId) {
      params.push(oficinaId);
      where.push(`p.id_oficina = $${params.length}`);
    }

    if (capturistaId) {
      params.push(capturistaId);
      where.push(`p.creado_por = $${params.length}`);
    }

    if (Number.isFinite(idMunTrabajo) && idMunTrabajo > 0) {
      params.push(idMunTrabajo);
      where.push(`p.municipio_trabajo_politico = $${params.length}`);
    }

    if (q) {
      params.push(`%${q}%`);
      const i = params.length;
      where.push(`
        (
          CONCAT_WS(' ', p.nombre, p.apellido_paterno, p.apellido_materno) ILIKE $${i}
          OR COALESCE(p.curp,'') ILIKE $${i}
          OR COALESCE(p.rfc,'') ILIKE $${i}
          OR COALESCE(p.clave_elector,'') ILIKE $${i}
        )
      `);
    }
    //filtro partido politico actual
    if (partidoIdRaw === "__OTRO__") {
      where.push(`COALESCE(TRIM(p.partido_otro_texto), '') <> ''`);
    } else {
      const partidoId = Number(partidoIdRaw);
      if (Number.isFinite(partidoId) && partidoId > 0) {
        params.push(partidoId);
        where.push(`p.id_partido_actual = $${params.length}`);
      }
    }

    if (["alto", "medio", "bajo"].includes(confiabilidad)) {
      params.push(confiabilidad);
      where.push(`LOWER(COALESCE(p.nivel_confiabilidad, '')) = $${params.length}`);
    }

    if (fechaDesde) {
      params.push(fechaDesde);
      where.push(`p.created_at::date >= $${params.length}::date`);
    }

    if (fechaHasta) {
      params.push(fechaHasta);
      where.push(`p.created_at::date <= $${params.length}::date`);
    }

    if (controversias === "1") {
      where.push(`
        EXISTS (
          SELECT 1
          FROM controversias_persona cp
          WHERE cp.id_persona = p.id_persona
        )
      `);
    }

    if (controversias === "0") {
      where.push(`
        NOT EXISTS (
          SELECT 1
          FROM controversias_persona cp
          WHERE cp.id_persona = p.id_persona
        )
      `);
    }

    if (["municipal", "regional", "distrital", "estatal", "nacional"].includes(liderazgo)) {
      params.push(liderazgo);
      where.push(`LOWER(COALESCE(p.escala_influencia, '')) = $${params.length}`);
    }
//filtro mas de un municipio de trabajo politico
    if (multiplesMunicipios === "1") {
      where.push(`
        EXISTS (
          SELECT 1
          FROM personas_municipios_trabajo pmt
          WHERE pmt.id_persona = p.id_persona
          GROUP BY pmt.id_persona
          HAVING COUNT(*) > 1
        )
      `);
    }

    if (multiplesMunicipios === "0") {
      where.push(`
        NOT EXISTS (
          SELECT 1
          FROM personas_municipios_trabajo pmt
          WHERE pmt.id_persona = p.id_persona
          GROUP BY pmt.id_persona
          HAVING COUNT(*) > 1
        )
      `);
    }

    if (req.query.sin_municipio_principal === "1") {
      where.push(`
        NOT EXISTS (
          SELECT 1
          FROM personas_municipios_trabajo pmt
          WHERE pmt.id_persona = p.id_persona
            AND pmt.es_principal = true
        )
      `);
    }

    if (req.query.con_observacion === "1") {
      where.push(`
        EXISTS (
          SELECT 1
          FROM personas_observaciones po
          WHERE po.id_persona = p.id_persona
            AND po.atendida = false
        )
      `);
    }

    const refMode = String(req.query.refMode || "").trim(); // "exact" | ""

    // -------- filtro referente
    if (referente || refNivel) {
      const refParts = [];

      if (referente) {
        const ref = referente.toLowerCase().trim();
        params.push(ref);
        const i = params.length;

        if (refMode === "exact") {
          refParts.push(`rp.nombre_full = $${i}`);
        } else {
          refParts.push(`
            (
              (length($${i}) < 6 AND rp.nombre_full LIKE ($${i} || '%'))
              OR word_similarity(rp.nombre_full, $${i}) > 0.15
              OR similarity(rp.nombre_full, $${i}) > 0.15
            )
          `);
        }
      }

      if (referenteCargo) {
        params.push(referenteCargo.toLowerCase().trim());
        const j = params.length;
        refParts.push(`COALESCE(lower(trim(rp.cargo)), '') = $${j}`);
      }

      if (refNivel) {
        params.push(refNivel);
        const k = params.length;
        refParts.push(`COALESCE(lower(trim(rp.nivel)), '') = $${k}`);
      }

      where.push(`
        EXISTS (
          SELECT 1
          FROM referentes_politicos rp
          WHERE rp.id_persona = p.id_persona
            AND ${refParts.join(" AND ")}
        )
      `);
    }
    //filtro por area ,office o all
    // ✅ compatibilidad anterior: FINAL únicamente
    if (verificado === "1") where.push(`p.verificado_at IS NOT NULL`);
    if (verificado === "0") where.push(`p.verificado_at IS NULL`);

    // ✅ nuevo filtro por nivel de verificación
    if (verifLevel === "final") {
      where.push(`p.verificado_at IS NOT NULL`);
    }

    if (verifLevel === "office") {
      where.push(`p.verif_office_at IS NOT NULL`);
    }

    if (verifLevel === "area") {
      where.push(`p.verif_area_at IS NOT NULL`);
    }

    if (verifLevel === "sin_verificar") {
      where.push(`
        p.verif_area_at IS NULL
        AND p.verif_office_at IS NULL
        AND p.verificado_at IS NULL
      `);
    }

    if (verifLevel === "parcial") {
      where.push(`
        (
          p.verif_area_at IS NOT NULL
          OR p.verif_office_at IS NOT NULL
        )
        AND p.verificado_at IS NULL
      `);
    }

    if (verifLevel === "cualquiera_verificado") {
      where.push(`
        (
          p.verif_area_at IS NOT NULL
          OR p.verif_office_at IS NOT NULL
          OR p.verificado_at IS NOT NULL
        )
      `);
    }

    // ✅ “verificado” sigue siendo el nivel 3 (final)
    if (verificado === "1") where.push(`p.verificado_at IS NOT NULL`);
    if (verificado === "0") where.push(`p.verificado_at IS NULL`);

    const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const mode = String(req.query.mode || "").trim();

    // =========================================================
    // MODO: LISTA DE REFERENTES PARA SELECT
    // =========================================================
    if (mode === "ref_list") {
      const refListWhere = [...where];

      // en ref_list NO queremos que el propio filtro "referente" del input
      // afecte la lista, solo q/office/scope/etc si existen.
      // Así que reconstruimos usando smartFilters + nivel + otros filtros ajenos al referente.
      const refParams = [];
      const refWhere = [];
      addFullFilter(refParams, refWhere);

      if (oficinaId) {
        refParams.push(oficinaId);
        refWhere.push(`p.id_oficina = $${refParams.length}`);
      }

      if (capturistaId) {
        refParams.push(capturistaId);
        refWhere.push(`p.creado_por = $${refParams.length}`);
      }

      if (Number.isFinite(idMunTrabajo) && idMunTrabajo > 0) {
        refParams.push(idMunTrabajo);
        refWhere.push(`p.municipio_trabajo_politico = $${refParams.length}`);
      }

      if (q) {
        refParams.push(`%${q}%`);
        const iq = refParams.length;
        refWhere.push(`
          (
            COALESCE(p.nombre,'') ILIKE $${iq}
            OR COALESCE(p.apellido_paterno,'') ILIKE $${iq}
            OR COALESCE(p.apellido_materno,'') ILIKE $${iq}
            OR COALESCE(p.curp,'') ILIKE $${iq}
            OR COALESCE(p.rfc,'') ILIKE $${iq}
            OR COALESCE(p.clave_elector,'') ILIKE $${iq}
          )
        `);
      }

      if (verificado === "1") refWhere.push(`p.verificado_at IS NOT NULL`);
      if (verificado === "0") refWhere.push(`p.verificado_at IS NULL`);

      if (refNivel) {
        refParams.push(refNivel);
        refWhere.push(`COALESCE(lower(trim(rp.nivel)), '') = $${refParams.length}`);
      }

      const refWhereSQL = refWhere.length ? `WHERE ${refWhere.join(" AND ")}` : "";

      const sql = `
        SELECT
          INITCAP(rp.nombre_full) AS nombre,
          COALESCE(trim(rp.cargo), '') AS cargo,
          COALESCE(lower(trim(rp.nivel)), '') AS nivel,
          CASE
            WHEN COALESCE(trim(rp.cargo), '') <> ''
              THEN INITCAP(rp.nombre_full) || ' - ' || rp.cargo
            ELSE INITCAP(rp.nombre_full)
          END AS label,
          COUNT(*)::int AS menciones
        FROM personas p
        JOIN referentes_politicos rp ON rp.id_persona = p.id_persona
        ${refWhereSQL}
        GROUP BY rp.nombre_full, rp.cargo, rp.nivel
        ORDER BY menciones DESC, label ASC
        LIMIT 500
      `;

      const { rows } = await client.query(sql, refParams);
      return res.json({ data: rows });
    }

    if (mode === "ref_list_dashboard") {
      const refParams = [];
      const refWhere = [];
      addFullFilter(refParams, refWhere);

      if (oficinaId) {
        refParams.push(oficinaId);
        refWhere.push(`p.id_oficina = $${refParams.length}`);
      }

      if (capturistaId) {
        refParams.push(capturistaId);
        refWhere.push(`p.creado_por = $${refParams.length}`);
      }

      if (Number.isFinite(idMunTrabajo) && idMunTrabajo > 0) {
        refParams.push(idMunTrabajo);
        refWhere.push(`p.municipio_trabajo_politico = $${refParams.length}`);
      }

      if (q) {
        refParams.push(`%${q}%`);
        const iq = refParams.length;
        refWhere.push(`
          (
            COALESCE(p.nombre,'') ILIKE $${iq}
            OR COALESCE(p.apellido_paterno,'') ILIKE $${iq}
            OR COALESCE(p.apellido_materno,'') ILIKE $${iq}
            OR COALESCE(p.curp,'') ILIKE $${iq}
            OR COALESCE(p.rfc,'') ILIKE $${iq}
            OR COALESCE(p.clave_elector,'') ILIKE $${iq}
          )
        `);
      }

      if (verificado === "1") refWhere.push(`p.verificado_at IS NOT NULL`);
      if (verificado === "0") refWhere.push(`p.verificado_at IS NULL`);

      if (refNivel) {
        refParams.push(refNivel);
        refWhere.push(`COALESCE(lower(trim(rp.nivel)), '') = $${refParams.length}`);
      }

      const refWhereSQL = refWhere.length ? `WHERE ${refWhere.join(" AND ")}` : "";

      const sql = `
        SELECT
          INITCAP(rp.nombre_full) AS nombre,
          INITCAP(rp.nombre_full) AS label,
          COUNT(*)::int AS menciones
        FROM personas p
        JOIN referentes_politicos rp ON rp.id_persona = p.id_persona
        ${refWhereSQL}
        GROUP BY rp.nombre_full
        ORDER BY menciones DESC, nombre ASC
        LIMIT 500
      `;

      const { rows } = await client.query(sql, refParams);
      return res.json({ data: rows });
    }

    // -------- TOTAL
    const totalSql = `SELECT COUNT(*)::int AS total FROM personas p ${whereSQL}`;
    const { rows: totalRows } = await client.query(totalSql, params);
    const total = totalRows?.[0]?.total || 0;
    const last_page = Math.max(Math.ceil(total / size), 1);

    // -------- DATA
    const dataSql = `
      SELECT
        p.id_persona, p.nombre, p.apellido_paterno, p.apellido_materno, p.foto_url,
        (p.nombre || ' ' || COALESCE(p.apellido_paterno,'') || ' ' || COALESCE(p.apellido_materno,'')) AS nombre_completo,
        p.curp, p.rfc, p.clave_elector, p.id_oficina, p.nivel_confiabilidad, o.nombre AS oficina_nombre,
        p.oculto, p.oculto_at, p.oculto_por,

        -- observaciones pendientes (para chip en grid)
        (
          SELECT COUNT(*)::int
          FROM personas_observaciones po
          WHERE po.id_persona = p.id_persona
            AND po.atendida = false
        ) AS obs_pendientes,

        -- partido politico filtro
        p.id_partido_actual,
        p.partido_otro_texto,
        COALESCE(NULLIF(TRIM(p.partido_otro_texto), ''), cp.nombre) AS partido_nombre, cp.siglas,

        -- trazabilidad creador / editor
        p.creado_por, u_crea.nombre AS creado_por_nombre, u_crea.email AS creado_por_email,
        u_crea.cargo AS creado_por_cargo, u_crea.area AS creado_por_area,

        p.modificado_por, u_mod.nombre AS modificado_por_nombre, u_mod.email AS modificado_por_email,
        u_mod.cargo AS modificado_por_cargo, u_mod.area AS modificado_por_area,

        -- ✅ NIVEL 1: AREA (director)
        p.verif_area_por,
        p.verif_area_at,
        u_va.nombre AS verif_area_por_nombre,
        u_va.email  AS verif_area_por_email,
        u_va.cargo  AS verif_area_por_cargo,
        u_va.area   AS verif_area_por_area,

        -- ✅ NIVEL 2: OFFICE (coordinador)
        p.verif_office_por,
        p.verif_office_at,
        u_vo.nombre AS verif_office_por_nombre,
        u_vo.email  AS verif_office_por_email,
        u_vo.cargo  AS verif_office_por_cargo,
        u_vo.area   AS verif_office_por_area,

        -- ✅ NIVEL 3: FINAL (superadmin)
        p.verificado_por,
        p.verificado_at,
        u_ver.nombre AS verificado_por_nombre,
        u_ver.email  AS verificado_por_email,
        u_ver.cargo  AS verificado_por_cargo,
        u_ver.area   AS verificado_por_area,

        -- ✅ REFERENTES (para autocomplete / apoyo visual)
        COALESCE((
          SELECT string_agg(
            DISTINCT concat_ws(' ', rp.nombres, rp.apellido_paterno, rp.apellido_materno),
            ' | '
          )
          FROM referentes_politicos rp
          WHERE rp.id_persona = p.id_persona
        ), '') AS referentes_nombres,


        COALESCE((
          SELECT COUNT(*)::int
          FROM personas_municipios_trabajo pmt
          WHERE pmt.id_persona = p.id_persona
        ), 0) AS total_municipios_trabajo,

        p.municipio_trabajo_politico,
        mt.nombre AS municipio_trabajo_nombre,
        p.created_at,
        p.updated_at,
        t.telefono AS telefono_principal,

        -- ✅ ESTADO RESUMIDO DE VERIFICACIÓN
      CASE
        WHEN p.verificado_at IS NOT NULL THEN 'FINAL'
        WHEN p.verif_office_at IS NOT NULL THEN 'OFFICE'
        WHEN p.verif_area_at IS NOT NULL THEN 'AREA'
        ELSE 'SIN_VERIFICAR'
      END AS estado_verificacion

      FROM personas p
      LEFT JOIN oficinas o ON o.id_oficina = p.id_oficina
      LEFT JOIN usuarios u_crea ON u_crea.id_usuario = p.creado_por
      LEFT JOIN usuarios u_mod  ON u_mod.id_usuario  = p.modificado_por
      LEFT JOIN usuarios u_va   ON u_va.id_usuario   = p.verif_area_por
      LEFT JOIN usuarios u_vo   ON u_vo.id_usuario   = p.verif_office_por
      LEFT JOIN usuarios u_ver  ON u_ver.id_usuario  = p.verificado_por
      LEFT JOIN municipios mt ON mt.id_municipio = p.municipio_trabajo_politico
      LEFT JOIN catalogo_partidos cp ON cp.id_partido = p.id_partido_actual
      LEFT JOIN LATERAL (
        SELECT telefono
        FROM telefonos
        WHERE id_persona = p.id_persona
        ORDER BY principal DESC, id_telefono ASC
        LIMIT 1
      ) t ON true

      ${whereSQL}
      ORDER BY p.${sortField} ${sortDir}, p.id_persona DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const dataParams = params.concat([size, offset]);
    const { rows } = await client.query(dataSql, dataParams);

    return res.json({ data: rows, total, page, size, last_page });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Error al obtener grid", detail: e.message });
  } finally {
    client.release();
  }
};

//kpi verificados
exports.kpiResumenEjecutivo = async (req, res) => {
  const client = await pool.connect();
  try {
    const { addFullFilter } = req.smartFilters;
    const params = [];
    const where = [];

    addFullFilter(params, where);

    const oficinaId = req.query.oficinaId ? Number(req.query.oficinaId) : null;
    const capturistaId = req.query.capturistaId ? Number(req.query.capturistaId) : null;
    const idMunTrabajo = req.query.municipio_trabajo ? Number(req.query.municipio_trabajo) : null;
    const q = (req.query.q || "").trim();
    const partidoIdRaw = String(req.query.partidoId || "").trim();
    const confiabilidad = String(req.query.confiabilidad || "").trim().toLowerCase();
    const liderazgo = String(req.query.liderazgo || "").trim().toLowerCase();
    const controversias = ["1", "0"].includes(String(req.query.controversias))
      ? String(req.query.controversias)
      : null;
    const referente = String(req.query.referente || "").trim();
    const referenteCargo = String(req.query.referenteCargo || "").trim();
    const refNivelRaw = String(req.query.refNivel || "").trim().toLowerCase();
    const refNivel = ["municipal", "regional", "distrital", "estatal", "nacional"].includes(refNivelRaw)
      ? refNivelRaw
      : "";
    const refMode = String(req.query.refMode || "").trim();
    const fechaDesde = String(req.query.fechaDesde || "").trim();
    const fechaHasta = String(req.query.fechaHasta || "").trim();
    const verifLevel = String(req.query.verifLevel || "").trim().toLowerCase();
    const verificado = ["1", "0"].includes(String(req.query.verificado))
      ? String(req.query.verificado)
      : null;
    const multiplesMunicipios = ["1", "0"].includes(String(req.query.multiples_municipios))
      ? String(req.query.multiples_municipios)
      : null;

    if (oficinaId) {
      params.push(oficinaId);
      where.push(`p.id_oficina = $${params.length}`);
    }

    if (capturistaId) {
      params.push(capturistaId);
      where.push(`p.creado_por = $${params.length}`);
    }

    if (Number.isFinite(idMunTrabajo) && idMunTrabajo > 0) {
      params.push(idMunTrabajo);
      where.push(`p.municipio_trabajo_politico = $${params.length}`);
    }

    if (q) {
      params.push(`%${q}%`);
      const i = params.length;
      where.push(`
        (
          COALESCE(p.nombre,'') ILIKE $${i}
          OR COALESCE(p.apellido_paterno,'') ILIKE $${i}
          OR COALESCE(p.apellido_materno,'') ILIKE $${i}
          OR COALESCE(p.curp,'') ILIKE $${i}
          OR COALESCE(p.rfc,'') ILIKE $${i}
          OR COALESCE(p.clave_elector,'') ILIKE $${i}
        )
      `);
    }

    if (partidoIdRaw === "__OTRO__") {
      where.push(`COALESCE(TRIM(p.partido_otro_texto), '') <> ''`);
    } else {
      const partidoId = Number(partidoIdRaw);
      if (Number.isFinite(partidoId) && partidoId > 0) {
        params.push(partidoId);
        where.push(`p.id_partido_actual = $${params.length}`);
      }
    }

    if (["alto", "medio", "bajo"].includes(confiabilidad)) {
      params.push(confiabilidad);
      where.push(`LOWER(COALESCE(p.nivel_confiabilidad, '')) = $${params.length}`);
    }

    if (["municipal", "regional", "distrital", "estatal", "nacional"].includes(liderazgo)) {
      params.push(liderazgo);
      where.push(`LOWER(COALESCE(p.escala_influencia, '')) = $${params.length}`);
    }

    if (controversias === "1") {
      where.push(`EXISTS (
        SELECT 1 FROM controversias_persona cp WHERE cp.id_persona = p.id_persona
      )`);
    }

    if (controversias === "0") {
      where.push(`NOT EXISTS (
        SELECT 1 FROM controversias_persona cp WHERE cp.id_persona = p.id_persona
      )`);
    }

    if (fechaDesde) {
      params.push(fechaDesde);
      where.push(`p.created_at::date >= $${params.length}::date`);
    }

    if (fechaHasta) {
      params.push(fechaHasta);
      where.push(`p.created_at::date <= $${params.length}::date`);
    }

    if (multiplesMunicipios === "1") {
      where.push(`EXISTS (
        SELECT 1
        FROM personas_municipios_trabajo pmt
        WHERE pmt.id_persona = p.id_persona
        GROUP BY pmt.id_persona
        HAVING COUNT(*) > 1
      )`);
    }

    if (multiplesMunicipios === "0") {
      where.push(`NOT EXISTS (
        SELECT 1
        FROM personas_municipios_trabajo pmt
        WHERE pmt.id_persona = p.id_persona
        GROUP BY pmt.id_persona
        HAVING COUNT(*) > 1
      )`);
    }

    if (req.query.sin_municipio_principal === "1") {
      where.push(`NOT EXISTS (
        SELECT 1
        FROM personas_municipios_trabajo pmt
        WHERE pmt.id_persona = p.id_persona
          AND pmt.es_principal = true
      )`);
    }

    if (referente || refNivel) {
      const refParts = [];

      if (referente) {
        params.push(referente.toLowerCase());
        const i = params.length;
        refParts.push(refMode === "exact"
          ? `rp.nombre_full = $${i}`
          : `(
              (length($${i}) < 6 AND rp.nombre_full LIKE ($${i} || '%'))
              OR word_similarity(rp.nombre_full, $${i}) > 0.15
              OR similarity(rp.nombre_full, $${i}) > 0.15
            )`
        );
      }

      if (referenteCargo) {
        params.push(referenteCargo.toLowerCase());
        refParts.push(`COALESCE(lower(trim(rp.cargo)), '') = $${params.length}`);
      }

      if (refNivel) {
        params.push(refNivel);
        refParts.push(`COALESCE(lower(trim(rp.nivel)), '') = $${params.length}`);
      }

      where.push(`EXISTS (
        SELECT 1
        FROM referentes_politicos rp
        WHERE rp.id_persona = p.id_persona
          AND ${refParts.join(" AND ")}
      )`);
    }

    if (verificado === "1") where.push(`p.verificado_at IS NOT NULL`);
    if (verificado === "0") where.push(`p.verificado_at IS NULL`);

    if (verifLevel === "final") where.push(`p.verificado_at IS NOT NULL`);
    if (verifLevel === "office") where.push(`p.verif_office_at IS NOT NULL`);
    if (verifLevel === "area") where.push(`p.verif_area_at IS NOT NULL`);
    if (verifLevel === "sin_verificar") {
      where.push(`p.verif_area_at IS NULL AND p.verif_office_at IS NULL AND p.verificado_at IS NULL`);
    }
    if (verifLevel === "parcial") {
      where.push(`(
        p.verif_area_at IS NOT NULL OR p.verif_office_at IS NOT NULL
      ) AND p.verificado_at IS NULL`);
    }
    if (verifLevel === "cualquiera_verificado") {
      where.push(`(
        p.verif_area_at IS NOT NULL
        OR p.verif_office_at IS NOT NULL
        OR p.verificado_at IS NOT NULL
      )`);
    }

    const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const sql = `
      SELECT
        COUNT(*)::int AS total_actores,

        COUNT(*) FILTER (
          WHERE p.verif_area_at IS NOT NULL
        )::int AS verificados_direccion,

        COUNT(*) FILTER (
          WHERE p.verif_office_at IS NOT NULL
        )::int AS verificados_coordinacion,

        COUNT(*) FILTER (
          WHERE p.verificado_at IS NOT NULL
        )::int AS verificados_final,

        COUNT(*) FILTER (
          WHERE p.verif_office_at IS NOT NULL
            AND p.verificado_at IS NULL
        )::int AS pendientes_final,

        COUNT(*) FILTER (
          WHERE EXISTS (
            SELECT 1
            FROM controversias_persona c
            WHERE c.id_persona = p.id_persona
          )
        )::int AS con_controversias,

        COUNT(*) FILTER (
          WHERE COALESCE(lower(trim(p.nivel_confiabilidad)), '') = 'alto'
        )::int AS confiabilidad_alta
        
      FROM personas p
      ${whereSQL}
    `;

    const { rows } = await client.query(sql, params);
    const row = rows[0] || {};

    return res.json({
      total_actores: Number(row.total_actores || 0),
      verificados_direccion: Number(row.verificados_direccion || 0),
      verificados_coordinacion: Number(row.verificados_coordinacion || 0),
      verificados_final: Number(row.verificados_final || 0),
      pendientes_final: Number(row.pendientes_final || 0),
      con_controversias: Number(row.con_controversias || 0),
      confiabilidad_alta: Number(row.confiabilidad_alta || 0)
    });

  } catch (e) {
    console.error(e);
    return res.status(500).json({
      error: "Error al obtener KPI resumen ejecutivo",
      detail: e.message
    });
  } finally {
    client.release();
  }
};

//endppint para personas con varios municipios de trabajo politico
exports.listPersonasAdminGridMapaMunicipios = async (req, res) => {
  const client = await pool.connect();
  try {
    // -------- filtros base
    let oficinaId = req.query.oficinaId ? Number(req.query.oficinaId) : null;
    const capturistaId = req.query.capturistaId ? Number(req.query.capturistaId) : null;
    const idMunTrabajo = req.query.municipio_trabajo ? Number(req.query.municipio_trabajo) : null;

    const referente = (req.query.referente || "").trim();
    const referenteCargo = (req.query.referenteCargo || "").trim();

    const refNivelRaw = (req.query.refNivel || "").trim().toLowerCase();
    const refNivel = ["municipal", "regional", "distrital", "estatal", "nacional"].includes(refNivelRaw)
      ? refNivelRaw
      : "";

    const q = (req.query.q || "").trim();

    const partidoIdRaw = String(req.query.partidoId || "").trim();
    const confiabilidad = (req.query.confiabilidad || "").trim().toLowerCase();
    const liderazgo = (req.query.liderazgo || "").trim().toLowerCase();
    const verifLevel = String(req.query.verifLevel || "").trim().toLowerCase();

    const controversias =
      (req.query.controversias === "1" || req.query.controversias === "0")
        ? req.query.controversias
        : null;

    const verificado = (req.query.verificado === "1" || req.query.verificado === "0")
      ? req.query.verificado
      : null;

    const multiplesMunicipios =
      (req.query.multiples_municipios === "1" || req.query.multiples_municipios === "0")
        ? req.query.multiples_municipios
        : null;

    const refMode = String(req.query.refMode || "").trim(); // "exact" | ""

    // -------- SMART FILTERS
    const { addFullFilter } = req.smartFilters;
    const params = [];
    const where = [];
    addFullFilter(params, where);

    // -------- filtros manuales
    if (oficinaId) {
      params.push(oficinaId);
      where.push(`p.id_oficina = $${params.length}`);
    }

    if (capturistaId) {
      params.push(capturistaId);
      where.push(`p.creado_por = $${params.length}`);
    }

    if (Number.isFinite(idMunTrabajo) && idMunTrabajo > 0) {
      params.push(idMunTrabajo);
      where.push(`p.municipio_trabajo_politico = $${params.length}`);
    }

    if (q) {
      params.push(`%${q}%`);
      const i = params.length;
      where.push(`
        (
          COALESCE(p.nombre,'') ILIKE $${i}
          OR COALESCE(p.apellido_paterno,'') ILIKE $${i}
          OR COALESCE(p.apellido_materno,'') ILIKE $${i}
          OR COALESCE(p.curp,'') ILIKE $${i}
          OR COALESCE(p.rfc,'') ILIKE $${i}
          OR COALESCE(p.clave_elector,'') ILIKE $${i}
        )
      `);
    }

    //OTRO FILTROS
    if (partidoIdRaw === "__OTRO__") {
      where.push(`COALESCE(TRIM(p.partido_otro_texto), '') <> ''`);
    } else if (partidoIdRaw === "__INDEPENDIENTE__") {
      where.push(`
        p.id_partido_actual IS NULL
        AND COALESCE(TRIM(p.partido_otro_texto), '') = ''
      `);
    } else {
      const partidoId = Number(partidoIdRaw);
      if (Number.isFinite(partidoId) && partidoId > 0) {
        params.push(partidoId);
        where.push(`p.id_partido_actual = $${params.length}`);
      }
    }

    if (["alto", "medio", "bajo"].includes(confiabilidad)) {
      params.push(confiabilidad);
      where.push(`LOWER(COALESCE(p.nivel_confiabilidad, '')) = $${params.length}`);
    }

    if (["municipal", "regional", "distrital", "estatal", "nacional"].includes(liderazgo)) {
      params.push(liderazgo);
      where.push(`LOWER(COALESCE(p.escala_influencia, '')) = $${params.length}`);
    }
    if (controversias === "1") {
      where.push(`
        EXISTS (
          SELECT 1
          FROM controversias_persona cp
          WHERE cp.id_persona = p.id_persona
        )
      `);
    }

    if (controversias === "0") {
      where.push(`
        NOT EXISTS (
          SELECT 1
          FROM controversias_persona cp
          WHERE cp.id_persona = p.id_persona
        )
      `);
    }

    if (verifLevel === "final") {
      where.push(`p.verificado_at IS NOT NULL`);
    }

    if (verifLevel === "office") {
      where.push(`
        p.verif_office_at IS NOT NULL
        AND p.verificado_at IS NULL
      `);
    }

    if (verifLevel === "area") {
      where.push(`
        p.verif_area_at IS NOT NULL
        AND p.verif_office_at IS NULL
        AND p.verificado_at IS NULL
      `);
    }

    if (verifLevel === "sin_verificar") {
      where.push(`
        p.verif_area_at IS NULL
        AND p.verif_office_at IS NULL
        AND p.verificado_at IS NULL
      `);
    }

    if (verifLevel === "parcial") {
      where.push(`
        (
          p.verif_area_at IS NOT NULL
          OR p.verif_office_at IS NOT NULL
        )
        AND p.verificado_at IS NULL
      `);
    }

    if (verifLevel === "cualquiera_verificado") {
      where.push(`
        (
          p.verif_area_at IS NOT NULL
          OR p.verif_office_at IS NOT NULL
          OR p.verificado_at IS NOT NULL
        )
      `);
    }



    // -------- filtro referente
    if (referente || refNivel) {
      const refParts = [];

      if (referente) {
        const ref = referente.toLowerCase().trim();
        params.push(ref);
        const i = params.length;

        if (refMode === "exact") {
          refParts.push(`rp.nombre_full = $${i}`);
        } else {
          refParts.push(`
            (
              (length($${i}) < 6 AND rp.nombre_full LIKE ($${i} || '%'))
              OR word_similarity(rp.nombre_full, $${i}) > 0.15
              OR similarity(rp.nombre_full, $${i}) > 0.15
            )
          `);
        }
      }

      if (referenteCargo) {
        params.push(referenteCargo.toLowerCase().trim());
        const j = params.length;
        refParts.push(`COALESCE(lower(trim(rp.cargo)), '') = $${j}`);
      }

      if (refNivel) {
        params.push(refNivel);
        const k = params.length;
        refParts.push(`COALESCE(lower(trim(rp.nivel)), '') = $${k}`);
      }

      where.push(`
        EXISTS (
          SELECT 1
          FROM referentes_politicos rp
          WHERE rp.id_persona = p.id_persona
            AND ${refParts.join(" AND ")}
        )
      `);
    }

    // -------- verificado final
    if (verificado === "1") where.push(`p.verificado_at IS NOT NULL`);
    if (verificado === "0") where.push(`p.verificado_at IS NULL`);

    // -------- filtro por múltiples municipios
    if (multiplesMunicipios === "1") {
      where.push(`
        EXISTS (
          SELECT 1
          FROM personas_municipios_trabajo pmt
          WHERE pmt.id_persona = p.id_persona
          GROUP BY pmt.id_persona
          HAVING COUNT(*) > 1
        )
      `);
    }

    if (multiplesMunicipios === "0") {
      where.push(`
        NOT EXISTS (
          SELECT 1
          FROM personas_municipios_trabajo pmt
          WHERE pmt.id_persona = p.id_persona
          GROUP BY pmt.id_persona
          HAVING COUNT(*) > 1
        )
      `);
    }

    const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const sql = `
      WITH personas_filtradas AS (
        SELECT
          p.id_persona,
          p.municipio_trabajo_politico
        FROM personas p
        ${whereSQL}
      ),
      municipios_union AS (
        -- municipio principal
        SELECT DISTINCT
          pf.id_persona,
          pf.municipio_trabajo_politico AS id_municipio
        FROM personas_filtradas pf
        WHERE pf.municipio_trabajo_politico IS NOT NULL

        UNION

        -- municipios adicionales
        SELECT DISTINCT
          pmt.id_persona,
          pmt.id_municipio
        FROM personas_municipios_trabajo pmt
        INNER JOIN personas_filtradas pf ON pf.id_persona = pmt.id_persona
      )
      SELECT
        mu.id_municipio,
        m.nombre AS municipio,
        COUNT(*)::int AS total,
        (SELECT COUNT(DISTINCT id_persona) FROM municipios_union)::int AS total_actores,
        (SELECT COUNT(DISTINCT id_municipio) FROM municipios_union)::int AS total_municipios
      FROM municipios_union mu
      LEFT JOIN municipios m ON m.id_municipio = mu.id_municipio
      GROUP BY mu.id_municipio, m.nombre
      ORDER BY m.nombre ASC
    `;

    const { rows } = await client.query(sql, params);

    return res.json({ ok: true, data: rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      error: "Error al obtener municipios del mapa",
      detail: e.message
    });
  } finally {
    client.release();
  }
};

//filtro clic solo persona para ver sus municipios de trabajo politico

exports.getPersonaMunicipiosTrabajo = async (req, res) => {
  const client = await pool.connect();
  try {
    const id_persona = Number(req.params.id);
    if (!Number.isFinite(id_persona) || id_persona <= 0) {
      return res.status(400).json({ error: "id inválido" });
    }

    // ✅ gate de seguridad con smartFilters
    const { addFullFilter } = req.smartFilters;
    const params = [];
    const where = [];
    addFullFilter(params, where);

    params.push(id_persona);
    where.push(`p.id_persona = $${params.length}`);

    const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const sql = `
      WITH persona_filtrada AS (
        SELECT
          p.id_persona,
          p.nombre,
          p.apellido_paterno,
          p.apellido_materno,
          p.municipio_trabajo_politico
        FROM personas p
        ${whereSQL}
        LIMIT 1
      ),
      municipios_union AS (
        -- principal
        SELECT DISTINCT
          pf.id_persona,
          pf.municipio_trabajo_politico AS id_municipio,
          true AS es_principal,
          NULL::varchar AS notas
        FROM persona_filtrada pf
        WHERE pf.municipio_trabajo_politico IS NOT NULL

        UNION

        -- adicionales
        SELECT DISTINCT
          pmt.id_persona,
          pmt.id_municipio,
          COALESCE(pmt.es_principal, false) AS es_principal,
          pmt.notas
        FROM personas_municipios_trabajo pmt
        INNER JOIN persona_filtrada pf ON pf.id_persona = pmt.id_persona
      )
      SELECT
        pf.id_persona,
        (pf.nombre || ' ' || COALESCE(pf.apellido_paterno,'') || ' ' || COALESCE(pf.apellido_materno,'')) AS nombre_completo,
        mu.id_municipio,
        m.nombre AS municipio,
        mu.es_principal,
        mu.notas
      FROM persona_filtrada pf
      JOIN municipios_union mu ON mu.id_persona = pf.id_persona
      LEFT JOIN municipios m ON m.id_municipio = mu.id_municipio
      ORDER BY mu.es_principal DESC, m.nombre ASC
    `;

    const { rows } = await client.query(sql, params);

    if (!rows.length) {
      return res.status(404).json({ error: "Persona no encontrada o sin acceso" });
    }

    return res.json({
      ok: true,
      persona: {
        id_persona: rows[0].id_persona,
        nombre_completo: rows[0].nombre_completo
      },
      data: rows.map(r => ({
        id_municipio: r.id_municipio,
        municipio: r.municipio,
        es_principal: r.es_principal,
        notas: r.notas
      }))
    });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Error al obtener municipios de la persona", detail: e.message });
  } finally {
    client.release();
  }
};



// 2) CREAR PERSONA COMPLETA (transacción)
// Espera un JSON como el que te pongo más abajo
// Espera un JSON como el que te pongo más abajo
exports.createPersonaCompleta = async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      persona,
      datos_ine = null,
      telefonos = [],
      parejas = [],
      hijos = [],
      redes = [],
      servicio_publico = [],
      elecciones = [],
      capacidad_movilizacion_eventos = [],
      equipos = [],
      referentes = [],
      controversias = [],
      formacion_academica = [],
      familiares = [],
      temas_interes = [],
      participacion_organizaciones = [],
      cargos_eleccion_popular = [],
      experiencia_laboral = [],
      empresas_persona = [],
      fuentes_consulta = [],
      municipios_trabajo = [], // ✅ ya lo tomamos aquí en lugar de req.body después
      liderazgo_influencia = null,
    } = req.body;

    // -------------------------
    // VALIDACIONES PREVIAS (sin ROLLBACK)
    // -------------------------
    if (!persona?.nombre) return res.status(400).json({ error: "Nombre es requerido" });
    if (!persona?.apellido_paterno) return res.status(400).json({ error: "Apellido paterno es requerido" });
    if (!persona?.apellido_materno) return res.status(400).json({ error: "Apellido materno es requerido" });

    // Validación controversias vs bandera
    if (persona.sin_controversias_publicas === true && Array.isArray(controversias) && controversias.length > 0) {
      return res.status(400).json({
        error: 'No puede haber controversias si se marca "Sin controversias públicas"'
      });
    }

    // Validación tema central (Otro requiere texto)
    if (persona.id_tema_interes_central) {
      const { rows: temaRows } = await client.query(
        "SELECT requiere_otro_texto FROM catalogo_temas_interes WHERE id_tema = $1",
        [persona.id_tema_interes_central]
      );
      if (!temaRows[0]) return res.status(400).json({ error: "Tema de interés inválido" });

      if (temaRows[0].requiere_otro_texto && !persona.tema_interes_otro_texto) {
        return res.status(400).json({ error: 'Para el tema "Otro" se requiere texto' });
      }
    }

    // Validación nivel de confiabilidad
    const nc = (persona.nivel_confiabilidad || "").toString().trim().toLowerCase() || null;
    if (nc && !["alto", "medio", "bajo"].includes(nc)) {
      return res.status(400).json({ error: "nivel_confiabilidad inválido" });
    }

    // Validación no contradicción cargos elección popular
    if (persona.sin_cargos_eleccion_popular === true && Array.isArray(cargos_eleccion_popular) && cargos_eleccion_popular.length > 0) {
      return res.status(400).json({
        error: 'No puede haber cargos de elección popular si se marca "No ha ocupado cargos de elección popular"'
      });
    }

    //validaciones y mas
    const LID_NIVELES = new Set(["alto", "medio", "bajo", "nulo"]);
    const LID_TIPOS = new Set([
      "territorial",
      "politico_institucional",
      "social_comunitario",
      "empresarial",
      "mediatico",
      "tecnico_especializado",
      "otro"
    ]);
    const LID_PRESENCIAS = new Set(["permanente", "eventual", "nula"]);

    function normalizeStr(s) {
      return (s ?? "").toString().trim();
    }

    function normalizeArray(arr) {
      if (!Array.isArray(arr)) return [];
      return arr.map(x => normalizeStr(x)).filter(Boolean);
    }

    function validateLiderazgo(lid) {
      if (!lid || typeof lid !== "object") return { ok: true, data: null };

      const nivel = normalizeStr(lid.nivel).toLowerCase() || null;
      const tipos = normalizeArray(lid.tipos).map(t => t.toLowerCase());
      const tipo_otro_texto = normalizeStr(lid.tipo_otro_texto) || null;

      const cuentaRaw = lid.cuenta_con_estructura;
      const cuenta_con_estructura =
        cuentaRaw === null || cuentaRaw === undefined ? null : !!cuentaRaw;

      const presencia_territorial = normalizeStr(lid.presencia_territorial).toLowerCase() || null;

      // si viene totalmente vacío, lo tratamos como null (no insert)
      const tieneAlgo =
        nivel || tipos.length || tipo_otro_texto ||
        cuenta_con_estructura !== null || presencia_territorial;

      if (!tieneAlgo) return { ok: true, data: null };

      // validaciones
      if (nivel && !LID_NIVELES.has(nivel)) {
        return { ok: false, error: "nivel de liderazgo inválido" };
      }

      for (const t of tipos) {
        if (!LID_TIPOS.has(t)) return { ok: false, error: "tipo de liderazgo inválido" };
      }

      if (presencia_territorial && !LID_PRESENCIAS.has(presencia_territorial)) {
        return { ok: false, error: "presencia territorial inválida" };
      }

      // si incluye "otro", exige texto
      if (tipos.includes("otro") && !tipo_otro_texto) {
        return { ok: false, error: 'Si seleccionas "Otro", captura tipo_otro_texto' };
      }

      // si NO incluye "otro", limpia texto
      const otroFinal = tipos.includes("otro") ? tipo_otro_texto : null;

      return {
        ok: true,
        data: {
          nivel,
          tipos,
          tipo_otro_texto: otroFinal,
          cuenta_con_estructura,
          presencia_territorial
        }
      };
    }

    // ===============================
    // VALIDACIÓN RESIDENCIAS (FUERA EDOMEX) - BACKEND
    // ===============================
    const legalFuera = persona.res_legal_fuera_edomex === true;
    const realFuera  = persona.res_real_fuera_edomex === true;

    function hasText(x) { return !!(x || "").toString().trim(); }

    if (legalFuera) {
      if (persona.municipio_residencia_legal != null) {
        return res.status(400).json({ error: "Residencia legal: si es fuera EdoMéx, municipio_residencia_legal debe ser null." });
      }
      if (!hasText(persona.res_legal_estado_texto) || !hasText(persona.res_legal_municipio_texto)) {
        return res.status(400).json({ error: "Residencia legal: captura res_legal_estado_texto y res_legal_municipio_texto." });
      }
    } else {
      // si NO es fuera, no permitas textos
      persona.res_legal_estado_texto = null;
      persona.res_legal_municipio_texto = null;
    }

    if (realFuera) {
      if (persona.municipio_residencia_real != null) {
        return res.status(400).json({ error: "Residencia actual: si es fuera EdoMéx, municipio_residencia_real debe ser null." });
      }
      if (!hasText(persona.res_real_estado_texto) || !hasText(persona.res_real_municipio_texto)) {
        return res.status(400).json({ error: "Residencia actual: captura res_real_estado_texto y res_real_municipio_texto." });
      }
    } else {
      persona.res_real_estado_texto = null;
      persona.res_real_municipio_texto = null;
    }

    // -------------------------
    // BEGIN
    // -------------------------
    await client.query("BEGIN");

    // Reglas oficina por usuario
    const roles = req.user.roles || [];
    const isSuperadmin = roles.includes("superadmin");

    if (!isSuperadmin && !req.user.id_oficina) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Usuario sin oficina asignada" });
    }

    const oficinaFinal = isSuperadmin
      ? (persona.id_oficina || req.user.id_oficina || null)
      : req.user.id_oficina;

    // Validar "Otro" partido (ya dentro de transacción para consistencia)
    if (persona.id_partido_actual) {
      const { rows: pr } = await client.query(
        "SELECT nombre, siglas FROM catalogo_partidos WHERE id_partido = $1",
        [persona.id_partido_actual]
      );
      if (!pr[0]) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Partido inválido" });
      }

      const esOtro =
        (pr[0].nombre || "").toLowerCase() === "otro" ||
        (pr[0].siglas || "").toUpperCase() === "OTRO";

      if (esOtro && !persona.partido_otro_texto) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: 'Si partido es "Otro", se requiere partido_otro_texto' });
      }
      if (!esOtro && persona.partido_otro_texto) {
        persona.partido_otro_texto = null;
      }
    }

    const gruposPostulacion = Array.isArray(req.body?.grupos_postulacion)
    ? [...new Set(req.body.grupos_postulacion.map(Number).filter(Boolean))]
    : [];

    // -------------------------
    // INSERT PERSONA
    // -------------------------
    const creadoPor = req.user.id_usuario;

    const insertPersona = await client.query(
      `
      INSERT INTO personas (
        nombre, apellido_paterno, apellido_materno,
        curp, rfc, clave_elector,
        estado_civil, escala_influencia,
        sin_servicio_publico, ha_contendido_eleccion,
        creado_por,
        municipio_residencia_legal, municipio_residencia_real, municipio_trabajo_politico,

        -- 🔥 NUEVO BLOQUE RESIDENCIAS
        res_legal_fuera_edomex,
        res_legal_estado_texto,
        res_legal_municipio_texto,
        res_real_fuera_edomex,
        res_real_estado_texto,
        res_real_municipio_texto,

        sin_controversias_publicas,
        id_partido_actual, partido_otro_texto,
        id_grupo_postulacion,
        id_ideologia_politica,
        sin_cargos_eleccion_popular,
        foto_url,
        id_oficina,
        nivel_confiabilidad,
        edad
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
        $15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30
      )
      RETURNING id_persona
      `,
      [
        persona.nombre,
        persona.apellido_paterno || null,
        persona.apellido_materno || null,
        persona.curp || null,
        persona.rfc || null,
        persona.clave_elector || null,
        persona.estado_civil || null,
        persona.escala_influencia || null,
        persona.sin_servicio_publico ?? false,
        persona.ha_contendido_eleccion ?? null,
        creadoPor,
        persona.municipio_residencia_legal || null,
        persona.municipio_residencia_real || null,
        persona.municipio_trabajo_politico || null,

        // 🔥 NUEVOS CAMPOS RESIDENCIA
        persona.res_legal_fuera_edomex ?? false,
        persona.res_legal_estado_texto || null,
        persona.res_legal_municipio_texto || null,
        persona.res_real_fuera_edomex ?? false,
        persona.res_real_estado_texto || null,
        persona.res_real_municipio_texto || null,

        persona.sin_controversias_publicas ?? null,
        persona.id_partido_actual || null,
        persona.partido_otro_texto || null,
        persona.id_grupo_postulacion || null,
        persona.id_ideologia_politica || null,
        persona.sin_cargos_eleccion_popular ?? null,
        persona.foto_url || null,
        oficinaFinal,
        nc,
        persona.edad || null
      ]
    );

    const id_persona = insertPersona.rows[0].id_persona;

        // ✅ grupos de postulación (multi)
    const gruposFinales = gruposPostulacion.length
      ? gruposPostulacion
      : (persona.id_grupo_postulacion ? [Number(persona.id_grupo_postulacion)] : []);

    for (const idGrupo of gruposFinales) {
      await client.query(
        `
        INSERT INTO personas_grupos_postulacion (id_persona, id_grupo)
        VALUES ($1, $2)
        ON CONFLICT (id_persona, id_grupo) DO NOTHING
        `,
        [id_persona, idGrupo]
      );
    }

    // -------------------------
    // TEMAS DE INTERÉS 1:N
    // -------------------------
    for (const t of temas_interes) {
      if (!t?.id_tema) continue;

      const { rows } = await client.query(
        "SELECT requiere_otro_texto FROM catalogo_temas_interes WHERE id_tema = $1",
        [t.id_tema]
      );
      if (!rows[0]) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Tema de interés inválido" });
      }
      if (rows[0].requiere_otro_texto && !t.otro_texto) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: 'Para el tema "Otro" se requiere texto' });
      }

      await client.query(
        `INSERT INTO personas_temas_interes (id_persona, id_tema, otro_texto) VALUES ($1,$2,$3)`,
        [id_persona, t.id_tema, t.otro_texto || null]
      );
    }

    // -------------------------
    // FORMACIÓN ACADÉMICA
    // -------------------------
    for (const fa of formacion_academica) {
      const tieneAlgo =
        fa?.nivel || fa?.grado || fa?.grado_obtenido || fa?.institucion ||
        fa?.anio_inicio || fa?.titulado || fa?.anio_fin;

      if (!tieneAlgo) continue;

      if (!fa.nivel) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "formacion_academica.nivel es obligatorio" });
      }

      const requiereDetalle = ["Educación Superior", "Posgrado"].includes(fa.nivel);
      if (requiereDetalle && (!fa.grado_obtenido || !fa.institucion)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Para Educación Superior o Posgrado se requiere grado_obtenido e institucion" });
      }

      if (["Educación Superior", "Posgrado"].includes(fa.nivel)) {
        if (fa.titulado === null || fa.titulado === undefined) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Debes indicar si está titulado" });
        }
      }

      const ced = (fa.cedula_profesional || "").toString().trim() || null;
      const cedFinal = (fa.titulado === true) ? ced : null;

      if (fa.titulado === true && !cedFinal) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Si está titulado, captura la cédula profesional" });
      }

      await client.query(
        `
        INSERT INTO formacion_academica
          (id_persona, nivel, grado_obtenido, institucion, anio_inicio, anio_fin, grado, titulado, cedula_profesional)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `,
        [
          id_persona,
          fa.nivel,
          requiereDetalle ? (fa.grado_obtenido || null) : null,
          requiereDetalle ? (fa.institucion || null) : null,
          fa.anio_inicio || null,
          fa.anio_fin || null,
          fa.grado || null,
          fa.titulado ?? null,
          cedFinal
        ]
      );
    }

    // -------------------------
    // DATOS INE 1:1
    // -------------------------
    if (datos_ine && (datos_ine.seccion_electoral || datos_ine.distrito_federal || datos_ine.distrito_local)) {
      await client.query(
        `INSERT INTO datos_ine (id_persona, seccion_electoral, distrito_federal, distrito_local)
         VALUES ($1,$2,$3,$4)`,
        [
          id_persona,
          datos_ine.seccion_electoral || null,
          datos_ine.distrito_federal || null,
          datos_ine.distrito_local || null
        ]
      );
    }

    // -------------------------
    // TELEFONOS
    // -------------------------
    for (const t of telefonos) {
      if (!t?.telefono) continue;
      await client.query(
        `INSERT INTO telefonos (id_persona, telefono, tipo, principal) VALUES ($1,$2,$3,$4)`,
        [id_persona, t.telefono, t.tipo || null, t.principal ?? false]
      );
    }

    // -------------------------
    // PAREJAS + HIJOS
    // -------------------------
    const parejaMap = new Map();

    for (const p of parejas) {
      const periodo = normalizePeriodo(p?.periodo);
      const tieneAlgo = p?.nombre_pareja || p?.tipo_relacion || periodo;
      if (!tieneAlgo) continue;

      if (periodo && !isPeriodoValido(periodo)) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "Formato de periodo inválido en parejas. Usa AAAA o AAAA-AAAA",
          detail: { temp_id: p?.temp_id || null, periodo }
        });
      }
      const idRelSent = p?.id_relacion_sentimental ? Number(p.id_relacion_sentimental) : null;
      const { rows } = await client.query(
        `INSERT INTO parejas (id_persona, nombre_pareja, tipo_relacion, periodo, id_relacion_sentimental)
        VALUES ($1,$2,$3,$4,$5)
        RETURNING id_pareja`,
        [
          id_persona,
          p.nombre_pareja || null,
          p.tipo_relacion || null,
          periodo || null,
          Number.isFinite(idRelSent) ? idRelSent : null
        ]
      );

      if (p.temp_id) parejaMap.set(p.temp_id, rows[0].id_pareja);
    }

    for (const h of (hijos || [])) {
      // 1) si ya viene id_pareja REAL (por ejemplo edición), úsalo
      const idParejaReal = Number(h?.id_pareja);
      const tieneIdParejaReal = Number.isFinite(idParejaReal) && idParejaReal > 0;

      // 2) si viene pareja_temp_id, convertir usando el mapa temp_id -> id_pareja real
      const tempKey = (h?.pareja_temp_id ?? h?.id_pareja ?? "").toString().trim(); 
      // ^ dejo h.id_pareja como fallback por compat (si en front mandas temp ahí)

      const idParejaFromMap = tempKey ? parejaMap.get(tempKey) : null;

      // ✅ id_pareja final (real > map > null)
      const id_pareja_final = tieneIdParejaReal
        ? idParejaReal
        : (Number.isFinite(idParejaFromMap) ? idParejaFromMap : null);

      const nombre_completo = (h?.nombre_completo || "").toString().trim() || null;

      const aniosNum = (h?.anios === "" || h?.anios === null || h?.anios === undefined)
        ? null
        : Number(h.anios);

      const anios = Number.isFinite(aniosNum) ? aniosNum : null;

      await client.query(
        `
        INSERT INTO hijos (id_persona, id_pareja, nombre_completo, anios, sexo)
        VALUES ($1,$2,$3,$4,$5)
        `,
        [
          id_persona,
          id_pareja_final,          // ✅ aquí ya no rompe FK
          nombre_completo,
          anios,
          (h?.sexo || null)
        ]
      );
    }

    // -------------------------
    // REDES
    // -------------------------
    for (const r of redes) {
      if (!r?.id_red) continue;
      await client.query(
        `INSERT INTO redes_sociales_persona (id_persona, id_red, url) VALUES ($1,$2,$3)`,
        [id_persona, r.id_red, r.url || null]
      );
    }

    // -------------------------
    // SERVICIO PUBLICO
    // -------------------------
    for (const s of servicio_publico) {
      const tieneAlgo = s?.periodo || s?.cargo || s?.dependencia;
      if (!tieneAlgo) continue;
      await client.query(
        `INSERT INTO servicio_publico (id_persona, periodo, cargo, dependencia) VALUES ($1,$2,$3,$4)`,
        [id_persona, s.periodo || null, s.cargo || null, s.dependencia || null]
      );
    }

    // -------------------------
    // ELECCIONES
    // -------------------------
    for (const e of elecciones) {
      const tieneAlgo =
        e?.anio_eleccion || e?.candidatura || e?.partido_postulacion || e?.resultado ||
        e?.diferencia_votos || e?.diferencia_porcentaje;
      if (!tieneAlgo) continue;

      await client.query(
        `INSERT INTO elecciones_contendidas
          (id_persona, anio_eleccion, candidatura, partido_postulacion, resultado, diferencia_votos, diferencia_porcentaje)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          id_persona,
          e.anio_eleccion || null,
          e.candidatura || null,
          e.partido_postulacion || null,
          e.resultado || null,
          e.diferencia_votos || null,
          e.diferencia_porcentaje || null
        ]
      );
    }

    // -------------------------
    // EVENTOS MOVILIZACIÓN (0..10 fotos) ✅ tabla hija
    // -------------------------
    function normalizeUrl(u) {
      const s = (u || "").toString().trim();
      return s || null;
    }

    function normalizeFotos(arr, max = 10) {
      const list = Array.isArray(arr) ? arr : [];
      const seen = new Set();
      const out = [];
      for (const x of list) {
        const url = normalizeUrl(x);
        if (!url) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        out.push(url);
        if (out.length >= max) break;
      }
      return out;
    }

    for (const ev of capacidad_movilizacion_eventos) {
      const nombre = (ev?.nombre_evento || "").toString().trim();
      const fecha = ev?.fecha_evento || null;
      const asistencia =
        ev?.asistencia === "" || ev?.asistencia == null ? null : Number(ev.asistencia);

      const lugar = (ev?.lugar_evento || "").toString().trim() || null;
      const fotos = normalizeFotos(ev?.fotos, 10);

      // si no hay nada, saltar
      if (!nombre && !fecha && asistencia == null && !lugar && fotos.length === 0) continue;

      if (!nombre || !fecha || asistencia == null || Number.isNaN(asistencia)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Cada evento requiere nombre_evento, fecha_evento y asistencia" });
      }
      if (asistencia < 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "La asistencia no puede ser negativa" });
      }

      // límite 10 (por si mandan más en raw)
      if (Array.isArray(ev?.fotos) && normalizeFotos(ev.fotos, 999).length > 10) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Máximo 10 fotos por evento" });
      }

      const { rows } = await client.query(
        `
        INSERT INTO capacidad_movilizacion_eventos
          (id_persona, nombre_evento, fecha_evento, asistencia, lugar_evento)
        VALUES ($1,$2,$3,$4,$5)
        RETURNING id_evento
        `,
        [id_persona, nombre, fecha, asistencia, lugar]
      );

      const id_evento = rows[0].id_evento;

      for (const url of fotos) {
        await client.query(
          `INSERT INTO capacidad_movilizacion_eventos_fotos (id_evento, foto_url) VALUES ($1,$2)`,
          [id_evento, url]
        );
      }
    }

    // -------------------------
    // EQUIPOS
    // -------------------------
    for (const eq of equipos) {
      const tieneAlgo = eq?.nombre_equipo || eq?.activo !== undefined;
      if (!tieneAlgo) continue;

      await client.query(
        `INSERT INTO equipos_politicos (id_persona, nombre_equipo, activo) VALUES ($1,$2,$3)`,
        [id_persona, eq.nombre_equipo || null, eq.activo ?? true]
      );
    }

    // -------------------------
    // REFERENTES
    // -------------------------
    for (const ref of referentes) {
      const tieneAlgo = ref?.nivel || ref?.nombres || ref?.apellido_paterno || ref?.apellido_materno;
      if (!tieneAlgo) continue;

      await client.query(
        `INSERT INTO referentes_politicos (id_persona, nivel, nombres, apellido_paterno, apellido_materno, cargo)
          VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          id_persona,
          ref.nivel || null,
          ref.nombres || null,
          ref.apellido_paterno || null,
          ref.apellido_materno || null,
          ref.cargo || null
        ]
      );
    }

    // -------------------------
    // CONTROVERSIAS (si no sinControversias)
    // -------------------------
    const sinControversias = persona.sin_controversias_publicas === true;
    if (!sinControversias) {
      for (const c of controversias) {
        const tieneAlgo = c?.id_tipo || c?.descripcion || c?.fuente || c?.fecha_registro || c?.estatus;
        if (!tieneAlgo) continue;

        // OJO: si fecha_registro es AAAA / AAAA-AAAA, valida así (si es date real, cambia esta regla)
        if (c.fecha_registro && !isPeriodoValido(c.fecha_registro)) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Formato inválido en controversia. Usa AAAA o AAAA-AAAA" });
        }

        await client.query(
          `INSERT INTO controversias_persona (id_persona, id_tipo, descripcion, fuente, fecha_registro, estatus)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            id_persona,
            c.id_tipo,
            c.descripcion || null,
            c.fuente || null,
            c.fecha_registro || null,
            c.estatus || null
          ]
        );
      }
    }

    // -------------------------
    // FAMILIARES
    // -------------------------
    for (const f of familiares) {

      const tieneAlgo =
        f?.nombre ||
        f?.parentesco ||
        f?.cargo ||
        f?.institucion ||
        f?.id_partido_politico ||
        f?.otro_partido_texto;

      if (!tieneAlgo) continue;

      await client.query(
        `
        INSERT INTO familiares_politica (
          id_persona,
          nombre,
          parentesco,
          cargo,
          institucion,
          id_partido_politico,
          otro_partido_texto
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        `,
        [
          id_persona,
          f.nombre || null,
          f.parentesco || null,
          f.cargo || null,
          f.institucion || null,
          Number(f.id_partido_politico || 0) || null,
          f.otro_partido_texto || null
        ]
      );
    }

    // -------------------------
    // PARTICIPACIÓN ORGANIZACIONES
    // -------------------------
    for (const po of participacion_organizaciones) {
      const tieneAlgo = po?.tipo || po?.nombre || po?.rol || po?.periodo || po?.notas;
      if (!tieneAlgo) continue;

      if (!po.nombre) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "participacion_organizaciones.nombre es obligatorio" });
      }

      await client.query(
        `INSERT INTO participacion_organizaciones (id_persona, tipo, nombre, rol, periodo, notas)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id_persona, po.tipo || "otro", po.nombre, po.rol || null, po.periodo || null, po.notas || null]
      );
    }

    // -------------------------
    // CARGOS ELECCIÓN POPULAR
    // -------------------------
    for (const c of (cargos_eleccion_popular || [])) {
      const idOrden = c?.id_orden_gobierno ? Number(c.id_orden_gobierno) : null;
      const idCargo = c?.id_cargo_catalogo ? Number(c.id_cargo_catalogo) : null;
      const idPart  = c?.id_partido_postulante ? Number(c.id_partido_postulante) : null;

      const es_suplente =
        c?.es_suplente === true ||
        String(c?.es_suplente).toLowerCase() === "true" ||
        Number(c?.es_suplente) === 1;

      const titular = (c?.titular_candidatura || "").toString().trim();

      const tieneAlgo =
        c?.periodo || c?.cargo || c?.partido_postulante || c?.modalidad ||
        idOrden || idCargo || idPart ||
        es_suplente || titular;

      if (!tieneAlgo) continue;

      // requeridos base
      if (!c.periodo || !Number.isFinite(idOrden) || !Number.isFinite(idCargo)) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "Cada cargo de elección popular requiere periodo, orden de gobierno y cargo"
        });
      }

      // modalidad
      const modalidad = c.modalidad ? String(c.modalidad).toLowerCase() : null;
      if (modalidad && !["mr", "rp", "pm"].includes(modalidad)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "modalidad inválida (mr|rp|pm)" });
      }

      // ✅ si es suplente, titular obligatorio
      if (es_suplente && !titular) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: 'Si "es_suplente" es true, "titular_candidatura" es obligatorio.'
        });
      }

      await client.query(
        `INSERT INTO cargos_eleccion_popular
          (id_persona, periodo, modalidad,
          id_orden_gobierno, id_cargo_catalogo, id_partido_postulante,
          cargo, partido_postulante,
          es_suplente, titular_candidatura)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id_persona,
          c.periodo || null,
          modalidad,
          idOrden,
          idCargo,
          Number.isFinite(idPart) ? idPart : null,
          c.cargo || null,               // legacy
          c.partido_postulante || null,  // legacy
          es_suplente,
          es_suplente ? (titular || null) : null
        ]
      );
    }


    // -------------------------
    // EXPERIENCIA LABORAL
    // -------------------------
    for (const ex of experiencia_laboral) {
      const tieneAlgo = ex?.periodo || ex?.cargo || ex?.organizacion;
      if (!tieneAlgo) continue;

      await client.query(
        `INSERT INTO experiencia_laboral (id_persona, periodo, cargo, organizacion)
         VALUES ($1,$2,$3,$4)`,
        [id_persona, ex.periodo || null, ex.cargo || null, ex.organizacion || null]
      );
    }

    // -------------------------
    // EMPRESAS
    // -------------------------
    for (const e of empresas_persona) {
      const nombre = (e?.nombre_empresa || "").trim();
      const rol = (e?.rol || "").trim();
      const rol_otro = (e?.rol_otro || "").trim();
      const nombre_relacionado = (e?.nombre_relacionado || "").trim();
      const relacion = (e?.relacion || "").trim();

      const periodo = normalizePeriodo(e?.periodo);
      const notas = (e?.notas || "").trim();

      const tieneAlgo =
        nombre || rol || rol_otro || nombre_relacionado || relacion || periodo || notas;
      if (!tieneAlgo) continue;

      if (!nombre) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Cada empresa requiere nombre_empresa" });
      }

      if (rol.toLowerCase() === "otro" && !rol_otro) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: 'Si el rol es "Otro", captura el rol (rol_otro).' });
      }

      if (periodo && !isPeriodoValido(periodo)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Formato inválido en empresa. Usa AAAA o AAAA-AAAA" });
      }

      await client.query(
        `INSERT INTO empresas_persona
          (id_persona, nombre_empresa, rol, rol_otro, nombre_relacionado, relacion, periodo, notas)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id_persona,
          nombre,
          rol || null,
          rol_otro || null,
          nombre_relacionado || null,
          relacion || null,
          periodo || null,
          notas || null
        ]
      );
    }

    // -------------------------
    // FUENTES CONSULTA (1:N UNIQUE por persona+fuente)
    // -------------------------
    await client.query(`DELETE FROM fuentes_persona WHERE id_persona = $1`, [id_persona]);

    for (const f of (fuentes_consulta || [])) {
      const id_fuente = Number(f?.id_fuente);
      const detalle = (f?.detalle || "").toString().trim() || null;
      const fecha_consulta = (f?.fecha_consulta || "").toString().trim() || null; // YYYY-MM-DD

      if (!Number.isFinite(id_fuente) || id_fuente <= 0) continue;

      const { rows: fr } = await client.query(
        `SELECT 1 FROM catalogo_fuentes_consulta WHERE id_fuente = $1 AND activo = true`,
        [id_fuente]
      );
      if (!fr[0]) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Fuente de consulta inválida" });
      }

      await client.query(
        `INSERT INTO fuentes_persona (id_persona, id_fuente, detalle, fecha_consulta)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (id_persona, id_fuente)
         DO UPDATE SET detalle = EXCLUDED.detalle, fecha_consulta = EXCLUDED.fecha_consulta`,
        [id_persona, id_fuente, detalle, fecha_consulta]
      );
    }

    // -------------------------
    // TRABAJO POLÍTICO EN VARIOS MUNICIPIOS
    // -------------------------
    const mt = Array.isArray(municipios_trabajo) ? municipios_trabajo : [];

    await client.query(`DELETE FROM personas_municipios_trabajo WHERE id_persona = $1`, [id_persona]);

    const principal = persona.municipio_trabajo_politico ? Number(persona.municipio_trabajo_politico) : null;
    const ids = new Set();

    for (const it of mt) {
      const id_municipio = Number(it?.id_municipio);
      if (!Number.isFinite(id_municipio) || id_municipio <= 0) continue;
      if (ids.has(id_municipio)) continue;
      ids.add(id_municipio);

      await client.query(
        `INSERT INTO personas_municipios_trabajo (id_persona, id_municipio, es_principal, notas)
         VALUES ($1,$2,$3,$4)`,
        [
          id_persona,
          id_municipio,
          principal === id_municipio,
          (it?.notas || "").toString().trim() || null
        ]
      );
    }

    if (principal && !ids.has(principal)) {
      await client.query(
        `INSERT INTO personas_municipios_trabajo (id_persona, id_municipio, es_principal)
         VALUES ($1,$2,true)
         ON CONFLICT (id_persona, id_municipio) DO UPDATE SET es_principal = true`,
        [id_persona, principal]
      );
    }
    // -------------------------
    // LIDERAZGO E INFLUENCIA
    // -------------------------
    const vLid = validateLiderazgo(liderazgo_influencia);
    if (!vLid.ok) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: vLid.error });
    }

    if (vLid.data) {
      const d = vLid.data;
      await client.query(
        `INSERT INTO liderazgo_influencia
          (id_persona, nivel, tipos, tipo_otro_texto, cuenta_con_estructura, presencia_territorial)
        VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          id_persona,
          d.nivel,
          d.tipos,                 // text[]
          d.tipo_otro_texto,
          d.cuenta_con_estructura,
          d.presencia_territorial
        ]
      );
    }

    // -------------------------
    // COMMIT
    // -------------------------
    await client.query("COMMIT");
    return res.status(201).json({ ok: true, id_persona });

  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);

    if (String(e.message).includes("datos_ine_id_persona_key")) {
      return res.status(409).json({ error: "Esta persona ya tiene datos INE" });
    }
    if (String(e.message).includes("personas_curp_key")) return res.status(409).json({ error: "CURP ya existe" });
    if (String(e.message).includes("personas_rfc_key")) return res.status(409).json({ error: "RFC ya existe" });

    return res.status(500).json({ error: "Error al crear persona", detail: e.message });
  } finally {
    client.release();
  }
};



// 3) PERFIL COMPLETO (usa tu query consolidado)
exports.getPerfilCompleto = async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "ID inválido" });
    }

    const { rows } = await client.query(
      `
      SELECT
        p.id_persona,
        p.nombre,
        p.apellido_paterno,
        p.apellido_materno,
        p.foto_url,
        p.id_oficina,
        p.creado_por,
        p.modificado_por,

        p.verificado_por,
        p.verificado_at,

        p.nivel_confiabilidad,

        p.res_legal_fuera_edomex,
        p.res_legal_estado_texto,
        p.res_legal_municipio_texto,

        p.res_real_fuera_edomex,
        p.res_real_estado_texto,
        p.res_real_municipio_texto,

        p.partido_otro_texto,

        -- Verificador
        u_ver.nombre AS verificado_por_nombre,
        u_ver.email  AS verificado_por_email,
        -- NUEVO
        u_crea.nombre  AS creado_por_nombre,
        u_mod.nombre   AS modificado_por_nombre,
        o.nombre       AS oficina_nombre,
        p.created_at,
        p.updated_at,

        p.curp,
        p.rfc,
        p.clave_elector,
        p.edad,
        p.estado_civil,
        p.escala_influencia,
        p.sin_servicio_publico,
        p.ha_contendido_eleccion,
        p.sin_controversias_publicas,

        p.id_partido_actual,
        p.id_tema_interes_central,
        p.tema_interes_otro_texto,
        p.id_grupo_postulacion,
        p.id_ideologia_politica,

        cp.nombre  AS partido_actual,
        cp.siglas  AS partido_actual_siglas,
        cti.nombre AS tema_interes_central,
        cgp.nombre AS grupo_postulacion,
        cip.nombre AS ideologia_politica,

        p.municipio_residencia_legal  AS municipio_residencia_legal_id,
        p.municipio_residencia_real   AS municipio_residencia_real_id,
        p.municipio_trabajo_politico  AS municipio_trabajo_politico_id,

        ml.nombre AS municipio_residencia_legal,
        mr.nombre AS municipio_residencia_real,
        mt.nombre AS municipio_trabajo_politico,

        CASE
          WHEN COALESCE(p.res_legal_fuera_edomex,false) THEN
            concat_ws(', ',
              NULLIF(trim(p.res_legal_municipio_texto), ''),
              NULLIF(trim(p.res_legal_estado_texto), '')
            )
          ELSE ml.nombre
        END AS residencia_legal_display,

        CASE
          WHEN COALESCE(p.res_real_fuera_edomex,false) THEN
            concat_ws(', ',
              NULLIF(trim(p.res_real_municipio_texto), ''),
              NULLIF(trim(p.res_real_estado_texto), '')
            )
          ELSE mr.nombre
        END AS residencia_real_display,

        -- DATOS INE (objeto)
        (
          SELECT CASE
            WHEN di.id_persona IS NULL THEN NULL
            ELSE jsonb_build_object(
              'seccion_electoral', di.seccion_electoral,
              'distrito_federal',  di.distrito_federal,
              'distrito_local',    di.distrito_local
            )
          END
          FROM datos_ine di
          WHERE di.id_persona = p.id_persona
          ORDER BY di.id_ine DESC
          LIMIT 1
        ) AS datos_ine,

        -- TELEFONOS
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_telefono', t.id_telefono,
              'telefono',    t.telefono,
              'tipo',        t.tipo,
              'principal',   t.principal
            )
            ORDER BY t.principal DESC, t.id_telefono ASC
          )
          FROM telefonos t
          WHERE t.id_persona = p.id_persona
        ), '[]'::jsonb) AS telefonos,

        -- FORMACION
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_formacion',   fa.id_formacion,
              'nivel',          fa.nivel,
              'grado',          fa.grado,
              'grado_obtenido', fa.grado_obtenido,
              'institucion',    fa.institucion,
              'anio_inicio',    fa.anio_inicio,
              'anio_fin',       fa.anio_fin,
              'titulado',       fa.titulado,
              'cedula_profesional', fa.cedula_profesional
            )
            ORDER BY fa.id_formacion ASC
          )
          FROM formacion_academica fa
          WHERE fa.id_persona = p.id_persona
        ), '[]'::jsonb) AS formacion_academica,

        -- REDES
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_red', crs.id_red,
              'red',    crs.nombre,
              'url',    rsp.url
            )
            ORDER BY crs.nombre ASC
          )
          FROM redes_sociales_persona rsp
          JOIN catalogo_redes_sociales crs ON crs.id_red = rsp.id_red
          WHERE rsp.id_persona = p.id_persona
        ), '[]'::jsonb) AS redes_sociales,

        -- EMPRESAS

        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'nombre_empresa', e.nombre_empresa,
            'rol', e.rol,
            'rol_otro', e.rol_otro,
            'nombre_relacionado', e.nombre_relacionado,
            'relacion', e.relacion,
            'periodo', e.periodo,
            'notas', e.notas
          ) ORDER BY e.id_empresa_persona ASC)
          FROM empresas_persona e
          WHERE e.id_persona = p.id_persona
        ), '[]'::jsonb) AS empresas,

        -- PAREJAS + HIJOS anidados (usa "periodo" como en tu UI)
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_pareja',      pa.id_pareja,
              'nombre_pareja',  pa.nombre_pareja,
              'tipo_relacion',  pa.tipo_relacion,
              'periodo',        pa.periodo,
              'hijos', COALESCE((
                SELECT jsonb_agg(
                  jsonb_build_object(
                    'id_hijo',         h.id_hijo,
                    'anio_nacimiento', h.anio_nacimiento,
                    'anios',           h.anios,
                    'sexo',            h.sexo
                  )
                  ORDER BY h.id_hijo ASC
                )
                FROM hijos h
                WHERE h.id_persona = p.id_persona
                  AND h.id_pareja = pa.id_pareja
              ), '[]'::jsonb)
            )
            ORDER BY pa.id_pareja ASC
          )
          FROM parejas pa
          WHERE pa.id_persona = p.id_persona
        ), '[]'::jsonb) AS parejas,

        -- SERVICIO PUBLICO
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_servicio', sp.id_servicio,
              'periodo',     sp.periodo,
              'cargo',       sp.cargo,
              'dependencia', sp.dependencia
            )
            ORDER BY sp.id_servicio ASC
          )
          FROM servicio_publico sp
          WHERE sp.id_persona = p.id_persona
        ), '[]'::jsonb) AS servicio_publico,

        -- ELECCIONES
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_eleccion',            ec.id_eleccion,
              'anio_eleccion',          ec.anio_eleccion,
              'candidatura',            ec.candidatura,
              'partido_postulacion',    ec.partido_postulacion,
              'resultado',              ec.resultado,
              'diferencia_votos',       ec.diferencia_votos,
              'diferencia_porcentaje',  ec.diferencia_porcentaje
            )
            ORDER BY ec.anio_eleccion DESC NULLS LAST, ec.id_eleccion ASC
          )
          FROM elecciones_contendidas ec
          WHERE ec.id_persona = p.id_persona
        ), '[]'::jsonb) AS elecciones,

        -- CAPACIDAD MOVILIZACION EVENTOS (lista + fotos)
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_evento',      cme.id_evento,
              'nombre_evento',  cme.nombre_evento,
              'fecha_evento',   cme.fecha_evento,
              'asistencia',     cme.asistencia,
              'lugar_evento',   cme.lugar_evento,

              -- fotos 1:N por evento
              'fotos', COALESCE((
                SELECT jsonb_agg(f.foto_url ORDER BY f.id_foto ASC)
                FROM capacidad_movilizacion_eventos_fotos f
                WHERE f.id_evento = cme.id_evento
              ), '[]'::jsonb)
            )
            ORDER BY cme.fecha_evento DESC NULLS LAST, cme.id_evento ASC
          )
          FROM capacidad_movilizacion_eventos cme
          WHERE cme.id_persona = p.id_persona
        ), '[]'::jsonb) AS capacidad_movilizacion_eventos,

        -- EQUIPOS
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_equipo',     ep.id_equipo,
              'nombre_equipo', ep.nombre_equipo,
              'activo',        ep.activo
            )
            ORDER BY ep.activo DESC, ep.id_equipo ASC
          )
          FROM equipos_politicos ep
          WHERE ep.id_persona = p.id_persona
        ), '[]'::jsonb) AS equipos,

        -- REFERENTES
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_referente',     rp.id_referente,
              'nivel',            rp.nivel,
              'nombres',          rp.nombres,
              'apellido_paterno', rp.apellido_paterno,
              'apellido_materno', rp.apellido_materno,
              'cargo',            rp.cargo
            )
            ORDER BY rp.id_referente ASC
          )
          FROM referentes_politicos rp
          WHERE rp.id_persona = p.id_persona
        ), '[]'::jsonb) AS referentes,

        -- FAMILIARES
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_familiar', fp.id_familiar,
              'nombre',      fp.nombre,
              'parentesco',  fp.parentesco,
              'cargo',       fp.cargo,
              'institucion', fp.institucion,
              'id_partido_politico', fp.id_partido_politico,
              'partido_politico', cp_fam.nombre,
              'partido_politico_nombre', cp_fam.nombre,
              'partido_politico_siglas', cp_fam.siglas,
              'otro_partido_texto', fp.otro_partido_texto,
              'partido_display', COALESCE(
                NULLIF(TRIM(fp.otro_partido_texto), ''),
                NULLIF(TRIM(cp_fam.siglas), ''),
                cp_fam.nombre
              )
            )
            ORDER BY fp.id_familiar ASC
          )
          FROM familiares_politica fp
          LEFT JOIN catalogo_partidos cp_fam
            ON cp_fam.id_partido = fp.id_partido_politico
          WHERE fp.id_persona = p.id_persona
        ), '[]'::jsonb) AS familiares,

        -- PARTICIPACION
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_participacion', po.id_participacion,
              'tipo',             po.tipo,
              'nombre',           po.nombre,
              'rol',              po.rol,
              'periodo',          po.periodo,
              'notas',            po.notas
            )
            ORDER BY po.id_participacion ASC
          )
          FROM participacion_organizaciones po
          WHERE po.id_persona = p.id_persona
        ), '[]'::jsonb) AS participacion_organizaciones,

        -- TEMAS DE INTERES (lista con nombre)
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_tema', pti.id_tema,
              'tema',    cti2.nombre,
              'otro_texto', pti.otro_texto
            )
            ORDER BY cti2.nombre ASC NULLS LAST, pti.id_tema ASC
          )
          FROM personas_temas_interes pti
          LEFT JOIN catalogo_temas_interes cti2 ON cti2.id_tema = pti.id_tema
          WHERE pti.id_persona = p.id_persona
        ), '[]'::jsonb) AS temas_interes,

        -- CARGOS DE ELECCIÓN POPULAR (lista)
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_cargo_eleccion', cep.id_cargo_eleccion,
              'periodo', cep.periodo,
              'modalidad', cep.modalidad,

              'id_orden_gobierno', cep.id_orden_gobierno,
              'orden_gobierno', og.nombre,

              'id_cargo_catalogo', cep.id_cargo_catalogo,
              'cargo_catalogo', ce.nombre,

              'id_partido_postulante', cep.id_partido_postulante,
              'partido_postulante_catalogo', cp.nombre,
              'partido_postulante_siglas', cp.siglas,

              -- legacy (por si aún hay registros viejos)
              'cargo', cep.cargo,
              'partido_postulante', cep.partido_postulante,

              -- ✅ display final (prioriza catálogo, si no usa legacy)
              'cargo_display', COALESCE(ce.nombre, cep.cargo),
              'partido_display', COALESCE(cp.siglas, cp.nombre, cep.partido_postulante),

              'es_suplente', cep.es_suplente,
              'titular_candidatura', cep.titular_candidatura
            )
            ORDER BY
              -- ordena por periodo (cuando viene AAAA-AAAA o AAAA)
              NULLIF(split_part(cep.periodo,'-',1),'')::int DESC NULLS LAST,
              cep.id_cargo_eleccion ASC
          )
          FROM cargos_eleccion_popular cep
          LEFT JOIN catalogo_orden_gobierno og
            ON og.id_orden = cep.id_orden_gobierno
          LEFT JOIN catalogo_cargo_eleccion ce
            ON ce.id_orden = cep.id_orden_gobierno
          AND ce.id_cargo = cep.id_cargo_catalogo
          LEFT JOIN catalogo_partidos cp
            ON cp.id_partido = cep.id_partido_postulante
          WHERE cep.id_persona = p.id_persona
        ), '[]'::jsonb) AS cargos_eleccion_popular,

        -- EXPERIENCIA LABORAL (lista)
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_experiencia', el.id_experiencia,
              'periodo', el.periodo,
              'cargo', el.cargo,
              'organizacion', el.organizacion
            )
            ORDER BY el.id_experiencia ASC
          )
          FROM experiencia_laboral el
          WHERE el.id_persona = p.id_persona
        ), '[]'::jsonb) AS experiencia_laboral,

        -- CAPACIDAD MOVILIZACION EVENTOS (lista + fotos)
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_evento', cme.id_evento,
              'nombre_evento', cme.nombre_evento,
              'fecha_evento', cme.fecha_evento,
              'asistencia', cme.asistencia,
              'lugar_evento', cme.lugar_evento,
              'fotos', COALESCE((
                SELECT jsonb_agg(f.foto_url ORDER BY f.id_foto ASC)
                FROM capacidad_movilizacion_eventos_fotos f
                WHERE f.id_evento = cme.id_evento
              ), '[]'::jsonb)
            )
            ORDER BY cme.id_evento ASC
          )
          FROM capacidad_movilizacion_eventos cme
          WHERE cme.id_persona = p.id_persona
        ), '[]'::jsonb) AS capacidad_movilizacion_eventos,

        -- FUENTES CONSULTA
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_fuente_persona', fp.id_fuente_persona,
              'id_fuente',         fp.id_fuente,
              'fuente',            cfc.nombre,
              'detalle',           fp.detalle,
              'fecha_consulta',    fp.fecha_consulta
            )
            ORDER BY cfc.nombre ASC, fp.id_fuente_persona ASC
          )
          FROM fuentes_persona fp
          JOIN catalogo_fuentes_consulta cfc ON cfc.id_fuente = fp.id_fuente
          WHERE fp.id_persona = p.id_persona
        ), '[]'::jsonb) AS fuentes_consulta,

        -- MUNICIPIOS TRABAJO (lista)
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_municipio', pmt.id_municipio,
              'municipio',    m2.nombre,
              'es_principal', pmt.es_principal,
              'notas',        pmt.notas
            )
            ORDER BY pmt.es_principal DESC, m2.nombre ASC
          )
          FROM personas_municipios_trabajo pmt
          LEFT JOIN municipios m2 ON m2.id_municipio = pmt.id_municipio
          WHERE pmt.id_persona = p.id_persona
        ), '[]'::jsonb) AS municipios_trabajo,

        -- LIDERAZGO E INFLUENCIA (1:1)
        (
          SELECT CASE
            WHEN li.id_persona IS NULL THEN NULL
            ELSE jsonb_build_object(
              'nivel', li.nivel,
              'tipos', li.tipos,
              'tipo_otro_texto', li.tipo_otro_texto,
              'cuenta_con_estructura', li.cuenta_con_estructura,
              'presencia_territorial', li.presencia_territorial,
              'created_at', li.created_at,
              'updated_at', li.updated_at
            )
          END
          FROM liderazgo_influencia li
          WHERE li.id_persona = p.id_persona
        ) AS liderazgo_influencia,

        -- CONTROVERSIAS (condicional)
        CASE
          WHEN p.sin_controversias_publicas = true THEN '[]'::jsonb
          ELSE COALESCE((
            SELECT jsonb_agg(
              jsonb_build_object(
                'id_controversia', cper.id_controversia,
                'id_tipo',         cper.id_tipo,
                'tipo',            ccat.tipo,
                'descripcion',     cper.descripcion,
                'fuente',          cper.fuente,
                'fecha_registro',  cper.fecha_registro,
                'estatus',         cper.estatus
              )
              ORDER BY cper.id_controversia ASC
            )
            FROM controversias_persona cper
            LEFT JOIN catalogo_controversias ccat ON ccat.id_tipo = cper.id_tipo
            WHERE cper.id_persona = p.id_persona
          ), '[]'::jsonb)
        END AS controversias

      FROM personas p
      LEFT JOIN municipios ml ON ml.id_municipio = p.municipio_residencia_legal
      LEFT JOIN municipios mr ON mr.id_municipio = p.municipio_residencia_real
      LEFT JOIN municipios mt ON mt.id_municipio = p.municipio_trabajo_politico

      LEFT JOIN usuarios u_crea ON u_crea.id_usuario = p.creado_por
      LEFT JOIN usuarios u_mod  ON u_mod.id_usuario = p.modificado_por
      LEFT JOIN usuarios u_ver  ON u_ver.id_usuario  = p.verificado_por
      LEFT JOIN oficinas o      ON o.id_oficina = p.id_oficina

      LEFT JOIN catalogo_partidos cp            ON cp.id_partido   = p.id_partido_actual
      LEFT JOIN catalogo_temas_interes cti      ON cti.id_tema     = p.id_tema_interes_central
      LEFT JOIN catalogo_grupos_postulacion cgp ON cgp.id_grupo    = p.id_grupo_postulacion
      LEFT JOIN catalogo_ideologia_politica cip ON cip.id_ideologia = p.id_ideologia_politica

      WHERE p.id_persona = $1
      LIMIT 1
      `,
      [id]
    );

    if (!rows[0]) return res.status(404).json({ error: "Persona no encontrada" });

    // 🔒 seguridad capturista (solo sus registros)
    const roles = req.user?.roles || [];
    const isSuperadmin = roles.includes("superadmin");
    const isAnalista = roles.includes("analista");
    const isCapturista = roles.includes("capturista");

    const row = rows[0];

    // capturista puro: solo sus registros
    if (isCapturista && !isAnalista && !isSuperadmin) {
      const userId = Number(req.user.id_usuario || 0);
      if (Number(row.creado_por) !== userId) {
        return res.status(403).json({ error: "No autorizado" });
      }
    }

    // analista (no superadmin): solo su oficina
    if (isAnalista && !isSuperadmin) {
      const myOffice = Number(req.user.id_oficina || 0);
      if (!myOffice) return res.status(403).json({ error: "Usuario sin oficina asignada" });
      if (Number(row.id_oficina) !== myOffice) {
        return res.status(403).json({ error: "No autorizado" });
      }
    }

    return res.json(rows[0]);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Error al obtener perfil", detail: e.message });
  } finally {
    client.release();
  }
};



// 5. resumen por usuario

exports.resumenPersonasPorUsuario = async (req, res) => {
  try {

    const { rows } = await pool.query(`
      SELECT
        u.id_usuario,
        u.nombre,
        u.email,
        COALESCE(
          jsonb_agg(DISTINCT r.nombre) FILTER (WHERE r.nombre IS NOT NULL),
          '[]'::jsonb
        ) AS roles,
        COUNT(p.id_persona)::int AS total_registros,
        MAX(p.created_at) AS ultimo_registro
      FROM usuarios u
      LEFT JOIN usuarios_roles ur ON ur.id_usuario = u.id_usuario
      LEFT JOIN roles r ON r.id_rol = ur.id_rol
      LEFT JOIN personas p ON p.creado_por = u.id_usuario
      WHERE u.activo = true
      GROUP BY u.id_usuario, u.nombre, u.email
      ORDER BY total_registros DESC, u.nombre ASC
    `);

    return res.json(rows);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Error al generar resumen', detail: e.message });
  }
};

//pdf 
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

// ===================== helpers =====================

// Node 18+ ya trae fetch global. Si estás en Node <18:
// const fetch = require("node-fetch");


async function imageUrlToDataUri(url) {
  if (!url) return null;
  const s = String(url);

  // ya es data-uri
  if (s.startsWith("data:image/")) return s;

  // solo http(s)
  if (!/^https?:\/\//i.test(s)) return null;

  const r = await fetch(s, { redirect: "follow" });
  if (!r.ok) throw new Error(`No pude descargar imagen (${r.status})`);

  const ct = r.headers.get("content-type") || "image/png";
  const ab = await r.arrayBuffer();
  const b64 = Buffer.from(ab).toString("base64");
  return `data:${ct};base64,${b64}`;
}

const partidoIconCache = new Map();
const partidoIconDir = path.join(__dirname, "..", "..", "public", "assets", "partidos");

function normalizePartidoKey(v) {
  return String(v || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function partidoAssetKey(siglas, nombre) {
  const raw = [siglas, nombre].filter(Boolean).join(" ");
  const key = normalizePartidoKey(raw);

  if (!key) return "";
  if (/\b(morena|movimiento regeneracion nacional)\b/.test(key)) return "morena";
  if (/\bpan\b|accion nacional/.test(key)) return "pan";
  if (/\bpri\b|revolucionario institucional/.test(key)) return "pri";
  if (/\bprd\b|revolucion democratica/.test(key)) return "prd";
  if (/\bpt\b|partido del trabajo/.test(key)) return "pt";
  if (/\bpvem\b|verde ecologista|partido verde/.test(key)) return "pvem";
  if (/\bmc\b|movimiento ciudadano/.test(key)) return "mc";

  return "";
}

function partidoIconDataUri(siglas, nombre) {
  const assetKey = partidoAssetKey(siglas, nombre);
  if (!assetKey) return "";
  if (partidoIconCache.has(assetKey)) return partidoIconCache.get(assetKey);

  const filePath = path.join(partidoIconDir, `${assetKey}.png`);
  try {
    const b64 = fs.readFileSync(filePath).toString("base64");
    const dataUri = `data:image/png;base64,${b64}`;
    partidoIconCache.set(assetKey, dataUri);
    return dataUri;
  } catch (e) {
    console.warn("Icono de partido no disponible para PDF:", assetKey, e.message);
    partidoIconCache.set(assetKey, "");
    return "";
  }
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escAttr(s) {
  // para atributos HTML (src, alt, etc.)
  return String(s ?? "").replace(/"/g, "&quot;");
}

function fmtDate(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString("es-MX", { timeZone: "America/Mexico_City" });
}

function joinFullName(p) {
  return [p.nombre, p.apellido_paterno, p.apellido_materno].filter(Boolean).join(" ");
}

function sanitizePdfFilenamePart(v) {
  return String(v || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_")
    .slice(0, 80);
}

function buildPerfilPdfFilename(p) {
  const id = sanitizePdfFilenamePart(p.id_persona) || "perfil";
  const nombre = sanitizePdfFilenamePart(joinFullName(p)) || "sin_nombre";
  const municipioPrincipal = asArray(p.municipios_trabajo)
    .find(m => m?.es_principal === true || m?.es_principal === "true" || m?.es_principal === 1)
    ?.municipio;
  const municipio = sanitizePdfFilenamePart(municipioPrincipal);

  return `${[id, nombre, municipio].filter(Boolean).join("_")}.pdf`;
}

function badge(text, cls = "") {
  if (!text) return "";
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}

function asArray(x) {
  return Array.isArray(x) ? x : [];
}

function listSection(title, arr, renderItem) {
  const items = asArray(arr);
  if (!items.length) return "";
  return `
    <section class="section">
      <div class="h2">${esc(title)}</div>
      <div class="grid">
        ${items.map(renderItem).join("")}
      </div>
    </section>
  `;
}

function titleCaseEs(s) {
  const t = String(s ?? "").trim();
  if (!t) return "";
  return t
    .toLowerCase()
    .split(/\s+/g)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function normalizeTipoEnum(tipo) {
  // "organizacion_politica" -> "Organización política"
  const raw = String(tipo ?? "").trim();
  if (!raw) return "";
  const spaced = raw.replace(/_/g, " ").toLowerCase();
  // accents simples
  const map = {
    "organizacion politica": "Organización política",
    "organizacion social": "Organización social",
    "organizacion civil": "Organización civil",
    "partido": "Partido",
    "partidos": "Partido",
  };
  return map[spaced] || (spaced.charAt(0).toUpperCase() + spaced.slice(1));
}

function parseLiderazgoTipos(tipos) {
  const arr = asArray(tipos)
    .map(x => String(x ?? "").trim())
    .filter(Boolean);

  if (!arr.length) return [];

  const map = {
    territorial: "Territorial",
    politico_institucional: "Político institucional",
    social_comunitario: "Social comunitario",
    mediatico: "Mediático",
    tecnico_especializado: "Técnico especializado",
    economico_empresarial: "Económico empresarial",
  };

  return arr.map(k => map[k] || titleCaseEs(k.replace(/_/g, " ")));
}

function confiabilidadInfo(nivel) {
  const v = String(nivel ?? "").trim().toLowerCase();
  if (v === "alto")  return { label: "Alto (Confiable)", cls: "ok" };
  if (v === "medio") return { label: "Medio (Parcial)", cls: "warn" };
  if (v === "bajo")  return { label: "Bajo (Por confirmar)", cls: "bad" };
  if (v) return { label: `Confiabilidad: ${titleCaseEs(v)}`, cls: "mut" };
  return null;
}

// ===================== buildPerfilHtml (ACTUALIZADO) =====================

function buildPerfilHtml(p) {
  const nombreCompleto = joinFullName(p) || "—";
  const partido = p.partido_actual_siglas || p.partido_actual || "";
  const municipioTop =
    p.municipio_trabajo_politico ||
    p.residencia_real_display ||
    p.municipio_residencia_real ||
    p.residencia_legal_display ||
    p.municipio_residencia_legal ||
    "—";

  const foto = p.foto_url ? String(p.foto_url) : "";

  const munLegal = p.residencia_legal_display || p.municipio_residencia_legal || "—";
  const munReal  = p.residencia_real_display  || p.municipio_residencia_real  || "—";
  const munTrab  = p.municipio_trabajo_politico || "—";

  const confi = confiabilidadInfo(p.nivel_confiabilidad);
  const escalaInfl = p.escala_influencia ? titleCaseEs(p.escala_influencia) : "";

  const flags = [
    p.sin_servicio_publico === true ? badge("Sin servicio público", "sec") : "",
    p.ha_contendido_eleccion === true ? badge("Ha contendido elección", "prim") : "",
    p.sin_controversias_publicas === true ? badge("Sin controversias", "ok") : "",
  ].filter(Boolean).join("");

  const li = p.liderazgo_influencia || null;
  const liNivel = li?.nivel ? titleCaseEs(li.nivel) : "";
  const liTipos = parseLiderazgoTipos(li?.tipos);
  const liPres  = li?.presencia_territorial ? titleCaseEs(li.presencia_territorial) : "";
  const liEstructura =
    li?.cuenta_con_estructura === true ? "Sí" :
    li?.cuenta_con_estructura === false ? "No" : "";

  function parseResultado(raw) {
    if (!raw) return "—";
    const map = {
      "no_ganada": "No ganada",
      "ganada": "Ganada",
      "pendiente": "Pendiente",
      "impugnada": "Impugnada",
      "cancelada": "Cancelada"
    };
    return map[raw] || raw.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  }
  //grupos de postulacion
  const gruposPostulacion = Array.isArray(p.grupos_postulacion) ? p.grupos_postulacion : [];
  const gruposPostulacionNombres = gruposPostulacion
    .map(x => (x?.nombre || "").toString().trim())
    .filter(Boolean);

  const grupoPostulacionTexto = gruposPostulacionNombres.length
    ? gruposPostulacionNombres.join(", ")
    : (p.grupo_postulacion || "");

  const municipiosTrabajo = asArray(p.municipios_trabajo);

  const partidoColors = {
    "MORENA": "morena",
    "PAN": "pan",
    "PRI": "pri",
    "PVEM": "pvem",
    "PT": "pt",
    "MC": "mc",
    "PRD": "prd",
    "OTRO": "otro",
    "IND": "ind"
  };

  const bannerDecorativo = ""; // aquí puedes insertar un dataURL generado con canvas si luego quieres

function renderSectionHead(title) {
  return `
      <div class="section-head keep-together">
        <div class="timeline-axis">
          <div class="timeline-dot"></div>
          <div class="timeline-horizontal-line"></div>
        </div>
        
        <div class="section-title-container">
          <div class="section-title">${esc(title)}</div>
        </div>
      </div>
  `;
}

function renderSection(title, content, extraClass = "") {
  if (!content || !String(content).trim()) return "";
  return `
    <section class="section ${extraClass}">
      ${renderSectionHead(title)}
      <div class="section-body">
        ${content}
      </div>
    </section>
  `;
}

function renderListSection(title, items, renderItem, opts = {}) {
  const arr = Array.isArray(items) ? items : [];
  if (!arr.length) return "";

  // Agregamos avoid-break a cada item individual de la lista
  const itemClass = opts.long ? "item" : "item avoid-break";
  const itemStyle = "margin-bottom: 6px; break-inside: avoid; page-break-inside: avoid;";
  const renderedItems = arr.map(it => `
    <div class="${itemClass}" style="${itemStyle}">
      ${renderItem(it)}
    </div>
  `);

  return renderSection(title, renderedItems.join(""), opts.long ? "section-long" : "");
}
  const htmlDatosGenerales = `
    <div class="kv">
      <div class="k">CURP</div><div class="v mono">${esc(p.curp || "—")}</div>
      <div class="k">RFC</div><div class="v mono">${esc(p.rfc || "—")}</div>
      <div class="k">Clave elector</div><div class="v mono">${esc(p.clave_elector || "—")}</div>
      <div class="k">Estado civil</div><div class="v">${esc(p.estado_civil || "—")}</div>
      <div class="k">Edad</div><div class="v">${esc(p.edad != null && p.edad !== "" ? `${p.edad} a\u00f1os` : "Sin especificar")}</div>
      <div class="k">Residencia legal</div><div class="v">${esc(munLegal)}</div>
      <div class="k">Residencia real</div><div class="v">${esc(munReal)}</div>
      <div class="k">Municipio trabajo</div><div class="v">${esc(munTrab)}</div>
      <div class="k">Acción afirmativa aplicable</div><div class="v">${esc(grupoPostulacionTexto || "—")}</div>
    </div>
  `;

  const htmlINE = `
    <div class="kv">
      <div class="k">Sección</div><div class="v">${esc(p?.datos_ine?.seccion_electoral || "—")}</div>
      <div class="k">Distrito federal</div><div class="v">${esc(p?.datos_ine?.distrito_federal || "—")}</div>
      <div class="k">Distrito local</div><div class="v">${esc(p?.datos_ine?.distrito_local || "—")}</div>
    </div>
  `;

  const partidoActualNombre = p.partido_actual || "";
  const partidoActualSiglas = p.partido_actual_siglas || "";
  const partidoOtroTexto = p.partido_otro_texto || "";
  const partidoActualDisplay = [partidoActualSiglas, partidoActualNombre]
    .filter(Boolean)
    .join(" - ");
  const partidoActualIcon = partidoIconDataUri(partidoActualSiglas, partidoActualNombre);

  const htmlPartidoActual = `
    <div class="kv">
      <div class="k">Partido</div><div class="v">${esc(partidoActualDisplay || partidoOtroTexto || "â€”")}</div>
      <div class="k">Siglas</div><div class="v">${esc(partidoActualSiglas || "â€”")}</div>
      ${partidoOtroTexto ? `<div class="k">Otro partido</div><div class="v">${esc(partidoOtroTexto)}</div>` : ``}
    </div>
  `;

  const htmlPartidoActualLogo = `
    <div class="partido-card">
      <div class="partido-logo-box">
        ${partidoActualIcon
          ? `<img class="partido-logo" src="${escAttr(partidoActualIcon)}" alt="${escAttr(partidoActualSiglas || partidoActualNombre || "Partido político")}"/>`
          : `<div class="partido-logo-empty">${esc(partidoActualSiglas || "SP")}</div>`}
      </div>
      <div class="partido-info">
        <div class="k">Partido político actual</div>
        <div class="partido-name">${esc(partidoActualDisplay || partidoOtroTexto || "Sin registro")}</div>
        ${partidoOtroTexto ? `<div class="m">Otro partido: ${esc(partidoOtroTexto)}</div>` : ``}
      </div>
    </div>
  `;

  const htmlLiderazgo = li ? `
    <div class="kv">
      <div class="k">Nivel</div><div class="v">${esc(liNivel || "—")}</div>
      <div class="k">Tipos</div><div class="v">${esc(liTipos.length ? liTipos.join(", ") : "—")}</div>
      <div class="k">Presencia territorial</div><div class="v">${esc(liPres || "—")}</div>
      <div class="k">Estructura</div><div class="v">${esc(liEstructura || "—")}</div>
      ${li?.tipo_otro_texto ? `<div class="k">Otro</div><div class="v">${esc(li.tipo_otro_texto)}</div>` : ``}
    </div>
  ` : "";


  const htmlControversias = p.sin_controversias_publicas === true
    ? `
      <div class="item avoid-break">
        <div class="t">Sin controversias públicas</div>
        <div class="m">El registro fue marcado explícitamente como libre de controversias públicas.</div>
      </div>
    `
    : (Array.isArray(p.controversias) && p.controversias.length
      ? p.controversias.map(c => `
          <div class="item avoid-break">
            <div class="t">${esc(c.tipo || ("Tipo #" + (c.id_tipo ?? "—")))}</div>
            <div class="m">${esc([c.estatus, c.fecha_registro].filter(Boolean).join(" • ") || "")}</div>
            ${c.fuente ? `<div class="m">Fuente: ${esc(c.fuente)}</div>` : ``}
            ${c.descripcion ? `<div class="m">${esc(c.descripcion)}</div>` : ``}
          </div>
        `).join("")
      : "");

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Perfil - ${esc(nombreCompleto)}</title>
<style>
  /* 1. CONFIGURACIÓN DE PÁGINA Y VARIABLES */
  @page { 
    size: A4; 
    margin: 0mm 0mm 20mm 0mm; 
    @bottom-right {
      content: "Pág. " counter(page) " de " counter(pages);
      font-family: 'Arial', sans-serif;
      font-size: 9pt;
      color: #8b2136;
      padding-right: 40px;
      padding-bottom: 20px;
    }
  }

  :root {
    --gob-guinda: #8b2136;
    --gob-oro: #b89056;
    --gob-oro-claro: #d4c19c;
    --linea-tiempo: #d4c19c;
    --text-dark: #4a4a4a;
  }

  body {
    font-family: 'Montserrat', sans-serif;
    margin: 0;
    padding: 0;
    color: var(--text-dark);
    background-color: #fff;
    font-size: 12px;
    line-height: 1.2;
  }

  * {
    box-sizing: border-box;
  }

  img {
    display: block;
    max-width: 100%;
  }

  .sheet {
    position: relative;
    padding: 0px 40px 0px 100px;
  }

  .sheet::before {
    content: "";
    position: fixed; 
    top: 0;
    left: 60px;
    width: 35px;
    height: 100%;
    background-color: var(--gob-oro-claro);
    opacity: 0.6;
    z-index: -1;
  }

  /* 2. BANNER */
  .header-logos-banner {
    background-color: var(--gob-guinda);
    height: 55px;
    margin: 0mm -40px 30px -100px; 
    display: flex;
    justify-content: flex-end;
    align-items: center;
    padding-right: 30px;
    position: relative;
    z-index: 2;
  }

  .header-logos-banner img {
    height: 40px;
    width: auto;
    object-fit: contain;
  }

  /* 4. SECCIONES Y CONTROL DE SALTO (MODIFICADO) */
  .section {
    position: relative;
    margin-bottom: 18px;
    /* Evita que la sección se parta justo en el título */
    break-inside: avoid;
    page-break-inside: avoid;
  }

  /* Contenedor sugerido para envolver Título + Primer bloque de datos */
  .keep-together {
    break-inside: avoid;
    page-break-inside: avoid;
    display: block;
  }

  .section-head {
    break-after: avoid;
    page-break-after: avoid;
    break-inside: avoid;
    page-break-inside: avoid;
  }

  .section-start {
    break-inside: avoid;
    page-break-inside: avoid;
  }

  .section-body-continuation {
    margin-top: 0;
  }

  .section-header {
    display: flex;
    align-items: center;
    position: relative;
    height: 30px;
    /* No permite que el título sea lo último de la página */
    break-after: avoid;
    page-break-after: avoid;
  }

  .timeline-axis {
    position: relative;
    height: 20px; 
    display: flex;
    align-items: center;
    margin-left: -100px; 
    width: calc(100% + 100px);
  }

  .timeline-dot {
    width: 18px;
    height: 18px;
    background-color: #fff;
    border: 2px solid #B89056; 
    border-radius: 50%;
    z-index: 10;
    position: absolute;
    left: 59px; 
  }

  .timeline-horizontal-line {
    position: absolute;
    left: 68px; 
    right: 0;
    height: 1.5px;
    background-color: #B89056;
    z-index: 5;
  }

  .section-title {
    font-family: 'Arial Black', sans-serif;
    font-size: 11px;
    color: #8B2136;
    text-transform: uppercase;
    font-weight: bold;
    /* Alineado con el cuerpo */
    margin-left: 120px;
    margin-top: 5px;
  }

  .section-body {
    margin-left: 120px;
    margin-top: 6px;
    font-size: 12px;
    line-height: 1.32;
    text-align: justify;
    break-before: avoid;
    page-break-before: avoid;
    /* Ayuda a que si empieza, intente no dejar líneas sueltas */
    orphans: 3;
    widows: 3;
  }

  .section-long .section-body {
    break-inside: avoid;
    page-break-inside: avoid;
  }

  .section-long .item {
    break-inside: avoid;
    page-break-inside: avoid;
  }

  /* 5. DATOS Y FOTOS */
  .top {
    break-inside: avoid;
    page-break-inside: avoid;
    margin-bottom: 16px;
  }

  .perfil-header-container {
    display: flex;
    align-items: center;
    gap: 18px;
    min-height: 150px;
  }

  .header-info {
    min-width: 0;
    flex: 1;
  }

  .name-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }

  .h1 {
    margin: 0 0 6px 0;
    font-family: Arial, sans-serif;
    font-size: 22px;
    line-height: 1.08;
    font-weight: 800;
    letter-spacing: 0;
    word-break: break-word;
    flex: 1;
  }

  .confiabilidad-badge {
    flex: 0 0 auto;
    border-radius: 999px;
    padding: 5px 9px;
    font-size: 9px;
    line-height: 1;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0;
    border: 1px solid #d1d5db;
    white-space: nowrap;
    margin-top: 2px;
  }

  .confiabilidad-badge.ok {
    color: #166534;
    background: #dcfce7;
    border-color: #86efac;
  }

  .confiabilidad-badge.warn {
    color: #854d0e;
    background: #fef3c7;
    border-color: #facc15;
  }

  .confiabilidad-badge.bad {
    color: #991b1b;
    background: #fee2e2;
    border-color: #fca5a5;
  }

  .confiabilidad-badge.mut {
    color: #4b5563;
    background: #f3f4f6;
    border-color: #d1d5db;
  }

  .sub {
    color: #6b7280;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0;
  }

  .kv {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
    margin-top: 5px;
    /* Evita que un bloque de datos (K/V) se parta a la mitad */
    break-inside: avoid;
  }

  .k { font-size: 9px; color: #888; text-transform: uppercase; margin-bottom: 1px; }
  .v { border-bottom: 1px solid #eee; padding-bottom: 1px; min-height: 13px; margin-bottom: 3px; font-weight: 500; text-align: justify; }

  .partido-card {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 58px;
    break-inside: avoid;
    page-break-inside: avoid;
  }

  .partido-logo-box {
    width: 56px;
    height: 56px;
    flex: 0 0 56px;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    background: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    padding: 5px;
  }

  .partido-logo {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .partido-logo-empty {
    color: #8B2136;
    font-size: 13px;
    font-weight: 800;
    text-align: center;
  }

  .partido-info {
    min-width: 0;
    flex: 1;
  }

  .partido-name {
    font-size: 13px;
    font-weight: 800;
    color: #4a4a4a;
    line-height: 1.2;
    text-align: left;
  }

  .photo-frame {
    width: 110px; height: 140px;
    border: 2px solid var(--gob-oro);
    border-radius: 4px;
    background-color: #f3f4f6;
    overflow: hidden;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 2px 2px 5px rgba(0,0,0,0.1);
    /* No separar la foto del header */
    break-inside: avoid;
  }

  .photo-frame img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center top;
  }

  .no-photo {
    color: #9ca3af;
    font-size: 10px;
    letter-spacing: 0;
    text-align: center;
  }

  .photos-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    column-gap: 10px;
    row-gap: 4px;
    margin-top: 8px;
    width: 100%;
    break-inside: avoid;
    page-break-inside: avoid;
  }

  .photo-item {
    width: 100%;
    aspect-ratio: 4 / 3;
    max-height: 112px;
    border: 1px solid #e5e7eb;
    border-radius: 4px;
    background: #f8fafc;
    overflow: hidden;
    break-inside: avoid;
    page-break-inside: avoid;
  }

  .photo-item img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    object-position: center center;
  }

  .item {
    break-inside: avoid;
    page-break-inside: avoid;
  }

  .t {
    margin-bottom: 2px;
    font-weight: 700;
    text-align: left;
  }

  .m {
    margin-bottom: 1px;
    color: #6b7280;
    text-align: justify;
  }

  .section-long .item {
    break-inside: avoid;
    page-break-inside: avoid;
  }

  /* Tablas */
  table.trayectoria { width: 100%; border-collapse: collapse; }
  table tr { break-inside: avoid; }
  .force-page-break { break-before: page; }
</style>
</head>
<body>
  <div class="sheet">

  <!-- Franja de logotipos superior -->
  <div class="header-logos-banner">
    <img src="https://lh3.googleusercontent.com/d/18fNmkOjp0_asak96yPafw9ncyaEc7u6N=s550" />
  </div>

    ${bannerDecorativo ? `
      <div class="hero-banner avoid-break">
        <img src="${escAttr(bannerDecorativo)}" alt="Encabezado decorativo"/>
      </div>
    ` : ""}

    <div class="top">
      <div class="perfil-header-container">
        <div class="photo-frame">
          ${foto ? `<img src="${escAttr(foto)}" />` : `<div class="no-photo">SIN FOTO</div>`}
        </div>
        
        <div class="header-info">
          <div class="name-row">
            <h1 class="h1" style="color: var(--gob-guinda);">${esc(nombreCompleto)}</h1>
            ${confi ? `<div class="confiabilidad-badge ${escAttr(confi.cls)}">${esc(confi.label)}</div>` : ""}
          </div>
          <div class="sub">${esc(municipioTop)}</div>
        </div>
      </div>
    </div>
    ${renderSection("Datos generales", htmlDatosGenerales)}
    ${renderSection("INE", htmlINE)}
    ${renderSection("Partido político actual", htmlPartidoActualLogo)}

    ${municipiosTrabajo.length ? renderSection("Municipios de trabajo", `
      <div class="municipios-grid">
        ${municipiosTrabajo.map(m => `
          <div class="municipio-card avoid-break">
            <div class="municipio-head">
              <div class="municipio-name">${esc(m.municipio || "—")}</div>
              <div class="municipio-badge">
                ${m.es_principal ? badge("Principal", "ok") : ""}
              </div>
            </div>
            ${m.notas ? `<div class="municipio-notas">${esc(m.notas)}</div>` : ``}
          </div>
        `).join("")}
      </div>
    `, "section-long") : ""}

    ${renderListSection("Teléfonos", p.telefonos, (t)=>`
      <div class="t">${esc(t.telefono || "—")} ${t.principal ? badge("Principal", "ok") : ""}</div>
      <div class="m">${esc(t.tipo || "—")}</div>
    `)}

    ${renderListSection("Formación académica", p.formacion_academica, (x)=>`
      <div class="t">${esc([x.nivel, x.grado_obtenido || x.grado].filter(Boolean).join(" • ") || "—")}</div>
      <div class="m">${esc(x.institucion || "")}</div>
      <div class="m">${esc((x.anio_inicio || "—") + " - " + (x.anio_fin || "—"))} ${x.titulado === true ? "• Titulado" : ""}</div>
      ${x.cedula_profesional ? `<div class="m">Cédula: ${esc(x.cedula_profesional)}</div>` : ``}
    `, { long: true })}

    ${renderListSection("Parejas e hijos", p.parejas, (pa)=>`
      <div class="t">
        ${esc(pa.nombre_pareja || "—")}
        <span class="muted">(${esc(pa.tipo_relacion || "—")})</span>
      </div>
      <div class="m">${esc(pa.periodo || "—")}</div>

      ${
        Array.isArray(pa.hijos) && pa.hijos.length
          ? `<div class="kids">
              ${pa.hijos.map(h => {
                const nombre = (h.nombre_completo || "").toString().trim();
                const edad =
                  (h.anios === null || h.anios === undefined || h.anios === "")
                    ? "—"
                    : String(h.anios);
                const anio =
                  (h.anio_nacimiento === null || h.anio_nacimiento === undefined || h.anio_nacimiento === "")
                    ? ""
                    : String(h.anio_nacimiento);
                const sexoRaw = (h.sexo || "").toString().trim().toUpperCase();
                const etiqueta =
                  sexoRaw === "F" ? "Hija" :
                  sexoRaw === "M" ? "Hijo" :
                  "Hijo(a)";
                const sexoTxt =
                  sexoRaw === "F" ? "Femenino" :
                  sexoRaw === "M" ? "Masculino" :
                  (sexoRaw ? sexoRaw : "—");

                return `
                  <div class="m kid-line avoid-break">
                    <span class="kid-icon">👶</span>
                    <span class="kid-role">${esc(etiqueta)}:</span>
                    <span class="kid-name">${esc(nombre || "Sin nombre")}</span>
                    <span class="kid-meta">
                      (${esc(edad)} años${anio ? `, nac. ${esc(anio)}` : ""}${sexoTxt !== "—" ? `, ${esc(sexoTxt)}` : ""})
                    </span>
                  </div>
                `;
              }).join("")}
            </div>`
          : ""
      }
    `, { long: true })}

    ${
      Array.isArray(p.hijos_sin_pareja) && p.hijos_sin_pareja.length
        ? renderSection("Hijos sin especificar pareja", `
            <div class="item avoid-break">
              <div class="kids">
                ${p.hijos_sin_pareja.map(h => {
                  const nombre = (h.nombre_completo || "").toString().trim();
                  const edad =
                    (h.anios === null || h.anios === undefined || h.anios === "")
                      ? "—"
                      : String(h.anios);
                  const anio =
                    (h.anio_nacimiento === null || h.anio_nacimiento === undefined || h.anio_nacimiento === "")
                      ? ""
                      : String(h.anio_nacimiento);
                  const sexoRaw = (h.sexo || "").toString().trim().toUpperCase();
                  const etiqueta =
                    sexoRaw === "F" ? "Hija" :
                    sexoRaw === "M" ? "Hijo" :
                    "Hijo(a)";
                  const sexoTxt =
                    sexoRaw === "F" ? "Femenino" :
                    sexoRaw === "M" ? "Masculino" :
                    (sexoRaw ? sexoRaw : "—");

                  return `
                    <div class="m kid-line avoid-break">
                      <span class="kid-icon">👶</span>
                      <span class="kid-role">${esc(etiqueta)}:</span>
                      <span class="kid-name">${esc(nombre || "Sin nombre")}</span>
                      <span class="kid-meta">
                        (${esc(edad)} años${anio ? `, nac. ${esc(anio)}` : ""}${sexoTxt !== "—" ? `, ${esc(sexoTxt)}` : ""})
                      </span>
                    </div>
                  `;
                }).join("")}
              </div>
            </div>
          `)
        : ""
    }

    ${renderListSection("Redes sociales", p.redes_sociales, (r)=>`
      <div class="t">${esc(r.red || "—")}</div>
      <div class="m">${r.url ? esc(r.url) : "—"}</div>
    `)}

    ${renderListSection("Empresas", p.empresas, (e)=>`
      <div class="t">${esc(e.nombre_empresa || "—")}</div>
      <div class="m">${esc(e.rol || e.rol_otro || "—")}</div>
      ${e.nombre_relacionado ? `<div class="m">Relacionado: ${esc(e.nombre_relacionado)} (${esc(e.relacion || "—")})</div>` : ''}
      ${e.periodo ? `<div class="m">Período: ${esc(e.periodo)}</div>` : ''}
      ${e.notas ? `<div class="m">${esc(e.notas)}</div>` : ''}
    `, { long: true })}

    ${p.temas_interes?.length ? renderSection("Temas de interés", `
      <div class="temas-grid">
        ${p.temas_interes.map(t => `
          <div class="tema-card avoid-break">
            <div class="tema-title">
              ${esc(t.tema || (t.id_tema ? ("Tema #" + t.id_tema) : "—"))}
            </div>

            ${
              t.otro_texto
                ? `<div class="tema-nota">${esc(t.otro_texto)}</div>`
                : ""
            }
          </div>
        `).join("")}
      </div>
    `, "section-long") : ""}

    ${renderListSection("Cargos de elección popular", p.cargos_eleccion_popular, (c)=>`
      <div class="t">${esc(c.cargo_display || c.cargo || "—")}</div>
      <div class="m">${esc([c.periodo, c.modalidad, (c.partido_display || c.partido_postulante)].filter(Boolean).join(" • ") || "")}</div>
      ${(c.orden_gobierno || c.cargo_catalogo) ? `<div class="m">${esc([c.orden_gobierno, c.cargo_catalogo].filter(Boolean).join(" • "))}</div>` : ``}
      ${c.es_suplente ? `<div class="m">Suplente de: ${esc(c.titular_candidatura || "—")}</div>` : ``}
    `, { long: true })}

    ${renderListSection("Servicio público", p.servicio_publico, (s)=>`
      <div class="t">${esc(s.cargo || "—")}</div>
      <div class="m">${esc(s.dependencia || "")}</div>
      <div class="m">${esc(s.periodo || "")}</div>
    `, { long: true })}

    ${renderListSection("Elecciones contendidas", p.elecciones, (e)=>`
      <div class="t">${esc([e.anio_eleccion, e.candidatura].filter(Boolean).join(" • ") || "—")}</div>
      <div class="m">${esc([e.partido_postulacion, parseResultado(e.resultado)].filter(Boolean).join(" • ") || "")}</div>
      ${(e.diferencia_votos || e.diferencia_porcentaje)
        ? `<div class="m">Diferencia: ${esc(e.diferencia_votos ?? "—")} votos • ${esc(e.diferencia_porcentaje ?? "—")}%</div>`
        : `<div class="m"></div>`}
    `, { long: true })}

    ${renderListSection("Eventos de movilización", p.capacidad_movilizacion_eventos, (e)=>`
      <div class="t">${esc(e.nombre_evento || "—")}</div>
      <div class="m">${esc([e.fecha_evento, (e.asistencia != null ? ("Asistencia: " + e.asistencia) : null), e.lugar_evento].filter(Boolean).join(" • ") || "")}</div>
      ${
        Array.isArray(e.fotos) && e.fotos.length
          ? `<div class="photos-grid">
              ${e.fotos.slice(0, 6).map(u => `
                <div class="photo-item">
                  <img src="${escAttr(u)}" alt="foto evento"/>
                </div>`).join("")}
            </div>`
          : ``
      }
    `, { long: true })}

    ${renderListSection("Equipos políticos", p.equipos, (eq)=>`
      <div class="t">${esc(eq.nombre_equipo || "—")}</div>
      <div class="m">${eq.activo === true ? "Activo" : "Inactivo"}</div>
    `)}

    ${renderListSection("Referentes políticos", p.referentes, (r)=>`
      <div class="t">${esc([r.nombres, r.apellido_paterno, r.apellido_materno].filter(Boolean).join(" ") || "—")}</div>
      <div class="m">${esc([r.nivel ? titleCaseEs(r.nivel) : "", r.cargo ? r.cargo : ""].filter(Boolean).join(" • "))}</div>
    `, { long: true })}

    ${renderListSection("Familiares en política", p.familiares, (f)=>{
      const partidoFam = f.partido_display || f.otro_partido_texto || f.partido_politico_siglas || f.partido_politico_nombre || f.partido_politico;
      return `
      <div class="t">${esc([f.nombre, f.parentesco].filter(Boolean).join(" • ") || "—")}</div>
      <div class="m">${esc([f.cargo, f.institucion, partidoFam ? `Partido: ${partidoFam}` : null].filter(Boolean).join(" • ") || "")}</div>
    `;
    }, { long: true })}

    ${renderListSection("Participación en organizaciones", p.participacion_organizaciones, (o)=>`
      <div class="t">${esc((normalizeTipoEnum(o.tipo) ? (normalizeTipoEnum(o.tipo) + ": ") : "") + (o.nombre || "—"))}</div>
      <div class="m">${esc([o.rol, o.periodo].filter(Boolean).join(" • ") || "")}</div>
      ${o.notas ? `<div class="m">${esc(o.notas)}</div>` : ``}
    `, { long: true })}

    ${renderListSection("Experiencia laboral", p.experiencia_laboral, (x)=>`
      <div class="t">${esc(x.cargo || "—")}</div>
      <div class="m">${esc(x.organizacion || "")}</div>
      <div class="m">${esc(x.periodo || "")}</div>
    `)}

    ${renderListSection("Fuentes de consulta", p.fuentes_consulta, (f)=>`
      <div class="t">${esc(f.fuente || "—")}</div>
      <div class="m">${esc([f.fecha_consulta, f.detalle].filter(Boolean).join(" • ") || "")}</div>
    `, { long: true })}

    ${htmlLiderazgo ? renderSection("Liderazgo e influencia", htmlLiderazgo) : ""}

    ${htmlControversias ? renderSection("Controversias", htmlControversias, "section-long") : ""}

    ${renderSection("Control de historial", `
      <div class="kv">
        <div class="k">Oficina</div><div class="v">${esc(p.oficina_nombre || "—")}</div>

        <div class="k">Capturó</div><div class="v">${esc(p.creado_por_nombre || "—")}</div>
        <div class="k">Creado</div><div class="v">${esc(fmtDate(p.created_at))}</div>

        <div class="k">Modificó</div><div class="v">${esc(p.modificado_por_nombre || "—")}</div>
        <div class="k">Actualizado</div><div class="v">${esc(fmtDate(p.updated_at))}</div>

        <div class="k">Verificación por Dirección</div>
        <div class="v">
          ${esc(p.verif_area_por_nombre || "—")}
          ${p.verif_area_por_email ? `<span class="m"> • ${esc(p.verif_area_por_email)}</span>` : ""}
          ${p.verif_area_at ? `<div class="m">${esc(fmtDate(p.verif_area_at))}</div>` : `<div class="m">—</div>`}
        </div>

        <div class="k">Verificación por Coordinación</div>
        <div class="v">
          ${esc(p.verif_office_por_nombre || "—")}
          ${p.verif_office_por_email ? `<span class="m"> • ${esc(p.verif_office_por_email)}</span>` : ""}
          ${p.verif_office_at ? `<div class="m">${esc(fmtDate(p.verif_office_at))}</div>` : `<div class="m">—</div>`}
        </div>

        <div class="k">Verificación Ofi. del Subsecretario</div>
        <div class="v">
          ${esc(p.verificado_por_nombre || "—")}
          ${p.verificado_por_email ? `<span class="m"> • ${esc(p.verificado_por_email)}</span>` : ""}
          ${p.verificado_at ? `<div class="m">${esc(fmtDate(p.verificado_at))}</div>` : `<div class="m">—</div>`}
        </div>
      </div>
    `)}

  </div>
</body>
</html>`;
}

// ===================== ENDPOINT =====================
exports.getPerfilPdf = async (req, res) => {
  let browser = null;
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

    // ✅ Tu SQL consolidado (tal cual)
    const sql = `
      ${/* pega tu SQL exacto aquí */""}
    `;

    // 🔒 reglas de acceso


    // ⬆️ En lugar de pegarlo manualmente dentro de comentario,
    // pega tu SQL string aquí abajo (ya te lo dejo integrado):
    const sqlPerfil = `
    SELECT
      p.id_persona,
      p.nombre,
      p.apellido_paterno,
      p.apellido_materno,
      p.foto_url,
      p.id_oficina,
      p.creado_por,
      p.modificado_por,

      p.verificado_por,
      p.verificado_at,

      p.nivel_confiabilidad,

      p.res_legal_fuera_edomex,
      p.res_legal_estado_texto,
      p.res_legal_municipio_texto,

      p.res_real_fuera_edomex,
      p.res_real_estado_texto,
      p.res_real_municipio_texto,

      p.partido_otro_texto,

      u_ver.nombre AS verificado_por_nombre,
      u_ver.email  AS verificado_por_email,

      u_crea.nombre  AS creado_por_nombre,
      u_mod.nombre   AS modificado_por_nombre,

      u_area.nombre   AS verif_area_por_nombre,
      u_area.email    AS verif_area_por_email,
      u_office.nombre AS verif_office_por_nombre,
      u_office.email  AS verif_office_por_email,

      o.nombre       AS oficina_nombre,
      p.created_at,
      p.updated_at,

      p.verif_area_por,
      p.verif_area_at,
      p.verif_office_por,
      p.verif_office_at,

      p.curp,
      p.rfc,
      p.clave_elector,
      p.edad,
      p.estado_civil,
      p.escala_influencia,
      p.sin_servicio_publico,
      p.ha_contendido_eleccion,
      p.sin_controversias_publicas,

      p.id_partido_actual,
      p.id_tema_interes_central,
      p.tema_interes_otro_texto,
      p.id_grupo_postulacion,
      p.id_ideologia_politica,

      cp.nombre  AS partido_actual,
      cp.siglas  AS partido_actual_siglas,
      cti.nombre AS tema_interes_central,
      cgp.nombre AS grupo_postulacion,
      cip.nombre AS ideologia_politica,

      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id_grupo', gp.id_grupo,
            'nombre', cgp2.nombre
          )
          ORDER BY cgp2.nombre ASC
        )
        FROM personas_grupos_postulacion gp
        JOIN catalogo_grupos_postulacion cgp2
          ON cgp2.id_grupo = gp.id_grupo
        WHERE gp.id_persona = p.id_persona
      ), '[]'::jsonb) AS grupos_postulacion,

      p.municipio_residencia_legal  AS municipio_residencia_legal_id,
      p.municipio_residencia_real   AS municipio_residencia_real_id,
      p.municipio_trabajo_politico  AS municipio_trabajo_politico_id,

      ml.nombre AS municipio_residencia_legal,
      mr.nombre AS municipio_residencia_real,
      mt.nombre AS municipio_trabajo_politico,

      CASE
        WHEN COALESCE(p.res_legal_fuera_edomex,false) THEN
          concat_ws(', ',
            NULLIF(trim(p.res_legal_municipio_texto), ''),
            NULLIF(trim(p.res_legal_estado_texto), '')
          )
        ELSE ml.nombre
      END AS residencia_legal_display,

      CASE
        WHEN COALESCE(p.res_real_fuera_edomex,false) THEN
          concat_ws(', ',
            NULLIF(trim(p.res_real_municipio_texto), ''),
            NULLIF(trim(p.res_real_estado_texto), '')
          )
        ELSE mr.nombre
      END AS residencia_real_display,

      (
        SELECT CASE
          WHEN di.id_persona IS NULL THEN NULL
          ELSE jsonb_build_object(
            'seccion_electoral', di.seccion_electoral,
            'distrito_federal',  di.distrito_federal,
            'distrito_local',    di.distrito_local
          )
        END
        FROM datos_ine di
        WHERE di.id_persona = p.id_persona
        ORDER BY di.id_ine DESC
        LIMIT 1
      ) AS datos_ine,

      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id_telefono', t.id_telefono,
            'telefono',    t.telefono,
            'tipo',        t.tipo,
            'principal',   t.principal
          )
          ORDER BY t.principal DESC, t.id_telefono ASC
        )
        FROM telefonos t
        WHERE t.id_persona = p.id_persona
      ), '[]'::jsonb) AS telefonos,

      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id_formacion',   fa.id_formacion,
            'nivel',          fa.nivel,
            'grado',          fa.grado,
            'grado_obtenido', fa.grado_obtenido,
            'institucion',    fa.institucion,
            'anio_inicio',    fa.anio_inicio,
            'anio_fin',       fa.anio_fin,
            'titulado',       fa.titulado,
            'cedula_profesional', fa.cedula_profesional
          )
          ORDER BY fa.id_formacion ASC
        )
        FROM formacion_academica fa
        WHERE fa.id_persona = p.id_persona
      ), '[]'::jsonb) AS formacion_academica,

      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id_red', crs.id_red,
            'red',    crs.nombre,
            'url',    rsp.url
          )
          ORDER BY crs.nombre ASC
        )
        FROM redes_sociales_persona rsp
        JOIN catalogo_redes_sociales crs ON crs.id_red = rsp.id_red
        WHERE rsp.id_persona = p.id_persona
      ), '[]'::jsonb) AS redes_sociales,

      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'nombre_empresa', e.nombre_empresa,
          'rol', e.rol,
          'rol_otro', e.rol_otro,
          'nombre_relacionado', e.nombre_relacionado,
          'relacion', e.relacion,
          'periodo', e.periodo,
          'notas', e.notas
        ) ORDER BY e.id_empresa_persona ASC)
        FROM empresas_persona e
        WHERE e.id_persona = p.id_persona
      ), '[]'::jsonb) AS empresas,

      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id_pareja',     pa.id_pareja,
            'nombre_pareja', pa.nombre_pareja,
            'tipo_relacion', pa.tipo_relacion,
            'periodo',       pa.periodo,
            'hijos', COALESCE((
              SELECT jsonb_agg(
                jsonb_build_object(
                  'id_hijo',         h.id_hijo,
                  'anio_nacimiento', h.anio_nacimiento,
                  'anios',           h.anios,
                  'sexo',            h.sexo,
                  'nombre_completo', h.nombre_completo
                )
                ORDER BY h.id_hijo ASC
              )
              FROM hijos h
              WHERE h.id_persona = p.id_persona
                AND h.id_pareja = pa.id_pareja
            ), '[]'::jsonb)
          )
          ORDER BY pa.id_pareja ASC
        )
        FROM parejas pa
        WHERE pa.id_persona = p.id_persona
      ), '[]'::jsonb) AS parejas,

      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id_hijo',         h.id_hijo,
            'anio_nacimiento', h.anio_nacimiento,
            'anios',           h.anios,
            'sexo',            h.sexo,
            'nombre_completo', h.nombre_completo
          )
          ORDER BY h.id_hijo ASC
        )
        FROM hijos h
        WHERE h.id_persona = p.id_persona
          AND h.id_pareja IS NULL
      ), '[]'::jsonb) AS hijos_sin_pareja,

      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id_servicio', sp.id_servicio,
            'periodo',     sp.periodo,
            'cargo',       sp.cargo,
            'dependencia', sp.dependencia
          )
          ORDER BY sp.id_servicio ASC
        )
        FROM servicio_publico sp
        WHERE sp.id_persona = p.id_persona
      ), '[]'::jsonb) AS servicio_publico,

      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id_eleccion',            ec.id_eleccion,
            'anio_eleccion',          ec.anio_eleccion,
            'candidatura',            ec.candidatura,
            'partido_postulacion',    ec.partido_postulacion,
            'resultado',              ec.resultado,
            'diferencia_votos',       ec.diferencia_votos,
            'diferencia_porcentaje',  ec.diferencia_porcentaje
          )
          ORDER BY ec.anio_eleccion DESC NULLS LAST, ec.id_eleccion ASC
        )
        FROM elecciones_contendidas ec
        WHERE ec.id_persona = p.id_persona
      ), '[]'::jsonb) AS elecciones,

      -- ✅ EVENTOS + FOTOS (solo una vez)
      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id_evento',      cme.id_evento,
            'nombre_evento',  cme.nombre_evento,
            'fecha_evento',   cme.fecha_evento,
            'asistencia',     cme.asistencia,
            'lugar_evento',   cme.lugar_evento,
            'fotos', COALESCE((
              SELECT jsonb_agg(f.foto_url ORDER BY f.id_foto ASC)
              FROM capacidad_movilizacion_eventos_fotos f
              WHERE f.id_evento = cme.id_evento
            ), '[]'::jsonb)
          )
          ORDER BY cme.fecha_evento DESC NULLS LAST, cme.id_evento ASC
        )
        FROM capacidad_movilizacion_eventos cme
        WHERE cme.id_persona = p.id_persona
      ), '[]'::jsonb) AS capacidad_movilizacion_eventos,

      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id_equipo',     ep.id_equipo,
            'nombre_equipo', ep.nombre_equipo,
            'activo',        ep.activo
          )
          ORDER BY ep.activo DESC, ep.id_equipo ASC
        )
        FROM equipos_politicos ep
        WHERE ep.id_persona = p.id_persona
      ), '[]'::jsonb) AS equipos,

      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id_referente',     rp.id_referente,
            'nivel',            rp.nivel,
            'nombres',          rp.nombres,
            'apellido_paterno', rp.apellido_paterno,
            'apellido_materno', rp.apellido_materno,
            'cargo',            rp.cargo
          )
          ORDER BY rp.id_referente ASC
        )
        FROM referentes_politicos rp
        WHERE rp.id_persona = p.id_persona
      ), '[]'::jsonb) AS referentes,

      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id_familiar', fp.id_familiar,
            'nombre',      fp.nombre,
            'parentesco',  fp.parentesco,
            'cargo',       fp.cargo,
            'institucion', fp.institucion,
            'id_partido_politico', fp.id_partido_politico,
            'partido_politico', cp_fam.nombre,
            'partido_politico_nombre', cp_fam.nombre,
            'partido_politico_siglas', cp_fam.siglas,
            'otro_partido_texto', fp.otro_partido_texto,
            'partido_display', COALESCE(
              NULLIF(TRIM(fp.otro_partido_texto), ''),
              NULLIF(TRIM(cp_fam.siglas), ''),
              cp_fam.nombre
            )
          )
          ORDER BY fp.id_familiar ASC
        )
        FROM familiares_politica fp
        LEFT JOIN catalogo_partidos cp_fam
          ON cp_fam.id_partido = fp.id_partido_politico
        WHERE fp.id_persona = p.id_persona
      ), '[]'::jsonb) AS familiares,

      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id_participacion', po.id_participacion,
            'tipo',             po.tipo,
            'nombre',           po.nombre,
            'rol',              po.rol,
            'periodo',          po.periodo,
            'notas',            po.notas
          )
          ORDER BY po.id_participacion ASC
        )
        FROM participacion_organizaciones po
        WHERE po.id_persona = p.id_persona
      ), '[]'::jsonb) AS participacion_organizaciones,

      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id_tema', pti.id_tema,
            'tema',    cti2.nombre,
            'otro_texto', pti.otro_texto
          )
          ORDER BY cti2.nombre ASC NULLS LAST, pti.id_tema ASC
        )
        FROM personas_temas_interes pti
        LEFT JOIN catalogo_temas_interes cti2 ON cti2.id_tema = pti.id_tema
        WHERE pti.id_persona = p.id_persona
      ), '[]'::jsonb) AS temas_interes,

      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id_cargo_eleccion', cep.id_cargo_eleccion,
            'periodo', cep.periodo,
            'modalidad', cep.modalidad,

            'id_orden_gobierno', cep.id_orden_gobierno,
            'orden_gobierno', og.nombre,

            'id_cargo_catalogo', cep.id_cargo_catalogo,
            'cargo_catalogo', ce.nombre,

            'id_partido_postulante', cep.id_partido_postulante,
            'partido_postulante_catalogo', cp2.nombre,
            'partido_postulante_siglas', cp2.siglas,

            'cargo', cep.cargo,
            'partido_postulante', cep.partido_postulante,

            'cargo_display', COALESCE(ce.nombre, cep.cargo),
            'partido_display', COALESCE(cp2.siglas, cp2.nombre, cep.partido_postulante),

            'es_suplente', cep.es_suplente,
            'titular_candidatura', cep.titular_candidatura
          )
          ORDER BY
            NULLIF(split_part(cep.periodo,'-',1),'')::int DESC NULLS LAST,
            cep.id_cargo_eleccion ASC
        )
        FROM cargos_eleccion_popular cep
        LEFT JOIN catalogo_orden_gobierno og
          ON og.id_orden = cep.id_orden_gobierno
        LEFT JOIN catalogo_cargo_eleccion ce
          ON ce.id_orden = cep.id_orden_gobierno
        AND ce.id_cargo = cep.id_cargo_catalogo
        LEFT JOIN catalogo_partidos cp2 ON cp2.id_partido = cep.id_partido_postulante
        WHERE cep.id_persona = p.id_persona
      ), '[]'::jsonb) AS cargos_eleccion_popular,

      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id_experiencia', el.id_experiencia,
            'periodo', el.periodo,
            'cargo', el.cargo,
            'organizacion', el.organizacion
          )
          ORDER BY el.id_experiencia ASC
        )
        FROM experiencia_laboral el
        WHERE el.id_persona = p.id_persona
      ), '[]'::jsonb) AS experiencia_laboral,

      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id_fuente_persona', fp.id_fuente_persona,
            'id_fuente',         fp.id_fuente,
            'fuente',            cfc.nombre,
            'detalle',           fp.detalle,
            'fecha_consulta',    fp.fecha_consulta
          )
          ORDER BY cfc.nombre ASC, fp.id_fuente_persona ASC
        )
        FROM fuentes_persona fp
        JOIN catalogo_fuentes_consulta cfc ON cfc.id_fuente = fp.id_fuente
        WHERE fp.id_persona = p.id_persona
      ), '[]'::jsonb) AS fuentes_consulta,

      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id_municipio', pmt.id_municipio,
            'municipio',    m2.nombre,
            'es_principal', pmt.es_principal,
            'notas',        pmt.notas
          )
          ORDER BY pmt.es_principal DESC, m2.nombre ASC
        )
        FROM personas_municipios_trabajo pmt
        LEFT JOIN municipios m2 ON m2.id_municipio = pmt.id_municipio
        WHERE pmt.id_persona = p.id_persona
      ), '[]'::jsonb) AS municipios_trabajo,

      (
        SELECT CASE
          WHEN li.id_persona IS NULL THEN NULL
          ELSE jsonb_build_object(
            'nivel', li.nivel,
            'tipos', li.tipos,
            'tipo_otro_texto', li.tipo_otro_texto,
            'cuenta_con_estructura', li.cuenta_con_estructura,
            'presencia_territorial', li.presencia_territorial,
            'created_at', li.created_at,
            'updated_at', li.updated_at
          )
        END
        FROM liderazgo_influencia li
        WHERE li.id_persona = p.id_persona
      ) AS liderazgo_influencia,

      CASE
        WHEN p.sin_controversias_publicas = true THEN '[]'::jsonb
        ELSE COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_controversia', cper.id_controversia,
              'id_tipo',         cper.id_tipo,
              'tipo',            ccat.tipo,
              'descripcion',     cper.descripcion,
              'fuente',          cper.fuente,
              'fecha_registro',  cper.fecha_registro,
              'estatus',         cper.estatus
            )
            ORDER BY cper.id_controversia ASC
          )
          FROM controversias_persona cper
          LEFT JOIN catalogo_controversias ccat ON ccat.id_tipo = cper.id_tipo
          WHERE cper.id_persona = p.id_persona
        ), '[]'::jsonb)
      END AS controversias

    FROM personas p
    LEFT JOIN municipios ml ON ml.id_municipio = p.municipio_residencia_legal
    LEFT JOIN municipios mr ON mr.id_municipio = p.municipio_residencia_real
    LEFT JOIN municipios mt ON mt.id_municipio = p.municipio_trabajo_politico

    LEFT JOIN usuarios u_crea ON u_crea.id_usuario = p.creado_por
    LEFT JOIN usuarios u_mod  ON u_mod.id_usuario = p.modificado_por
    LEFT JOIN usuarios u_ver  ON u_ver.id_usuario  = p.verificado_por
    LEFT JOIN oficinas o      ON o.id_oficina = p.id_oficina

    LEFT JOIN usuarios u_area   ON u_area.id_usuario   = p.verif_area_por
    LEFT JOIN usuarios u_office ON u_office.id_usuario = p.verif_office_por

    LEFT JOIN catalogo_partidos cp            ON cp.id_partido   = p.id_partido_actual
    LEFT JOIN catalogo_temas_interes cti      ON cti.id_tema     = p.id_tema_interes_central
    LEFT JOIN catalogo_grupos_postulacion cgp ON cgp.id_grupo    = p.id_grupo_postulacion
    LEFT JOIN catalogo_ideologia_politica cip ON cip.id_ideologia = p.id_ideologia_politica

    WHERE p.id_persona = $1
    LIMIT 1
    `;

    const { rows } = await pool.query(sqlPerfil, [id]);
    if (!rows[0]) return res.status(404).json({ error: "Persona no encontrada" });

    const perfil = rows[0];

    // 🔒 reglas de acceso
    const roles = req.user?.roles || [];
    const isSuper = roles.includes("superadmin");
    const isAnalista = roles.includes("analista");
    const isCapturista = roles.includes("capturista");

    if (isCapturista && perfil.creado_por !== req.user.id_usuario) {
      return res.status(403).json({ error: "No autorizado" });
    }

    if (!isSuper && isAnalista) {
      if (!req.user.id_oficina || perfil.id_oficina !== req.user.id_oficina) {
        return res.status(403).json({ error: "No autorizado (oficina)" });
      }
    }

    // ✅ Foto URL -> base64 data-uri
    let fotoDataUri = null;
    try {
      fotoDataUri = await imageUrlToDataUri(perfil.foto_url);
    } catch (e) {
      console.warn("Foto no disponible para PDF:", e.message);
    }

    const html = buildPerfilHtml({ ...perfil, foto_url: fotoDataUri });

    // ✅ Lanza browser (NO redeclares "const browser")
    browser = await puppeteer.launch({
      headless: "new",
      // 🔥 IMPORTANTE: en Render NO pongas path de Windows
      // usa puppeteer.executablePath() cuando no haya env var
      executablePath:
        process.env.PUPPETEER_EXECUTABLE_PATH ||
        (typeof puppeteer.executablePath === "function" ? puppeteer.executablePath() : undefined),
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--no-zygote",
        "--single-process",
      ],
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(60000);

    await page.setContent(html, { waitUntil: "load" });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "12mm", right: "12mm", bottom: "12mm", left: "12mm" },
    });

    const pdfBuf = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);

    if (pdfBuf.length < 100 || pdfBuf.slice(0, 4).toString("utf8") !== "%PDF") {
      throw new Error("PDF inválido: el buffer no inicia con %PDF");
    }

    res.status(200);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", String(pdfBuf.length));
    res.setHeader("Content-Disposition", `inline; filename="${buildPerfilPdfFilename(perfil)}"`);
    return res.end(pdfBuf);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Error al generar PDF", detail: e.message });
  } finally {
    try { if (browser) await browser.close(); } catch (e) { console.warn("close browser fail:", e.message); }
  }
};

//repote ejecutivo:
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDateTimeMX(v) {
  if (!v) return "—";
  try {
    return new Date(v).toLocaleString("es-MX", {
      timeZone: "America/Mexico_City",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return String(v);
  }
}

function pct(n, total) {
  if (!total) return "0%";
  return `${((Number(n || 0) / Number(total || 0)) * 100).toFixed(1)}%`;
}

function buildReporteEjecutivoHtml({
  user,
  filtros,
  resumen,
  oficinas,
  areas,
  municipios,
  multiMunicipioOficinas,
  resumenTerritorial,
  escalas
}) {
const total = Number(resumen.total_actores || 0);
const dir = Number(resumen.verificados_direccion || 0);
const coord = Number(resumen.verificados_coordinacion || 0);
const fin = Number(resumen.verificados_final || 0);
const pendFinal = Number(resumen.pendientes_final || 0);
const controversias = Number(resumen.con_controversias || 0);
const confAlta = Number(resumen.confiabilidad_alta || 0);

const soloPrincipalTotal = Number(resumenTerritorial.solo_principal_total || 0);
const multiMunicipioTotal = Number(resumenTerritorial.multi_municipio_total || 0);
const sinMunicipioTotal = Number(resumenTerritorial.sin_municipio_total || 0);
const principalMarcadoTotal = Number(resumenTerritorial.principal_marcado_total || 0);

const maxMunicipio = Math.max(1, ...municipios.map(x => Number(x.total || 0)));
const maxOficina = Math.max(1, ...oficinas.map(x => Number(x.total || 0)));
const maxArea = Math.max(1, ...areas.map(x => Number(x.total || 0)));
const maxEscala = Math.max(1, ...escalas.map(x => Number(x.total || 0)));

const sinPrincipalTotal = Number(resumenTerritorial.sin_principal_total || 0);
const conCoberturaSinPrincipal = Number(resumenTerritorial.con_cobertura_sin_principal || 0);

  return `
<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Reporte de actores políticos</title>
  <style>
    :root{
      --primary:#7a1f2b;
      --primary-2:#a33a4a;
      --gold:#b89056;
      --bg:#f6f7fb;
      --text:#1f2937;
      --muted:#6b7280;
      --line:#e5e7eb;
      --ok:#16a34a;
      --warn:#f59e0b;
      --info:#2563eb;
      --danger:#dc2626;
      --soft:#eef2f7;
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      font-family: Arial, Helvetica, sans-serif;
      color:var(--text);
      background:#fff;
    }
    .page{
      padding:24px 28px 28px;
    }
    .header{
      display:flex;
      justify-content:space-between;
      align-items:flex-start;
      gap:20px;
      border-bottom:3px solid var(--primary);
      padding-bottom:14px;
      margin-bottom:18px;
    }
    .title{
      font-size:24px;
      font-weight:700;
      color:var(--primary);
      margin:0 0 4px 0;
    }
    .subtitle{
      color:var(--muted);
      font-size:12px;
      margin:0;
    }
    .meta{
      text-align:right;
      font-size:11px;
      color:var(--muted);
      line-height:1.5;
    }
    .section-title{
      font-size:15px;
      font-weight:700;
      color:var(--primary);
      margin:0 0 10px 0;
      padding-left:10px;
      border-left:4px solid var(--gold);
    }
    .filters{
      background:var(--bg);
      border:1px solid var(--line);
      border-radius:12px;
      padding:12px 14px;
      font-size:12px;
    }
    .filters-grid{
      display:grid;
      grid-template-columns: repeat(3, minmax(0,1fr));
      gap:8px 14px;
    }
    .f-item b{ color:#374151; }
    .kpis{
      display:grid;
      grid-template-columns: repeat(4, minmax(0,1fr));
      gap:12px;
      margin-top:10px;
    }
    .kpi{
      border:1px solid var(--line);
      border-radius:14px;
      padding:12px 14px;
      background:#fff;
      box-shadow:0 3px 10px rgba(0,0,0,.04);
    }
    .kpi .label{
      font-size:11px;
      color:var(--muted);
      margin-bottom:6px;
    }
    .kpi .value{
      font-size:24px;
      font-weight:700;
      line-height:1;
    }
    .kpi .sub{
      margin-top:6px;
      font-size:11px;
      color:var(--muted);
    }
    .kpi.primary .value{ color:var(--primary); }
    .kpi.info .value{ color:var(--info); }
    .kpi.ok .value{ color:var(--ok); }
    .kpi.warn .value{ color:var(--warn); }
    .two-col{
      display:grid;
      grid-template-columns: 1.15fr .85fr;
      gap:16px;
      align-items:start;
    }
    table{
      width:100%;
      border-collapse:collapse;
      font-size:11px;
      background:#fff;
      border:1px solid var(--line);
      border-radius:12px;
      overflow:hidden;
    }
    thead th{
      background:#f8fafc;
      color:#374151;
      font-weight:700;
      padding:8px 10px;
      border-bottom:1px solid var(--line);
      text-align:left;
    }
    tbody td{
      padding:7px 10px;
      border-bottom:1px solid #eef2f7;
      vertical-align:top;
    }
    tbody tr:nth-child(even){
      background:#fcfcfd;
    }
    .chart-card{
      border:1px solid var(--line);
      border-radius:14px;
      padding:12px 14px;
      background:#fff;
    }
    .chart-title{
      font-size:12px;
      font-weight:700;
      color:#374151;
      margin-bottom:10px;
    }
    .bar-list{
      display:flex;
      flex-direction:column;
      gap:10px;
    }
    .bar-row{
      display:grid;
      grid-template-columns: 140px 1fr 46px;
      gap:8px;
      align-items:center;
      font-size:11px;
    }
    .bar-label{
      color:#374151;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }
    .bar-track{
      height:12px;
      background:#edf2f7;
      border-radius:999px;
      overflow:hidden;
      position:relative;
    }
    .bar-fill{
      height:100%;
      border-radius:999px;
    }
    .bar-fill.primary{ background:linear-gradient(90deg, var(--primary), var(--primary-2)); }
    .bar-fill.info{ background:linear-gradient(90deg, #60a5fa, var(--info)); }
    .bar-fill.ok{ background:linear-gradient(90deg, #4ade80, var(--ok)); }
    .bar-fill.warn{ background:linear-gradient(90deg, #fbbf24, var(--warn)); }
    .legend{
      display:flex;
      gap:14px;
      flex-wrap:wrap;
      font-size:11px;
      color:var(--muted);
      margin-top:8px;
    }
    .legend span::before{
      content:"";
      display:inline-block;
      width:10px;
      height:10px;
      border-radius:999px;
      margin-right:6px;
      vertical-align:middle;
    }
    .lg-dir::before{ background:var(--warn); }
    .lg-coord::before{ background:var(--info); }
    .lg-final::before{ background:var(--ok); }
    .footer{
      margin-top:18px;
      padding-top:10px;
      border-top:1px solid var(--line);
      font-size:10px;
      color:var(--muted);
      text-align:right;
    }
    .page-break{
      page-break-before:always;
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="header">
  <!-- LOGO -->
      <div class="me-3 d-flex align-items-center">
        <img 
          src="https://lh3.googleusercontent.com/d/18fNmkOjp0_asak96yPafw9ncyaEc7u6N=s550" 
          alt="Logo Gobierno del Estado de México"
          class="navbar-logo"
        >
      </div>
      <div class="meta">
        <div><b>Generado por:</b> ${esc(user?.nombre || user?.email || "Usuario")}</div>
        <div><b>Fecha de corte:</b> ${esc(fmtDateTimeMX(new Date()))}</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Filtros aplicados</div>
      <div class="filters">
        <div class="filters-grid">
          <div class="f-item"><b>Búsqueda:</b> ${esc(filtros.q || "Todos")}</div>
          <div class="f-item"><b>Oficina:</b> ${esc(filtros.oficina || "Todas")}</div>
          <div class="f-item"><b>Capturista:</b> ${esc(filtros.capturista || "Todos")}</div>
          <div class="f-item"><b>Municipio:</b> ${esc(filtros.municipio || "Todos")}</div>
          <div class="f-item"><b>Verificación:</b> ${esc(filtros.verificacion || "Todas")}</div>
          <div class="f-item"><b>Partido:</b> ${esc(filtros.partido || "Todos")}</div>
          <div class="f-item"><b>Confiabilidad:</b> ${esc(filtros.confiabilidad || "Todas")}</div>
          <div class="f-item"><b>Influencia:</b> ${esc(filtros.liderazgo || "Todos")}</div>
          <div class="f-item"><b>Controversias:</b> ${esc(filtros.controversias || "Todos")}</div>
          <div class="f-item"><b>Referente:</b> ${esc(filtros.referente || "Todos")}</div>
          <div class="f-item"><b>Fecha desde:</b> ${esc(filtros.fechaDesde || "—")}</div>
          <div class="f-item"><b>Fecha hasta:</b> ${esc(filtros.fechaHasta || "—")}</div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Indicadores globales</div>
      <div class="kpis">
        <div class="kpi primary">
          <div class="label">Total de actores registrados</div>
          <div class="value">${total}</div>
          <div class="sub">Universo filtrado</div>
        </div>
        <div class="kpi warn">
          <div class="label">Verificación Dirección</div>
          <div class="value">${dir}</div>
          <div class="sub">${pct(dir, total)} del total</div>
        </div>
        <div class="kpi info">
          <div class="label">Verificación Coordinación</div>
          <div class="value">${coord}</div>
          <div class="sub">${pct(coord, total)} del total</div>
        </div>
        <div class="kpi ok">
          <div class="label">Verificación Final</div>
          <div class="value">${fin}</div>
          <div class="sub">${pct(fin, total)} del total</div>
        </div>
        <div class="kpi warn">
          <div class="label">Pendientes de Final</div>
          <div class="value">${pendFinal}</div>
          <div class="sub">Listos para cierre institucional</div>
        </div>
        <div class="kpi primary">
          <div class="label">Con controversias</div>
          <div class="value">${controversias}</div>
          <div class="sub">${pct(controversias, total)} del total</div>
        </div>
        <div class="kpi ok">
          <div class="label">Confiabilidad alta</div>
          <div class="value">${confAlta}</div>
          <div class="sub">${pct(confAlta, total)} del total</div>
        </div>
      </div>
    </div>

    <div class="section two-col">
      <div>
        <div class="section-title">Desempeño por oficina</div>
        <table>
          <thead>
            <tr>
              <th>Oficina</th>
              <th>Total</th>
              <th>Dirección</th>
              <th>Coordinación</th>
              <th>Final</th>
              <th>% Final</th>
            </tr>
          </thead>
          <tbody>
            ${oficinas.map(r => `
              <tr>
                <td>${esc(r.oficina || "Sin oficina")}</td>
                <td>${Number(r.total || 0)}</td>
                <td>${Number(r.direccion || 0)}</td>
                <td>${Number(r.coordinacion || 0)}</td>
                <td>${Number(r.final || 0)}</td>
                <td>${pct(r.final, r.total)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>

      <div class="chart-card">
        <div class="chart-title">Total de registros por oficina</div>
        <div class="bar-list">
          ${oficinas.slice(0, 8).map(r => `
            <div class="bar-row">
              <div class="bar-label">${esc(r.oficina || "Sin oficina")}</div>
              <div class="bar-track">
                <div class="bar-fill primary" style="width:${(Number(r.total || 0) / maxOficina) * 100}%"></div>
              </div>
              <div>${Number(r.total || 0)}</div>
            </div>
          `).join("")}
        </div>
      </div>
    </div>

    <div class="section page-break">
      <div class="section-title">Seguimiento por área</div>
      <div class="two-col">
        <div>
          <table>
            <thead>
              <tr>
                <th>Área</th>
                <th>Total</th>
                <th>Dirección</th>
                <th>Coordinación</th>
                <th>Final</th>
              </tr>
            </thead>
            <tbody>
              ${areas.map(r => `
                <tr>
                  <td>${esc(r.area || "Sin área")}</td>
                  <td>${Number(r.total || 0)}</td>
                  <td>${Number(r.direccion || 0)}</td>
                  <td>${Number(r.coordinacion || 0)}</td>
                  <td>${Number(r.final || 0)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>

        <div class="chart-card">
          <div class="chart-title">Top registros por área</div>
          <div class="bar-list">
            ${areas.slice(0, 10).map(r => `
              <div class="bar-row">
                <div class="bar-label">${esc(r.area || "Sin área")}</div>
                <div class="bar-track">
                  <div class="bar-fill info" style="width:${(Number(r.total || 0) / maxArea) * 100}%"></div>
                </div>
                <div>${Number(r.total || 0)}</div>
              </div>
            `).join("")}
          </div>
        </div>
      </div>
    </div>
    <div class="section page-break">
      <div class="section-title">Distribución territorial por municipio principal</div>
      <div style="font-size:11px; color:#6b7280; margin-bottom:10px;">
        La distribución territorial se basa en el municipio principal de operación de cada actor político.
        En caso de no estar definido, se toma el municipio registrado en su información general.
      </div>

      <div class="kpis">
        <div class="kpi primary">
          <div class="label">Solo municipio principal</div>
          <div class="value">${soloPrincipalTotal}</div>
          <div class="sub">${pct(soloPrincipalTotal, total)} del total</div>
        </div>
        <div class="kpi info">
          <div class="label">Multi municipio</div>
          <div class="value">${multiMunicipioTotal}</div>
          <div class="sub">${pct(multiMunicipioTotal, total)} del total</div>
        </div>
        <div class="kpi warn">
          <div class="label">Sin municipio asignado</div>
          <div class="value">${sinMunicipioTotal}</div>
          <div class="sub">${pct(sinMunicipioTotal, total)} del total</div>
        </div>
        <div class="kpi info">
          <div class="label">Con cobertura pero sin principal</div>
          <div class="value">${conCoberturaSinPrincipal}</div>
          <div class="sub">Registros a corregir en captura</div>
        </div>
        <div class="kpi ok">
          <div class="label">Con principal marcado</div>
          <div class="value">${principalMarcadoTotal}</div>
          <div class="sub">${pct(principalMarcadoTotal, total)} del total</div>
        </div>
      </div>

      <div class="two-col" style="margin-top:14px;">
        <div>
          <table>
            <thead>
              <tr>
                <th>Municipio</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              ${municipios.map(r => `
                <tr>
                  <td>${esc(r.municipio || "—")}</td>
                  <td>${Number(r.total || 0)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>

        <div class="chart-card">
          <div class="chart-title">Top municipios por concentración</div>
          <div class="bar-list">
            ${municipios.slice(0, 12).map(r => `
              <div class="bar-row">
                <div class="bar-label">${esc(r.municipio || "—")}</div>
                <div class="bar-track">
                  <div class="bar-fill ok" style="width:${(Number(r.total || 0) / maxMunicipio) * 100}%"></div>
                </div>
                <div>${Number(r.total || 0)}</div>
              </div>
            `).join("")}
          </div>
          <div style="margin-top:8px; font-size:10px; color:#6b7280; line-height:1.5;">
            * Top 15 municipios según el municipio principal resuelto.<br>
            La cobertura adicional multi-municipio se resume en el bloque inferior.
          </div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Cobertura territorial por oficina</div>
      <table>
        <thead>
          <tr>
            <th>Oficina</th>
            <th>Total</th>
            <th>Solo principal</th>
            <th>Multi municipio</th>
            <th>Sin municipio</th>
            <th>Principal marcado</th>
          </tr>
        </thead>
        <tbody>
          ${multiMunicipioOficinas.map(r => `
            <tr>
              <td>${esc(r.oficina || "Sin oficina")}</td>
              <td>${Number(r.total || 0)}</td>
              <td>${Number(r.solo_principal || 0)}</td>
              <td>${Number(r.multi_municipio || 0)}</td>
              <td>${Number(r.sin_municipio || 0)}</td>
              <td>${Number(r.principal_marcado || 0)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>

    <div class="section">
      <div class="section-title">Distribución por escala de influencia</div>
      <div class="two-col">
        <div>
          <table>
            <thead>
              <tr>
                <th>Escala</th>
                <th>Total</th>
                <th>%</th>
              </tr>
            </thead>
            <tbody>
              ${escalas.map(r => `
                <tr>
                  <td>${esc(r.escala || "Sin nivel")}</td>
                  <td>${Number(r.total || 0)}</td>
                  <td>${pct(r.total, total)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>

        <div class="chart-card">
          <div class="chart-title">Volumen por escala de influencia</div>
          <div class="bar-list">
            ${escalas.map(r => `
              <div class="bar-row">
                <div class="bar-label">${esc(r.escala || "Sin nivel")}</div>
                <div class="bar-track">
                  <div class="bar-fill warn" style="width:${(Number(r.total || 0) / maxEscala) * 100}%"></div>
                </div>
                <div>${Number(r.total || 0)}</div>
              </div>
            `).join("")}
          </div>
        </div>
      </div>
    </div>

    <div class="footer">
      Reporte generado automáticamente · Sistema de Actores Políticos
    </div>
  </div>
</body>
</html>
  `;
}

exports.reporteEjecutivo = async (req, res) => {
  const client = await pool.connect();
  try {
    const { addFullFilter } = req.smartFilters;
    const params = [];
    const where = [];

    addFullFilter(params, where);

    // filtros
    const oficinaId = req.query.oficinaId ? Number(req.query.oficinaId) : null;
    const capturistaId = req.query.capturistaId ? Number(req.query.capturistaId) : null;
    const idMunTrabajo = req.query.municipio_trabajo ? Number(req.query.municipio_trabajo) : null;
    const q = (req.query.q || "").trim();

    const partidoIdRaw = String(req.query.partidoId || "").trim();
    const confiabilidad = (req.query.confiabilidad || "").trim().toLowerCase();
    const liderazgo = (req.query.liderazgo || "").trim().toLowerCase();
    const verifLevel = String(req.query.verifLevel || "").trim().toLowerCase();
    const fechaDesde = String(req.query.fechaDesde || "").trim();
    const fechaHasta = String(req.query.fechaHasta || "").trim();
    const referente = (req.query.referente || "").trim();
    const refMode = String(req.query.refMode || "").trim();
    let oficinaNombreFiltro = "";


    const controversias =
      (req.query.controversias === "1" || req.query.controversias === "0")
        ? req.query.controversias
        : null;

  
    if (oficinaId) {
      params.push(oficinaId);
      where.push(`p.id_oficina = $${params.length}`);
    }


    if (oficinaId) {
      const qOf = await client.query(
        `SELECT nombre FROM oficinas WHERE id_oficina = $1 LIMIT 1`,
        [oficinaId]
      );
      oficinaNombreFiltro = qOf.rows[0]?.nombre || String(oficinaId);
    }

    if (capturistaId) {
      params.push(capturistaId);
      where.push(`p.creado_por = $${params.length}`);
    }

    if (Number.isFinite(idMunTrabajo) && idMunTrabajo > 0) {
      params.push(idMunTrabajo);
      where.push(`p.municipio_trabajo_politico = $${params.length}`);
    }

    if (q) {
      params.push(`%${q}%`);
      const i = params.length;
      where.push(`
        (
          COALESCE(p.nombre,'') ILIKE $${i}
          OR COALESCE(p.apellido_paterno,'') ILIKE $${i}
          OR COALESCE(p.apellido_materno,'') ILIKE $${i}
          OR COALESCE(p.curp,'') ILIKE $${i}
          OR COALESCE(p.rfc,'') ILIKE $${i}
          OR COALESCE(p.clave_elector,'') ILIKE $${i}
        )
      `);
    }

    if (partidoIdRaw === "__OTRO__") {
      where.push(`COALESCE(TRIM(p.partido_otro_texto), '') <> ''`);
    } else if (partidoIdRaw.toLowerCase() === "independiente") {
      where.push(`
        p.id_partido_actual IS NULL
        AND COALESCE(TRIM(p.partido_otro_texto), '') = ''
      `);
    } else {
      const partidoId = Number(partidoIdRaw);
      if (Number.isFinite(partidoId) && partidoId > 0) {
        params.push(partidoId);
        where.push(`p.id_partido_actual = $${params.length}`);
      }
    }

    if (["alto", "medio", "bajo"].includes(confiabilidad)) {
      params.push(confiabilidad);
      where.push(`LOWER(COALESCE(p.nivel_confiabilidad, '')) = $${params.length}`);
    }

    if (["municipal", "regional", "distrital", "estatal", "nacional"].includes(liderazgo)) {
      params.push(liderazgo);
      where.push(`LOWER(COALESCE(p.escala_influencia, '')) = $${params.length}`);
    }

    if (controversias === "1") {
      where.push(`
        EXISTS (
          SELECT 1
          FROM controversias_persona cp
          WHERE cp.id_persona = p.id_persona
        )
      `);
    }

    if (controversias === "0") {
      where.push(`
        NOT EXISTS (
          SELECT 1
          FROM controversias_persona cp
          WHERE cp.id_persona = p.id_persona
        )
      `);
    }

    if (verifLevel === "final") {
      where.push(`p.verificado_at IS NOT NULL`);
    }

    if (verifLevel === "office") {
      where.push(`
        p.verif_office_at IS NOT NULL
        AND p.verificado_at IS NULL
      `);
    }

    if (verifLevel === "area") {
      where.push(`
        p.verif_area_at IS NOT NULL
        AND p.verif_office_at IS NULL
        AND p.verificado_at IS NULL
      `);
    }

    if (verifLevel === "sin_verificar") {
      where.push(`
        p.verif_area_at IS NULL
        AND p.verif_office_at IS NULL
        AND p.verificado_at IS NULL
      `);
    }

    if (verifLevel === "parcial") {
      where.push(`
        (
          p.verif_area_at IS NOT NULL
          OR p.verif_office_at IS NOT NULL
        )
        AND p.verificado_at IS NULL
      `);
    }

    if (verifLevel === "cualquiera_verificado") {
      where.push(`
        (
          p.verif_area_at IS NOT NULL
          OR p.verif_office_at IS NOT NULL
          OR p.verificado_at IS NOT NULL
        )
      `);
    }

    if (fechaDesde) {
      params.push(fechaDesde);
      where.push(`p.created_at::date >= $${params.length}::date`);
    }

    if (fechaHasta) {
      params.push(fechaHasta);
      where.push(`p.created_at::date <= $${params.length}::date`);
    }

    if (referente) {
      const ref = referente.toLowerCase().trim();
      params.push(ref);
      const i = params.length;

      if (refMode === "exact") {
        where.push(`
          EXISTS (
            SELECT 1
            FROM referentes_politicos rp
            WHERE rp.id_persona = p.id_persona
              AND rp.nombre_full = $${i}
          )
        `);
      } else {
        where.push(`
          EXISTS (
            SELECT 1
            FROM referentes_politicos rp
            WHERE rp.id_persona = p.id_persona
              AND (
                (length($${i}) < 6 AND rp.nombre_full LIKE ($${i} || '%'))
                OR word_similarity(rp.nombre_full, $${i}) > 0.15
                OR similarity(rp.nombre_full, $${i}) > 0.15
              )
          )
        `);
      }
    }

    const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const baseTerritorialCTE = `
      WITH personas_filtradas AS (
        SELECT
          p.id_persona,
          p.id_oficina,
          p.escala_influencia,
          p.municipio_trabajo_politico,
          p.verif_area_at,
          p.verif_office_at,
          p.verificado_at
        FROM personas p
        ${whereSQL}
      ),
      cobertura_resuelta AS (
        SELECT
          pf.id_persona,
          pf.id_oficina,
          pf.escala_influencia,

          -- principal resuelto:
          COALESCE(principal_pmt.id_municipio, pf.municipio_trabajo_politico) AS id_municipio_principal,

          -- total municipios distintos considerando legacy + tabla hija
          COALESCE(cov.total_municipios, 0) AS total_municipios,

          -- ¿tiene una fila marcada como principal en personas_municipios_trabajo?
          COALESCE(cov.tiene_principal_marcado, 0) AS tiene_principal_marcado,

          CASE
            WHEN COALESCE(cov.total_municipios, 0) > 1 THEN 1
            ELSE 0
          END AS es_multi_municipio,

          CASE
            WHEN COALESCE(cov.total_municipios, 0) = 0 THEN 1
            ELSE 0
          END AS sin_municipio,

          pf.verif_area_at,
          pf.verif_office_at,
          pf.verificado_at
        FROM personas_filtradas pf

        LEFT JOIN LATERAL (
          SELECT pmt.id_municipio
          FROM personas_municipios_trabajo pmt
          WHERE pmt.id_persona = pf.id_persona
            AND pmt.es_principal = true
          LIMIT 1
        ) principal_pmt ON TRUE

        LEFT JOIN LATERAL (
          SELECT
            COUNT(DISTINCT x.id_municipio)::int AS total_municipios,
            MAX(CASE WHEN x.es_principal THEN 1 ELSE 0 END)::int AS tiene_principal_marcado
          FROM (
            SELECT
              pf.municipio_trabajo_politico AS id_municipio,
              true AS es_principal
            WHERE pf.municipio_trabajo_politico IS NOT NULL

            UNION ALL

            SELECT
              pmt.id_municipio,
              pmt.es_principal
            FROM personas_municipios_trabajo pmt
            WHERE pmt.id_persona = pf.id_persona
          ) x
          WHERE x.id_municipio IS NOT NULL
        ) cov ON TRUE
      )
    `;

    // resumen global
    const sqlResumen = `
      SELECT
        COUNT(*)::int AS total_actores,
        COUNT(*) FILTER (WHERE p.verif_area_at IS NOT NULL)::int AS verificados_direccion,
        COUNT(*) FILTER (WHERE p.verif_office_at IS NOT NULL)::int AS verificados_coordinacion,
        COUNT(*) FILTER (WHERE p.verificado_at IS NOT NULL)::int AS verificados_final,
        COUNT(*) FILTER (
          WHERE p.verif_office_at IS NOT NULL
            AND p.verificado_at IS NULL
        )::int AS pendientes_final,
        COUNT(*) FILTER (
          WHERE EXISTS (
            SELECT 1
            FROM controversias_persona c
            WHERE c.id_persona = p.id_persona
          )
        )::int AS con_controversias,
        COUNT(*) FILTER (
          WHERE COALESCE(lower(trim(p.nivel_confiabilidad)), '') = 'alto'
        )::int AS confiabilidad_alta
      FROM personas p
      ${whereSQL}
    `;

    // por oficina
    const sqlOficinas = `
      SELECT
        COALESCE(o.nombre, 'Sin oficina') AS oficina,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE p.verif_area_at IS NOT NULL)::int AS direccion,
        COUNT(*) FILTER (WHERE p.verif_office_at IS NOT NULL)::int AS coordinacion,
        COUNT(*) FILTER (WHERE p.verificado_at IS NOT NULL)::int AS final
      FROM personas p
      LEFT JOIN oficinas o ON o.id_oficina = p.id_oficina
      ${whereSQL}
      GROUP BY o.nombre
      ORDER BY total DESC, oficina ASC
    `;

    // por área
    const sqlAreas = `
      WITH areas_base AS (
        SELECT DISTINCT
          INITCAP(TRIM(COALESCE(u.area, 'Sin área'))) AS area
        FROM usuarios u
        WHERE 1=1
          ${oficinaId ? `AND u.id_oficina = ${Number(oficinaId)}` : ""}
          AND COALESCE(TRIM(u.area), '') <> ''
      ),
      personas_filtradas AS (
        SELECT
          p.id_persona,
          p.creado_por,
          p.verif_area_at,
          p.verif_office_at,
          p.verificado_at
        FROM personas p
        ${whereSQL}
      )
      SELECT
        ab.area,
        COUNT(pf.id_persona)::int AS total,
        COUNT(pf.id_persona) FILTER (
          WHERE pf.verif_area_at IS NOT NULL
        )::int AS direccion,
        COUNT(pf.id_persona) FILTER (
          WHERE pf.verif_office_at IS NOT NULL
        )::int AS coordinacion,
        COUNT(pf.id_persona) FILTER (
          WHERE pf.verificado_at IS NOT NULL
        )::int AS final
      FROM areas_base ab
      LEFT JOIN usuarios u
        ON INITCAP(TRIM(COALESCE(u.area, 'Sin área'))) = ab.area
        ${oficinaId ? `AND u.id_oficina = ${Number(oficinaId)}` : ""}
      LEFT JOIN personas_filtradas pf
        ON pf.creado_por = u.id_usuario
      GROUP BY ab.area
      ORDER BY total DESC, ab.area ASC
    `;

    const sqlMultiMunicipioOficina = `
      ${baseTerritorialCTE}
      SELECT
        COALESCE(o.nombre, 'Sin oficina') AS oficina,
        COUNT(*)::int AS total,

        COUNT(*) FILTER (
          WHERE cr.total_municipios = 1
        )::int AS solo_principal,

        COUNT(*) FILTER (
          WHERE cr.total_municipios > 1
        )::int AS multi_municipio,

        COUNT(*) FILTER (
          WHERE cr.sin_municipio = 1
        )::int AS sin_municipio,

        COUNT(*) FILTER (
          WHERE cr.tiene_principal_marcado = 1
        )::int AS principal_marcado

      FROM cobertura_resuelta cr
      LEFT JOIN oficinas o
        ON o.id_oficina = cr.id_oficina
      GROUP BY o.nombre
      ORDER BY total DESC, oficina ASC
    `;
    
  const sqlResumenTerritorial = `
    ${baseTerritorialCTE}
    SELECT
      COUNT(*)::int AS total_registros,
      COUNT(*) FILTER (WHERE total_municipios = 1)::int AS solo_principal_total,
      COUNT(*) FILTER (WHERE total_municipios > 1)::int AS multi_municipio_total,
      COUNT(*) FILTER (WHERE sin_municipio = 1)::int AS sin_municipio_total,
      COUNT(*) FILTER (WHERE tiene_principal_marcado = 1)::int AS principal_marcado_total,
      COUNT(*) FILTER (WHERE id_municipio_principal IS NULL)::int AS sin_principal_total,
      COUNT(*) FILTER (
        WHERE id_municipio_principal IS NULL
          AND total_municipios > 0
      )::int AS con_cobertura_sin_principal
    FROM cobertura_resuelta
  `;

  const sqlEscalas = `
    ${baseTerritorialCTE}
    SELECT
      t.escala,
      COUNT(*)::int AS total
    FROM (
      SELECT
        CASE
          WHEN LOWER(COALESCE(cr.escala_influencia, '')) = 'municipal' THEN 'Municipal'
          WHEN LOWER(COALESCE(cr.escala_influencia, '')) = 'regional' THEN 'Regional'
          WHEN LOWER(COALESCE(cr.escala_influencia, '')) = 'distrital' THEN 'Distrital'
          WHEN LOWER(COALESCE(cr.escala_influencia, '')) = 'estatal' THEN 'Estatal'
          WHEN LOWER(COALESCE(cr.escala_influencia, '')) = 'nacional' THEN 'Nacional'
          ELSE 'Sin nivel'
        END AS escala
      FROM cobertura_resuelta cr
    ) t
    GROUP BY t.escala
    ORDER BY
      CASE
        WHEN t.escala = 'Municipal' THEN 1
        WHEN t.escala = 'Regional' THEN 2
        WHEN t.escala = 'Distrital' THEN 3
        WHEN t.escala = 'Estatal' THEN 4
        WHEN t.escala = 'Nacional' THEN 5
        ELSE 6
      END
  `;

    // top municipios
    const sqlMunicipios = `
      ${baseTerritorialCTE}
      SELECT
        COALESCE(m.nombre, 'Sin municipio principal') AS municipio,
        COUNT(*)::int AS total
      FROM cobertura_resuelta cr
      LEFT JOIN municipios m
        ON m.id_municipio = cr.id_municipio_principal
      GROUP BY COALESCE(m.nombre, 'Sin municipio principal')
      ORDER BY total DESC, municipio ASC
      LIMIT 15
    `;

    const [
      rResumen,
      rOficinas,
      rAreas,
      rMunicipios,
      rMultiMunicipio,
      rResumenTerritorial,
      rEscalas
    ] = await Promise.all([
      client.query(sqlResumen, params),
      client.query(sqlOficinas, params),
      client.query(sqlAreas, params),
      client.query(sqlMunicipios, params),
      client.query(sqlMultiMunicipioOficina, params),
      client.query(sqlResumenTerritorial, params),
      client.query(sqlEscalas, params)
    ]);

    const resumen = rResumen.rows[0] || {};
    const oficinas = rOficinas.rows || [];
    const areas = rAreas.rows || [];
    const municipios = rMunicipios.rows || [];
    const multiMunicipioOficinas = rMultiMunicipio.rows || [];
    const resumenTerritorial = rResumenTerritorial.rows[0] || {};
    const escalas = rEscalas.rows || [];

    const filtros = {
      q,
      oficina: oficinaNombreFiltro || "Todas",
      capturista: req.query.capturistaId || "",
      municipio: req.query.municipio_trabajo || "",
      verificacion: verifLevel || req.query.verificado || "",
      partido: partidoIdRaw || "",
      confiabilidad,
      liderazgo,
      controversias:
        controversias === "1" ? "Con controversias" :
        controversias === "0" ? "Sin controversias" : "",
      referente,
      fechaDesde,
      fechaHasta
    };

    const html = buildReporteEjecutivoHtml({
      user: req.user,
      filtros,
      resumen,
      oficinas,
      areas,
      municipios,
      multiMunicipioOficinas,
      resumenTerritorial,
      escalas
    });

    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });

    const pdfRaw = await page.pdf({
      format: "A4",
      printBackground: true,

      displayHeaderFooter: true,

      margin: {
        top: "15mm",
        right: "10mm",
        bottom: "20mm",
        left: "10mm"
      },

      footerTemplate: `
        <div style="
          width:100%;
          font-size:9px;
          color:#6b7280;
          padding:0 10mm;
          display:flex;
          justify-content:space-between;
          align-items:center;
        ">
          <span>Sistema de Actores Políticos</span>
          <span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span>
        </div>
      `,

      headerTemplate: `
        <div style="font-size:0;"></div>
      `
    });

    await browser.close();

    // ✅ Convertir explícitamente a Buffer real
    const pdf = Buffer.from(pdfRaw);

    console.log("PDF buffer length:", pdf.length);
    console.log("PDF header:", pdf.slice(0, 5).toString());

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="reporte-ejecutivo.pdf"');
    res.setHeader("Content-Length", pdf.length);

    return res.end(pdf);

  } catch (e) {
    console.error(e);
    return res.status(500).json({
      error: "Error al generar reporte ejecutivo",
      detail: e.message
    });
  } finally {
    client.release();
  }
};


// KPI completitud (superadmin: todo, analista: solo su oficina)
// KPI COMPLETUD PRO - BASADO EN getPerfilCompleto
exports.kpiCompletitud = async (req, res) => {
  try {
        const roles = req.user?.roles || [];
        const isSuperadmin = roles.includes("superadmin");
        const officeId = req.user?.id_oficina ?? null;

        // ✅ Params base FIJOS para rol/oficina
        const params = [officeId, isSuperadmin];
        const whereExtra = [];

        // ✅ Smart filters SOLO extras (no sobrescribe base)
        if (req.smartFilters?.addFullFilter) {
          req.smartFilters.addFullFilter(params, whereExtra);
        }

        // ✅ WHERE base + extras
        let whereBase = "($2::boolean = true OR p.id_oficina = $1::int)";
        // ✅ DESPUÉS (asegura paréntesis)
        if (whereExtra.length > 0) {
          whereBase += ' AND (' + whereExtra.join(' AND ') + ')';
        }


    const SQL = `
      WITH personas_filtradas AS (
        SELECT p.id_persona, p.id_oficina, p.creado_por
        FROM personas p
        WHERE ${whereBase}
      ),
      
       -- 1. DATOS BASE (campos principales)
      datos_base AS (
        SELECT
          pf.id_persona,
          pf.id_oficina,
          pf.creado_por,
         
          -- IDENTIDAD (25%)
          (NULLIF(TRIM(COALESCE(p.nombre,'')), '') IS NOT NULL)::int * 5 +
          (NULLIF(TRIM(COALESCE(p.apellido_paterno,'')), '') IS NOT NULL)::int * 5 +
          (NULLIF(TRIM(COALESCE(p.apellido_materno,'')), '') IS NOT NULL)::int * 5 +
          (NULLIF(TRIM(COALESCE(p.curp,'')), '') IS NOT NULL)::int * 5 +
          (NULLIF(TRIM(COALESCE(p.rfc,'')), '') IS NOT NULL)::int * 5 AS score_identidad,


          -- TERRITORIO (20%)
          (p.municipio_trabajo_politico IS NOT NULL)::int * 8 +
          (CASE
            WHEN p.res_legal_fuera_edomex THEN
              NULLIF(TRIM(p.res_legal_municipio_texto), '') IS NOT NULL
            ELSE p.municipio_residencia_legal IS NOT NULL
          END)::int * 6 +
          (CASE
            WHEN p.res_real_fuera_edomex THEN
              NULLIF(TRIM(p.res_real_municipio_texto), '') IS NOT NULL
            ELSE p.municipio_residencia_real IS NOT NULL
          END)::int * 6 AS score_territorio,


          -- POLÍTICA (20%)
          (p.id_partido_actual IS NOT NULL)::int * 6 +
          (p.id_tema_interes_central IS NOT NULL)::int * 6 +
          (p.id_grupo_postulacion IS NOT NULL)::int * 4 +
          (p.id_ideologia_politica IS NOT NULL)::int * 4 AS score_politica,


          -- CONTACTO (15%)
          (EXISTS(SELECT 1 FROM telefonos t WHERE t.id_persona = pf.id_persona))::int * 8 +
          (EXISTS(SELECT 1 FROM datos_ine di WHERE di.id_persona = pf.id_persona))::int * 4 +
          (EXISTS(SELECT 1 FROM redes_sociales_persona rsp WHERE rsp.id_persona = pf.id_persona))::int * 3 AS score_contacto,


          -- TRAYECTORIA (20%)
          (EXISTS(SELECT 1 FROM servicio_publico sp WHERE sp.id_persona = pf.id_persona))::int * 5 +
          (EXISTS(SELECT 1 FROM elecciones_contendidas ec WHERE ec.id_persona = pf.id_persona))::int * 5 +
          (EXISTS(SELECT 1 FROM cargos_eleccion_popular cep WHERE cep.id_persona = pf.id_persona))::int * 5 +
          (EXISTS(SELECT 1 FROM experiencia_laboral el WHERE el.id_persona = pf.id_persona))::int * 5 AS score_trayectoria
         
        FROM personas_filtradas pf
        JOIN personas p ON p.id_persona = pf.id_persona
      ),


      -- 2. SCORES FINALES POR PERSONA
      scored AS (
        SELECT
          *,
          (score_identidad + score_territorio + score_politica + score_contacto + score_trayectoria)::numeric(5,2) AS score_total,
          score_identidad::numeric(5,2) AS pct_identidad,
          score_territorio::numeric(5,2) AS pct_territorio,
          score_politica::numeric(5,2) AS pct_politica,
          score_contacto::numeric(5,2) AS pct_contacto,
          score_trayectoria::numeric(5,2) AS pct_trayectoria
        FROM datos_base
      ),


      -- 3. GLOBAL
      global_stats AS (
        SELECT
          COUNT(*)::int AS total_personas,
          ROUND(AVG(score_total), 2) AS score_promedio,
          ROUND(AVG(pct_identidad), 2) AS pct_identidad_prom,
          ROUND(AVG(pct_territorio), 2) AS pct_territorio_prom,
          ROUND(AVG(pct_politica), 2) AS pct_politica_prom,
          ROUND(AVG(pct_contacto), 2) AS pct_contacto_prom,
          ROUND(AVG(pct_trayectoria), 2) AS pct_trayectoria_prom,
         
          SUM(CASE WHEN score_total >= 80 THEN 1 ELSE 0 END)::int AS completos_80,
          ROUND(100.0 * SUM(CASE WHEN score_total >= 80 THEN 1 ELSE 0 END) / COUNT(*), 2) AS pct_completos_80,
         
          SUM(CASE WHEN score_total < 50 THEN 1 ELSE 0 END)::int AS criticos_lt50,
          ROUND(100.0 * SUM(CASE WHEN score_total < 50 THEN 1 ELSE 0 END) / COUNT(*), 2) AS pct_criticos_lt50
        FROM scored
      ),


      -- 4. POR USUARIO
      por_usuario AS (
        SELECT
          u.id_usuario, u.nombre, u.email, u.area,
          COUNT(s.id_persona)::int AS total,
          ROUND(AVG(s.score_total), 2) AS score_promedio,
          SUM(CASE WHEN s.score_total >= 80 THEN 1 ELSE 0 END)::int AS completos_80,
          ROUND(100.0 * SUM(CASE WHEN s.score_total >= 80 THEN 1 ELSE 0 END) / COUNT(*), 2) AS pct_completos_80
        FROM scored s
        JOIN usuarios u ON u.id_usuario = s.creado_por
        GROUP BY u.id_usuario, u.nombre, u.email, u.area
        ORDER BY score_promedio DESC, total DESC
      ),


      -- 5. POR OFICINA
      por_oficina AS (
        SELECT
          o.id_oficina, o.nombre AS oficina,
          COUNT(s.id_persona)::int AS total,
          ROUND(AVG(s.score_total), 2) AS score_promedio,
          SUM(CASE WHEN s.score_total >= 80 THEN 1 ELSE 0 END)::int AS completos_80,
          ROUND(100.0 * SUM(CASE WHEN s.score_total >= 80 THEN 1 ELSE 0 END) / COUNT(*), 2) AS pct_completos_80
        FROM scored s
        JOIN oficinas o ON o.id_oficina = s.id_oficina
        GROUP BY o.id_oficina, o.nombre
        ORDER BY score_promedio DESC
      ),


      -- 6. TOP PROBLEMAS (faltan datos críticos)
      problemas AS (
        SELECT
          'CURP'::text AS campo,
          COUNT(*)::int AS faltantes
        FROM personas_filtradas pf
        JOIN personas p ON p.id_persona = pf.id_persona
        WHERE NULLIF(TRIM(p.curp), '') IS NULL
       
        UNION ALL
       
        SELECT
          'Teléfonos'::text AS campo,
          COUNT(*)::int AS faltantes
        FROM personas_filtradas pf
        WHERE NOT EXISTS(SELECT 1 FROM telefonos t WHERE t.id_persona = pf.id_persona)
       
        UNION ALL
       
        SELECT
          'Trabajo Político'::text AS campo,
          COUNT(*)::int AS faltantes
        FROM personas_filtradas pf
        JOIN personas p ON p.id_persona = pf.id_persona
        WHERE p.municipio_trabajo_politico IS NULL
      )


      SELECT
        (SELECT row_to_json(global_stats) FROM global_stats) AS global,
        (SELECT COALESCE(json_agg(por_usuario), '[]') FROM por_usuario) AS por_usuario,
        (SELECT COALESCE(json_agg(por_oficina), '[]') FROM por_oficina) AS por_oficina,
        (SELECT COALESCE(json_agg(problemas ORDER BY faltantes DESC), '[]') FROM problemas) AS problemas_criticos,
       
        -- SECCIONES PROMEDIO
        jsonb_build_object(
          'identidad', (SELECT ROUND(AVG(pct_identidad), 1) FROM scored),
          'territorio', (SELECT ROUND(AVG(pct_territorio), 1) FROM scored),
          'politica', (SELECT ROUND(AVG(pct_politica), 1) FROM scored),
          'contacto', (SELECT ROUND(AVG(pct_contacto), 1) FROM scored),
          'trayectoria', (SELECT ROUND(AVG(pct_trayectoria), 1) FROM scored)
        ) AS secciones_promedio
    `;

    const { rows } = await pool.query(SQL, params);
    return res.json(rows[0]);

  } catch (e) {
    console.error('ERROR COMPLETO:', e);  // ← Más detalle
    return res.status(500).json({ error: "Error KPI Completitud PRO", detail: e.message });
  }
};


// KPI MUNICIPIOS - CON FILTRO OFICINA (igual que kpiCompletitud)
exports.kpiMunicipios = async (req, res) => {
  try {
    const roles = req.user?.roles || [];
    const isSuperadmin = roles.includes("superadmin");
    const officeId = req.user?.id_oficina ?? null;

    // ✅ SMART FILTERS - Igual que kpiCompletitud
    const params = [officeId, isSuperadmin];
    const whereExtra = [];

    if (req.smartFilters?.addFullFilter) {
      req.smartFilters.addFullFilter(params, whereExtra);
    }

    // ✅ WHERE base + extras
    let whereBase = "($2::boolean = true OR p.id_oficina = $1::int)";
    if (whereExtra.length > 0) {
      const condicionesLimpias = whereExtra.map(cond => cond.trim().replace(/;\s*$/, ''));
      whereBase += ' AND (' + condicionesLimpias.join(' AND ') + ')';
    }

    const SQL = `
      WITH conteo AS (
        SELECT
          m.id_municipio,
          m.nombre AS municipio,
          COUNT(p.id_persona)::int AS total
        FROM municipios m
        LEFT JOIN personas p ON p.municipio_trabajo_politico = m.id_municipio
          AND ${whereBase}  -- ✅ FILTRO INTEGRADO AQUÍ
        GROUP BY m.id_municipio, m.nombre
      ),
      resumen AS (
        SELECT
          COUNT(*)::int AS total_municipios,
          SUM(CASE WHEN total > 0 THEN 1 ELSE 0 END)::int AS municipios_con_registros,
          SUM(CASE WHEN total = 0 THEN 1 ELSE 0 END)::int AS municipios_sin_registros,
          SUM(total)::int AS total_personas
        FROM conteo
      ),
      top10 AS (
        SELECT * FROM conteo
        ORDER BY total DESC, municipio ASC
        LIMIT 10
      ),
      bottom10 AS (
        SELECT * FROM conteo
        WHERE total > 0
        ORDER BY total ASC, municipio ASC
        LIMIT 10
      ),
      cero AS (
        SELECT * FROM conteo
        WHERE total = 0
        ORDER BY municipio ASC
      )
      SELECT
        (SELECT row_to_json(resumen) FROM resumen) AS resumen,
        (SELECT COALESCE(json_agg(top10), '[]'::json) FROM top10) AS top10,
        (SELECT COALESCE(json_agg(bottom10), '[]'::json) FROM bottom10) AS bottom10,
        (SELECT COALESCE(json_agg(cero), '[]'::json) FROM cero) AS cero,
        (SELECT COALESCE(json_agg(conteo ORDER BY municipio), '[]'::json) FROM conteo) AS conteo
    `;

    // DEBUG temporal (quítalo después)
    const { rows } = await pool.query(SQL, params);
    return res.json(rows[0]);

  } catch (e) {
    console.error('ERROR kpiMunicipios:', e);
    return res.status(500).json({ error: "Error KPI municipios", detail: e.message });
  }
};

exports.kpiVerificacion = async (req, res) => {
  const client = await pool.connect();
  try {
    const params = [];
    const where = [];

    // scope
    req.smartFilters?.addFullFilter?.(params, where);

    // filtros manuales
    const oficinaId = req.query.oficinaId ? Number(req.query.oficinaId) : null;
    const capturistaId = req.query.capturistaId ? Number(req.query.capturistaId) : null;
    const idMunTrabajo = req.query.municipio_trabajo ? Number(req.query.municipio_trabajo) : null;
    const q = (req.query.q || "").trim();

    const verifLevel = String(req.query.verifLevel || "").trim().toLowerCase();
    const verificado = (req.query.verificado === "1" || req.query.verificado === "0")
      ? req.query.verificado
      : null;

    const partidoIdRaw = String(req.query.partidoId || "").trim();
    const confiabilidad = (req.query.confiabilidad || "").trim().toLowerCase();
    const liderazgo = (req.query.liderazgo || "").trim().toLowerCase();

    const controversias =
      (req.query.controversias === "1" || req.query.controversias === "0")
        ? req.query.controversias
        : null;

    if (oficinaId) {
      params.push(oficinaId);
      where.push(`p.id_oficina = $${params.length}`);
    }

    if (capturistaId) {
      params.push(capturistaId);
      where.push(`p.creado_por = $${params.length}`);
    }

    if (Number.isFinite(idMunTrabajo) && idMunTrabajo > 0) {
      params.push(idMunTrabajo);
      where.push(`p.municipio_trabajo_politico = $${params.length}`);
    }

    if (q) {
      params.push(`%${q}%`);
      const i = params.length;
      where.push(`
        (
          COALESCE(p.nombre,'') ILIKE $${i}
          OR COALESCE(p.apellido_paterno,'') ILIKE $${i}
          OR COALESCE(p.apellido_materno,'') ILIKE $${i}
          OR COALESCE(p.curp,'') ILIKE $${i}
          OR COALESCE(p.rfc,'') ILIKE $${i}
          OR COALESCE(p.clave_elector,'') ILIKE $${i}
        )
      `);
    }

    if (partidoIdRaw === "__OTRO__") {
      where.push(`COALESCE(TRIM(p.partido_otro_texto), '') <> ''`);
    } else {
      const partidoId = Number(partidoIdRaw);
      if (Number.isFinite(partidoId) && partidoId > 0) {
        params.push(partidoId);
        where.push(`p.id_partido_actual = $${params.length}`);
      }
    }

    if (["alto", "medio", "bajo"].includes(confiabilidad)) {
      params.push(confiabilidad);
      where.push(`LOWER(COALESCE(p.nivel_confiabilidad, '')) = $${params.length}`);
    }

    if (["municipal", "regional", "distrital", "estatal", "nacional"].includes(liderazgo)) {
      params.push(liderazgo);
      where.push(`LOWER(COALESCE(p.escala_influencia, '')) = $${params.length}`);
    }

    if (controversias === "1") {
      where.push(`
        EXISTS (
          SELECT 1
          FROM controversias_persona cp
          WHERE cp.id_persona = p.id_persona
        )
      `);
    }

    if (controversias === "0") {
      where.push(`
        NOT EXISTS (
          SELECT 1
          FROM controversias_persona cp
          WHERE cp.id_persona = p.id_persona
        )
      `);
    }

    if (verificado === "1") where.push(`p.verificado_at IS NOT NULL`);
    if (verificado === "0") where.push(`p.verificado_at IS NULL`);

    if (verifLevel === "final") {
      where.push(`p.verificado_at IS NOT NULL`);
    }

    if (verifLevel === "office") {
      where.push(`
        p.verif_office_at IS NOT NULL
        AND p.verificado_at IS NULL
      `);
    }

    if (verifLevel === "area") {
      where.push(`
        p.verif_area_at IS NOT NULL
        AND p.verif_office_at IS NULL
        AND p.verificado_at IS NULL
      `);
    }

    if (verifLevel === "sin_verificar") {
      where.push(`
        p.verif_area_at IS NULL
        AND p.verif_office_at IS NULL
        AND p.verificado_at IS NULL
      `);
    }

    if (verifLevel === "parcial") {
      where.push(`
        (
          p.verif_area_at IS NOT NULL
          OR p.verif_office_at IS NOT NULL
        )
        AND p.verificado_at IS NULL
      `);
    }

    if (verifLevel === "cualquiera_verificado") {
      where.push(`
        (
          p.verif_area_at IS NOT NULL
          OR p.verif_office_at IS NOT NULL
          OR p.verificado_at IS NOT NULL
        )
      `);
    }

    const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const sql = `
      SELECT
        CASE
          WHEN p.verificado_at IS NOT NULL THEN 'FINAL'
          WHEN p.verif_office_at IS NOT NULL THEN 'OFFICE'
          WHEN p.verif_area_at IS NOT NULL THEN 'AREA'
          ELSE 'SIN VERIFICAR'
        END AS estado_verificacion,
        COUNT(*)::int AS total
      FROM personas p
      ${whereSQL}
      GROUP BY 1
      ORDER BY 1
    `;

    const { rows } = await client.query(sql, params);
    return res.json({ ok: true, data: rows });

  } catch (e) {
    console.error("ERROR kpiVerificacion:", e);
    return res.status(500).json({ error: "Error KPI verificación", detail: e.message });
  } finally {
    client.release();
  }
};

exports.kpiOficinas = async (req, res) => {
  const client = await pool.connect();
  try {
    const params = [];
    const where = [];

    req.smartFilters?.addFullFilter?.(params, where);

    const oficinaId = req.query.oficinaId ? Number(req.query.oficinaId) : null;
    const capturistaId = req.query.capturistaId ? Number(req.query.capturistaId) : null;
    const idMunTrabajo = req.query.municipio_trabajo ? Number(req.query.municipio_trabajo) : null;
    const q = (req.query.q || "").trim();

    const verifLevel = String(req.query.verifLevel || "").trim().toLowerCase();
    const partidoIdRaw = String(req.query.partidoId || "").trim();
    const confiabilidad = (req.query.confiabilidad || "").trim().toLowerCase();
    const liderazgo = (req.query.liderazgo || "").trim().toLowerCase();

    const controversias =
      (req.query.controversias === "1" || req.query.controversias === "0")
        ? req.query.controversias
        : null;

    if (oficinaId) {
      params.push(oficinaId);
      where.push(`p.id_oficina = $${params.length}`);
    }

    if (capturistaId) {
      params.push(capturistaId);
      where.push(`p.creado_por = $${params.length}`);
    }

    if (Number.isFinite(idMunTrabajo) && idMunTrabajo > 0) {
      params.push(idMunTrabajo);
      where.push(`p.municipio_trabajo_politico = $${params.length}`);
    }

    if (q) {
      params.push(`%${q}%`);
      const i = params.length;
      where.push(`
        (
          COALESCE(p.nombre,'') ILIKE $${i}
          OR COALESCE(p.apellido_paterno,'') ILIKE $${i}
          OR COALESCE(p.apellido_materno,'') ILIKE $${i}
          OR COALESCE(p.curp,'') ILIKE $${i}
          OR COALESCE(p.rfc,'') ILIKE $${i}
          OR COALESCE(p.clave_elector,'') ILIKE $${i}
        )
      `);
    }

    if (partidoIdRaw === "__OTRO__") {
      where.push(`COALESCE(TRIM(p.partido_otro_texto), '') <> ''`);
    } else {
      const partidoId = Number(partidoIdRaw);
      if (Number.isFinite(partidoId) && partidoId > 0) {
        params.push(partidoId);
        where.push(`p.id_partido_actual = $${params.length}`);
      }
    }

    if (["alto", "medio", "bajo"].includes(confiabilidad)) {
      params.push(confiabilidad);
      where.push(`LOWER(COALESCE(p.nivel_confiabilidad, '')) = $${params.length}`);
    }

    if (["municipal", "regional", "distrital", "estatal", "nacional"].includes(liderazgo)) {
      params.push(liderazgo);
      where.push(`LOWER(COALESCE(p.escala_influencia, '')) = $${params.length}`);
    }

    if (controversias === "1") {
      where.push(`
        EXISTS (
          SELECT 1
          FROM controversias_persona cp
          WHERE cp.id_persona = p.id_persona
        )
      `);
    }

    if (controversias === "0") {
      where.push(`
        NOT EXISTS (
          SELECT 1
          FROM controversias_persona cp
          WHERE cp.id_persona = p.id_persona
        )
      `);
    }

    if (verifLevel === "final") {
      where.push(`p.verificado_at IS NOT NULL`);
    }

    if (verifLevel === "office") {
      where.push(`
        p.verif_office_at IS NOT NULL
        AND p.verificado_at IS NULL
      `);
    }

    if (verifLevel === "area") {
      where.push(`
        p.verif_area_at IS NOT NULL
        AND p.verif_office_at IS NULL
        AND p.verificado_at IS NULL
      `);
    }

    if (verifLevel === "sin_verificar") {
      where.push(`
        p.verif_area_at IS NULL
        AND p.verif_office_at IS NULL
        AND p.verificado_at IS NULL
      `);
    }

    const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const sql = `
      SELECT
        COALESCE(o.nombre, 'Sin oficina') AS oficina,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE p.verificado_at IS NOT NULL)::int AS finalizados
      FROM personas p
      LEFT JOIN oficinas o ON o.id_oficina = p.id_oficina
      ${whereSQL}
      GROUP BY o.nombre
      ORDER BY total DESC, oficina ASC
    `;

    const { rows } = await client.query(sql, params);
    return res.json({ ok: true, data: rows });

  } catch (e) {
    console.error("ERROR kpiOficinas:", e);
    return res.status(500).json({ error: "Error KPI oficinas", detail: e.message });
  } finally {
    client.release();
  }
};




//validacion de datos duplicados;

exports.checkDuplicado = async (req, res) => {
  try {
    const curp = (req.query.curp || "").trim().toUpperCase();
    const rfc  = (req.query.rfc  || "").trim().toUpperCase();
    const nombre = (req.query.nombre || "").trim();
    const ap = (req.query.apellido_paterno || "").trim();
    const am = (req.query.apellido_materno || "").trim();
    const mun = req.query.municipio ? Number(req.query.municipio) : null;
    const clave_elector = (req.query.clave_elector || "").trim().toUpperCase();
    const seccion_electoral = (req.query.seccion_electoral || "").trim();

    const excludeId = Number(req.query.exclude_id);
    const excludeOk = Number.isFinite(excludeId) && excludeId > 0;

    const results = [];

    // 1) Exacto por CURP
    if (curp) {
      const params = [curp];
      let extra = "";
      if (excludeOk) { params.push(excludeId); extra = " AND id_persona <> $2"; }

      const q = await pool.query(
        `
        SELECT id_persona, nombre, apellido_paterno, apellido_materno, id_oficina
        FROM personas
        WHERE curp = $1
        ${extra}
        LIMIT 5
        `,
        params
      );

      if (q.rowCount) results.push({ match_type: "curp", candidates: q.rows });
    }

    // 2) Exacto por RFC
    if (rfc) {
      const params = [rfc];
      let extra = "";
      if (excludeOk) { params.push(excludeId); extra = " AND id_persona <> $2"; }

      const q = await pool.query(
        `
        SELECT id_persona, nombre, apellido_paterno, apellido_materno, id_oficina
        FROM personas
        WHERE rfc = $1
        ${extra}
        LIMIT 5
        `,
        params
      );

      if (q.rowCount) results.push({ match_type: "rfc", candidates: q.rows });
    }

    // 3) Posible por nombre+apellidos (+mun opcional)
    if (nombre && ap) {
      // params base
      const params = [nombre, ap, am || "", mun];
      let extra = "";

      if (excludeOk) {
        params.push(excludeId);
        extra = ` AND id_persona <> $5 `;
      }

      const q = await pool.query(
        `
        SELECT id_persona, nombre, apellido_paterno, apellido_materno, id_oficina
        FROM personas
        WHERE lower(nombre) = lower($1)
          AND lower(apellido_paterno) = lower($2)
          AND ( $3 = '' OR lower(coalesce(apellido_materno,'')) = lower($3) )
          AND ( $4::int IS NULL OR municipio_residencia_legal = $4::int )
          ${extra}
        ORDER BY id_persona DESC
        LIMIT 10
        `,
        params
      );

      if (q.rowCount) results.push({ match_type: "nombre", candidates: q.rows });
    }

    // 4) Exacto por clave elector
    if (clave_elector) {
      const params = [clave_elector];
      let extra = "";
      if (excludeOk) { params.push(excludeId); extra = " AND id_persona <> $2"; }

      const q = await pool.query(
        `
        SELECT id_persona, nombre, apellido_paterno, apellido_materno, id_oficina
        FROM personas
        WHERE upper(clave_elector) = $1
        ${extra}
        LIMIT 5
        `,
        params
      );

      if (q.rowCount) results.push({ match_type: "clave_elector", candidates: q.rows });
    }


    // 5) Sección electoral: SOLO como señal si además hay nombre+apellido_paterno
    if (seccion_electoral && nombre && ap) {
      const params = [seccion_electoral, nombre, ap, am || ""];
      let extra = "";

      if (excludeOk) {
        params.push(excludeId);
        extra = ` AND p.id_persona <> $5 `;
      }

      const q = await pool.query(
        `
        SELECT p.id_persona, p.nombre, p.apellido_paterno, p.apellido_materno, p.id_oficina
        FROM datos_ine d
        JOIN personas p ON p.id_persona = d.id_persona
        WHERE d.seccion_electoral = $1
          AND lower(p.nombre) = lower($2)
          AND lower(p.apellido_paterno) = lower($3)
          AND ($4 = '' OR lower(coalesce(p.apellido_materno,'')) = lower($4))
          ${extra}
        LIMIT 10
        `,
        params
      );

      if (q.rowCount) results.push({ match_type: "seccion_electoral", candidates: q.rows });
    }

    return res.json({ ok: true, results });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Error en checkDuplicado", detail: e.message });
  }
};

function validateLiderazgo(input) {
  if (input == null) return { ok: true, data: null };

  if (typeof input === "string") {
    try { input = JSON.parse(input); } catch {}
  }
  if (typeof input !== "object") {
    return { ok: false, error: "liderazgo_influencia inválido (formato)" };
  }

  const nivel = (input.nivel || "").toString().trim().toLowerCase() || null;
  const nivelesValidos = ["alto", "medio", "bajo", "nulo"];

  const CANON = {
    "territorial": "territorial",
    "politico_institucional": "politico_institucional",
    "politico-institucional": "politico_institucional",
    "social_comunitario": "social_comunitario",
    "social-comunitario": "social_comunitario",
    "social/comunitario": "social_comunitario",
    "empresarial": "empresarial",
    "mediatico": "mediatico",
    "tecnico_especializado": "tecnico_especializado",
    "tecnico-especializado": "tecnico_especializado",
    "tecnico/especializado": "tecnico_especializado",
    "otro": "otro",
  };

  const normalizaTipo = (t) => {
    if (!t) return "";
    const raw = t.toString()
      .replace("–", "-")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    return CANON[raw] || raw;
  };

  const tipos = Array.isArray(input.tipos) ? input.tipos : [];
  const tiposNorm = tipos.map(normalizaTipo).filter(Boolean);
  const tiposValidos = new Set(Object.values(CANON));

  let tipo_otro_texto = (input.tipo_otro_texto || "").toString().trim() || null;
  if (tiposNorm.includes("otro")) {
    if (!tipo_otro_texto) return { ok:false, error:"Si seleccionas 'Otro' en tipo de liderazgo, captura el texto." };
  } else {
    tipo_otro_texto = null;
  }

  // boolean seguro
  const c = input.cuenta_con_estructura;
  let cuenta_con_estructura = null;
  if (c === true || c === false) cuenta_con_estructura = c;
  else if (typeof c === "string") {
    if (c === "true") cuenta_con_estructura = true;
    else if (c === "false") cuenta_con_estructura = false;
  }

  const presencia_territorial = (input.presencia_territorial || "").toString().trim().toLowerCase() || null;
  const presValidas = ["permanente", "eventual", "nula"];
  if (presencia_territorial && !presValidas.includes(presencia_territorial)) {
    return { ok:false, error:"presencia_territorial inválida (permanente|eventual|nula)" };
  }

  const tieneAlgo =
    !!nivel || tiposNorm.length > 0 || !!tipo_otro_texto ||
    cuenta_con_estructura !== null || !!presencia_territorial;

  if (!tieneAlgo) return { ok:true, data:null };

  if (!nivel) return { ok:false, error:"Liderazgo: selecciona nivel." };
  if (!nivelesValidos.includes(nivel)) return { ok:false, error:"Liderazgo: nivel inválido." };

  if (!tiposNorm.length) return { ok:false, error:"Liderazgo: selecciona al menos un tipo." };

  for (const t of tiposNorm) {
    if (!tiposValidos.has(t)) return { ok:false, error:`Liderazgo: tipo inválido (${t}).` };
  }

  return {
    ok: true,
    data: { nivel, tipos: tiposNorm, tipo_otro_texto, cuenta_con_estructura, presencia_territorial }
  };
}

//editar 

exports.updatePersonaCompleta = async (req, res) => {
  const client = await pool.connect();
  const id_persona = Number(req.params.id);
  if (!id_persona) return res.status(400).json({ error: "id inválido" });
  await assertCanMutatePersona(client, req, id_persona);
  try {
    
    const {
      persona,
      grupos_postulacion=[],
      datos_ine = null,
      telefonos = [],
      parejas = [],
      hijos = [],
      redes = [],
      servicio_publico = [],
      elecciones = [],
      capacidad_movilizacion_eventos = [],
      equipos = [],
      referentes = [],
      controversias = [],
      formacion_academica = [],
      familiares = [],
      temas_interes = [],
      participacion_organizaciones = [],
      cargos_eleccion_popular = [],
      experiencia_laboral = [],
      empresas_persona=[],
      fuentes_consulta=[],
      liderazgo_influencia = null,
    } = req.body;


    if (!persona?.apellido_paterno) {
      return res.status(400).json({ error: "Apellido paterno es obligatorio" });
    }
    if (!persona?.apellido_materno) {
      return res.status(400).json({ error: "Apellido materno es obligatorio" });
    }
    if (!persona?.nombre) {
      return res.status(400).json({ error: "Nombre es obligatorio" });
    }
    //validacion grupos de posutlacion
    const gruposPostulacion = Array.isArray(grupos_postulacion)
    ? [...new Set(grupos_postulacion.map(Number).filter(Boolean))]
    : [];



    // Reglas oficina por usuario (idénticas a create)
    const roles = req.user.roles || [];
    const isSuperadmin = roles.includes("superadmin");

    if (!isSuperadmin && !req.user.id_oficina) {
      return res.status(403).json({ error: "Usuario sin oficina asignada" });
    }

    // ⚠️ oficina se calcula DESPUÉS de obtener ownerRows para no pisar la oficina original
    let oficinaFinal; // se asigna más abajo, tras obtener el registro actual

    // Validación: controversias vs sin_controversias_publicas
    if (persona.sin_controversias_publicas === true && Array.isArray(controversias) && controversias.length > 0) {
      return res.status(400).json({
        error: 'No puede haber controversias si se marca "Sin controversias públicas"'
      });
    }

    // Validación tema central (mismo criterio que create)
    if (persona.id_tema_interes_central) {
      const { rows: temaRows } = await client.query(
        "SELECT requiere_otro_texto FROM catalogo_temas_interes WHERE id_tema = $1",
        [persona.id_tema_interes_central]
      );

      if (!temaRows[0]) return res.status(400).json({ error: "Tema de interés inválido" });

      if (temaRows[0].requiere_otro_texto && !persona.tema_interes_otro_texto) {
        return res.status(400).json({ error: 'Para el tema "Otro" se requiere texto' });
      }
    }

    // Validación partido “Otro” (mismo criterio que create)
    if (persona.id_partido_actual) {
      const { rows: pr } = await client.query(
        "SELECT nombre, siglas FROM catalogo_partidos WHERE id_partido = $1",
        [persona.id_partido_actual]
      );
      if (!pr[0]) return res.status(400).json({ error: "Partido inválido" });

      const esOtro =
        (pr[0].nombre || "").toLowerCase() === "otro" ||
        (pr[0].siglas || "").toUpperCase() === "OTRO";

      if (esOtro && !persona.partido_otro_texto) {
        return res.status(400).json({ error: 'Si partido es "Otro", se requiere partido_otro_texto' });
      }
      if (!esOtro && persona.partido_otro_texto) {
        persona.partido_otro_texto = null;
      }
    }
    //validacion nivel de confiabilidad
    const nc = (persona.nivel_confiabilidad || "").toString().trim().toLowerCase() || null;

    if (nc && !["alto","medio","bajo"].includes(nc)) {
      return res.status(400).json({ error: "nivel_confiabilidad inválido" });
    }

    // Validación no contradicción cargos elección popular
    if (persona.sin_cargos_eleccion_popular === true && Array.isArray(cargos_eleccion_popular) && cargos_eleccion_popular.length > 0) {
      return res.status(400).json({
        error: 'No puede haber cargos de elección popular si se marca "No ha ocupado cargos de elección popular"'
      });
    }
    
    //validaciones
    // ===== Validación RESIDENCIAS FUERA EDOMEX =====
    const legalFuera = persona.res_legal_fuera_edomex === true;
    const realFuera  = persona.res_real_fuera_edomex === true;
    const hasText = (x) => !!(x || "").toString().trim();

    if (legalFuera) {
      if (persona.municipio_residencia_legal != null) {
        return res.status(400).json({ error: "Residencia legal: si es fuera EdoMéx, municipio_residencia_legal debe ser null." });
      }
      if (!hasText(persona.res_legal_estado_texto) || !hasText(persona.res_legal_municipio_texto)) {
        return res.status(400).json({ error: "Residencia legal: captura Estado y Municipio/Alcaldía (texto)." });
      }
    } else {
      // si NO es fuera, no permitas textos
      persona.res_legal_estado_texto = null;
      persona.res_legal_municipio_texto = null;
    }

    if (realFuera) {
      if (persona.municipio_residencia_real != null) {
        return res.status(400).json({ error: "Residencia actual: si es fuera EdoMéx, municipio_residencia_real debe ser null." });
      }
      if (!hasText(persona.res_real_estado_texto) || !hasText(persona.res_real_municipio_texto)) {
        return res.status(400).json({ error: "Residencia actual: captura Estado y Municipio/Alcaldía (texto)." });
      }
    } else {
      persona.res_real_estado_texto = null;
      persona.res_real_municipio_texto = null;
    }
    await client.query("BEGIN");
        // 🔒 Validar existencia + permisos de edición
    const { rows: ownerRows } = await client.query(
      `
      SELECT id_persona, id_oficina, creado_por
      FROM personas
      WHERE id_persona = $1
      FOR UPDATE
      `,
      [id_persona]
    );

    if (!ownerRows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Persona no encontrada" });
    }

    const owner = ownerRows[0];

    // Superadmin: si no manda id_oficina, conserva la oficina original del registro
    oficinaFinal = isSuperadmin
      ? (Number(persona.id_oficina) || Number(owner.id_oficina) || null)
      : req.user.id_oficina;

    // reglas por rol
    const isAnalista = roles.includes("analista");
    const isCapturista = roles.includes("capturista");
    const isCapturistaPuro = isCapturista && !isAnalista;

    if (!isSuperadmin) {
      // capturista solo puede editar lo suyo, aunque el registro no tenga oficina asignada
      if (isCapturistaPuro && owner.creado_por !== req.user.id_usuario) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Solo puedes editar tus propios registros" });
      }

      // analista / no capturista: misma oficina
      if (!isCapturistaPuro && owner.id_oficina !== req.user.id_oficina) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "No puedes editar registros de otra oficina" });
      }
    }

    // 1) UPDATE PERSONA (mismas columnas que insert)
    await client.query(
      `
      UPDATE personas SET
        nombre = $2,
        apellido_paterno = $3,
        apellido_materno = $4,
        curp = $5,
        rfc = $6,
        clave_elector = $7,
        estado_civil = $8,
        escala_influencia = $9,
        sin_servicio_publico = $10,
        ha_contendido_eleccion = $11,

        municipio_residencia_legal = $12,
        municipio_residencia_real = $13,
        municipio_trabajo_politico = $14,

        -- 🔥 NUEVO: residencias fuera EdoMéx
        res_legal_fuera_edomex = $15,
        res_legal_estado_texto = $16,
        res_legal_municipio_texto = $17,
        res_real_fuera_edomex = $18,
        res_real_estado_texto = $19,
        res_real_municipio_texto = $20,

        sin_controversias_publicas = $21,
        id_partido_actual = $22,
        partido_otro_texto = $23,
        id_grupo_postulacion = $24,
        id_ideologia_politica = $25,
        sin_cargos_eleccion_popular = $26,
        foto_url = $27,
        id_oficina = $28,
        modificado_por = $29,
        nivel_confiabilidad = $30,
        edad = $31
      WHERE id_persona = $1
      `,
      [
        id_persona,

        persona.nombre,
        persona.apellido_paterno ?? null,
        persona.apellido_materno ?? null,
        persona.curp ?? null,
        persona.rfc ?? null,
        persona.clave_elector ?? null,
        persona.estado_civil ?? null,
        persona.escala_influencia ?? null,
        persona.sin_servicio_publico ?? false,
        persona.ha_contendido_eleccion ?? null,

        persona.municipio_residencia_legal ?? null,
        persona.municipio_residencia_real ?? null,
        persona.municipio_trabajo_politico ?? null,

        // 🔥 residencias fuera EdoMéx
        persona.res_legal_fuera_edomex ?? false,
        persona.res_legal_estado_texto ?? null,
        persona.res_legal_municipio_texto ?? null,
        persona.res_real_fuera_edomex ?? false,
        persona.res_real_estado_texto ?? null,
        persona.res_real_municipio_texto ?? null,

        persona.sin_controversias_publicas ?? null,
        persona.id_partido_actual ?? null,
        persona.partido_otro_texto ?? null,
        persona.id_grupo_postulacion ?? null,
        persona.id_ideologia_politica ?? null,
        persona.sin_cargos_eleccion_popular ?? null,
        persona.foto_url ?? null,

        oficinaFinal,               // OJO: ver nota abajo
        req.user.id_usuario,        // modificado_por
        nc,
        persona.edad || null                          // ✅ nivel_confiabilidad (NO asignar dentro)
      ]
    );

    // 1 grupos de postulacion
    await client.query(
      `DELETE FROM personas_grupos_postulacion WHERE id_persona = $1`,
      [id_persona]
    );

    const gruposFinales = gruposPostulacion.length
      ? gruposPostulacion
      : (persona.id_grupo_postulacion ? [Number(persona.id_grupo_postulacion)] : []);

    for (const idGrupo of gruposFinales) {
      await client.query(
        `
        INSERT INTO personas_grupos_postulacion (id_persona, id_grupo)
        VALUES ($1, $2)
        ON CONFLICT (id_persona, id_grupo) DO NOTHING
        `,
        [id_persona, idGrupo]
      );
    }

    // Helper: borra por persona
    async function del(table) {
      await client.query(`DELETE FROM ${table} WHERE id_persona = $1`, [id_persona]);
    }
    // 2) Temas interés (1:N) con validación "Otro"
    await del("personas_temas_interes");
    for (const t of temas_interes) {
      if (!t?.id_tema) continue;

      const { rows } = await client.query(
        "SELECT requiere_otro_texto FROM catalogo_temas_interes WHERE id_tema = $1",
        [t.id_tema]
      );
      if (!rows[0]) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Tema de interés inválido" });
      }
      if (rows[0].requiere_otro_texto && !t.otro_texto) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: 'Para el tema "Otro" se requiere texto' });
      }

      await client.query(
        `INSERT INTO personas_temas_interes (id_persona, id_tema, otro_texto)
         VALUES ($1,$2,$3)`,
        [id_persona, t.id_tema, t.otro_texto || null]
      );
    }

    // 3) Formacion academica
    await del("formacion_academica");
    for (const fa of formacion_academica) {
      const tieneAlgo =
        fa?.nivel || fa?.grado || fa?.grado_obtenido || fa?.institucion || fa?.anio_inicio || fa?.titulado || fa?.anio_fin;
      if (!tieneAlgo) continue;

      if (!fa.nivel) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "formacion_academica.nivel es obligatorio" });
      }

      const requiereDetalle = ["Educación Superior", "Posgrado"].includes(fa.nivel);
      if (requiereDetalle && (!fa.grado_obtenido || !fa.institucion)) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "Para Educación Superior o Posgrado se requiere grado_obtenido e institucion"
        });
      }

      if (["Educación Superior", "Posgrado"].includes(fa.nivel)) {
        if (fa.titulado === null || fa.titulado === undefined) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Debes indicar si está titulado" });
        }
      }

      const ced = (fa.cedula_profesional || "").toString().trim() || null;

      // regla: si NO está titulado, forzamos null
      const cedFinal = (fa.titulado === true) ? ced : null;

      // si titulado=true, exigir cédula (para sup/posgrado o para cualquier nivel, tú decides)
      if (fa.titulado === true && !cedFinal) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Si está titulado, captura la cédula profesional' });
      }

      await client.query(
        `
        INSERT INTO formacion_academica
          (id_persona, nivel, grado_obtenido, institucion, anio_inicio, anio_fin, grado, titulado, cedula_profesional)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `,
        [
          id_persona,
          fa.nivel,
          requiereDetalle ? (fa.grado_obtenido || null) : null,
          requiereDetalle ? (fa.institucion || null) : null,
          fa.anio_inicio || null,
          fa.anio_fin || null,
          fa.grado || null,
          fa.titulado ?? null,
          cedFinal
        ]
      );
    }

    // 4) Datos INE (1:1) -> delete + insert si trae algo, si no, elimina
    await client.query(`DELETE FROM datos_ine WHERE id_persona = $1`, [id_persona]);
    if (datos_ine && (datos_ine.seccion_electoral || datos_ine.distrito_federal || datos_ine.distrito_local)) {
      await client.query(
        `INSERT INTO datos_ine (id_persona, seccion_electoral, distrito_federal, distrito_local)
         VALUES ($1,$2,$3,$4)`,
        [
          id_persona,
          datos_ine.seccion_electoral || null,
          datos_ine.distrito_federal || null,
          datos_ine.distrito_local || null,
        ]
      );
    }

    // 5) Telefonos
    await del("telefonos");
    for (const t of telefonos) {
      if (!t?.telefono) continue;
      await client.query(
        `INSERT INTO telefonos (id_persona, telefono, tipo, principal)
         VALUES ($1,$2,$3,$4)`,
        [id_persona, t.telefono, t.tipo || null, t.principal ?? false]
      );
    }

    // 6) Parejas + Hijos (reconstrucción completa)
    // Primero hijos y parejas (por FK), luego insertas parejas y guardas mapa
    await del("hijos");
    await del("parejas");

    const parejaMap = new Map(); // temp_id -> id_pareja
    for (const p of parejas) {
      const periodo = normalizePeriodo(p?.periodo);
      const tieneAlgo = p?.nombre_pareja || p?.tipo_relacion || periodo;
      if (!tieneAlgo) continue;

      if (periodo && !isPeriodoValido(periodo)) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "Formato de periodo inválido en parejas. Usa AAAA o AAAA-AAAA",
          detail: { temp_id: p?.temp_id || null, periodo }
        });
      }

      const idRelSent = p?.id_relacion_sentimental ? Number(p.id_relacion_sentimental) : null;

      const { rows } = await client.query(
        `INSERT INTO parejas (id_persona, nombre_pareja, tipo_relacion, periodo, id_relacion_sentimental)
        VALUES ($1,$2,$3,$4,$5)
        RETURNING id_pareja`,
        [
          id_persona,
          p.nombre_pareja || null,
          p.tipo_relacion || null,
          periodo || null,
          Number.isFinite(idRelSent) ? idRelSent : null
        ]
      );

      if (p.temp_id != null) parejaMap.set(String(p.temp_id).trim(), rows[0].id_pareja);
    }

    for (const h of (hijos || [])) {
      // En UPDATE reconstrucción completa:
      // NO confíes en h.id_pareja (era de una pareja que ya borraste).
      const tempKey = (h?.pareja_temp_id ?? "").toString().trim();

      // si no seleccionaron pareja, será null (permitido)
      let id_pareja_final = null;

      if (tempKey) {
        const mapped = parejaMap.get(tempKey);

        // si el hijo trae pareja_temp_id pero no existe en el mapa => payload inconsistente
        if (!Number.isFinite(mapped)) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "Hijo referencia una pareja inválida (pareja_temp_id no existe en parejas enviadas).",
            detail: { pareja_temp_id: tempKey }
          });
        }

        id_pareja_final = mapped;
      }

      const nombre_completo = (h?.nombre_completo || "").toString().trim() || null;

      const aniosNum =
        (h?.anios === "" || h?.anios === null || h?.anios === undefined)
          ? null
          : Number(h.anios);

      const anios = Number.isFinite(aniosNum) ? aniosNum : null;

      await client.query(
        `
        INSERT INTO hijos (id_persona, id_pareja, nombre_completo, anios, sexo)
        VALUES ($1,$2,$3,$4,$5)
        `,
        [
          id_persona,
          id_pareja_final,
          nombre_completo,
          anios,
          (h?.sexo || null)
        ]
      );
    }

    // 7) Redes
    await del("redes_sociales_persona");
    for (const r of redes) {
      if (!r?.id_red) continue;
      await client.query(
        `INSERT INTO redes_sociales_persona (id_persona, id_red, url)
         VALUES ($1,$2,$3)`,
        [id_persona, r.id_red, r.url || null]
      );
    }

    // 8) Servicio publico
    await del("servicio_publico");
    for (const s of servicio_publico) {
      const tieneAlgo = s?.periodo || s?.cargo || s?.dependencia;
      if (!tieneAlgo) continue;
      await client.query(
        `INSERT INTO servicio_publico (id_persona, periodo, cargo, dependencia)
         VALUES ($1,$2,$3,$4)`,
        [id_persona, s.periodo || null, s.cargo || null, s.dependencia || null]
      );
    }

    // 9) Elecciones
    await del("elecciones_contendidas");
    for (const e of elecciones) {
      const tieneAlgo =
        e?.anio_eleccion || e?.candidatura || e?.partido_postulacion || e?.resultado ||
        e?.diferencia_votos || e?.diferencia_porcentaje;
      if (!tieneAlgo) continue;

      await client.query(
        `INSERT INTO elecciones_contendidas
          (id_persona, anio_eleccion, candidatura, partido_postulacion, resultado, diferencia_votos, diferencia_porcentaje)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          id_persona,
          e.anio_eleccion || null,
          e.candidatura || null,
          e.partido_postulacion || null,
          e.resultado || null,
          e.diferencia_votos || null,
          e.diferencia_porcentaje || null,
        ]
      );
    }

    // 10) Eventos movilización
      function normalizeUrl(u) {
        const s = (u || "").toString().trim();
        return s || null;
      }

      function normalizeFotos(arr, max = 10) {
        const list = Array.isArray(arr) ? arr : [];
        // dedupe por url
        const seen = new Set();
        const out = [];
        for (const x of list) {
          const url = normalizeUrl(x);
          if (!url) continue;
          if (seen.has(url)) continue;
          seen.add(url);
          out.push(url);
          if (out.length >= max) break;
        }
        return out;
      }

      // 10) Eventos movilización (con 1:N fotos)
      await del("capacidad_movilizacion_eventos");

      for (const ev of capacidad_movilizacion_eventos) {
        const nombre = (ev?.nombre_evento || "").toString().trim();
        const fecha = ev?.fecha_evento || null;
        const asistencia =
          ev?.asistencia === "" || ev?.asistencia == null ? null : Number(ev.asistencia);

        const lugar = (ev?.lugar_evento || "").toString().trim() || null;

        // fotos opcionales: array de urls (0..10)
        const fotos = normalizeFotos(ev?.fotos, 10);

        // si no hay nada, saltar
        if (!nombre && !fecha && asistencia == null && !lugar && fotos.length === 0) continue;

        // reglas mínimas del evento (igual que ya tenías)
        if (!nombre || !fecha || asistencia == null || Number.isNaN(asistencia)) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "Cada evento requiere nombre_evento, fecha_evento y asistencia"
          });
        }
        if (asistencia < 0) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "La asistencia no puede ser negativa" });
        }

        // ✅ límite fotos
        if (Array.isArray(ev?.fotos) && normalizeFotos(ev.fotos, 999).length > 10) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Máximo 10 fotos por evento" });
        }

        // insert evento y obtener id_evento
        const { rows } = await client.query(
          `
          INSERT INTO capacidad_movilizacion_eventos
            (id_persona, nombre_evento, fecha_evento, asistencia, lugar_evento)
          VALUES ($1,$2,$3,$4,$5)
          RETURNING id_evento
          `,
          [id_persona, nombre, fecha, asistencia, lugar]
        );

        const id_evento = rows[0].id_evento;

        // insert fotos
        for (const url of fotos) {
          await client.query(
            `INSERT INTO capacidad_movilizacion_eventos_fotos (id_evento, foto_url)
            VALUES ($1,$2)`,
            [id_evento, url]
          );
        }
      }

    // empresas_persona:
    await del("empresas_persona");

    for (const em of empresas_persona) {
      const nombre = (em?.nombre_empresa || "").toString().trim();
      const rol = (em?.rol || "").toString().trim();
      const rol_otro = (em?.rol_otro || "").toString().trim();
      const nombre_relacionado = (em?.nombre_relacionado || "").toString().trim();
      const relacion = (em?.relacion || "").toString().trim();

      const notas = (em?.notas || "").toString().trim() || null;
      const periodo = normalizePeriodo(em?.periodo);

      const tieneAlgo =
        nombre || rol || rol_otro || nombre_relacionado || relacion || periodo || notas;
      if (!tieneAlgo) continue;

      if (!nombre) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Cada empresa requiere nombre_empresa" });
      }

      if (rol.toLowerCase() === "otro" && !rol_otro) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: 'Si el rol es "Otro", captura el rol (rol_otro).' });
      }

      if (periodo && !isPeriodoValido(periodo)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Periodo inválido en empresa. Usa AAAA o AAAA-AAAA" });
      }

      await client.query(
        `INSERT INTO empresas_persona
          (id_persona, nombre_empresa, rol, rol_otro, nombre_relacionado, relacion, periodo, notas)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id_persona,
          nombre,
          rol || null,
          rol_otro || null,
          nombre_relacionado || null,
          relacion || null,
          periodo || null,
          notas
        ]
      );
    }
    // 11) Equipos
    await del("equipos_politicos");
    for (const eq of equipos) {
      const tieneAlgo = eq?.nombre_equipo || eq?.activo !== undefined;
      if (!tieneAlgo) continue;

      await client.query(
        `INSERT INTO equipos_politicos (id_persona, nombre_equipo, activo)
         VALUES ($1,$2,$3)`,
        [id_persona, eq.nombre_equipo || null, eq.activo ?? true]
      );
    }

    // 12) Referentes
    await del("referentes_politicos");
    for (const ref of referentes) {
      const tieneAlgo = ref?.nivel || ref?.nombres || ref?.apellido_paterno || ref?.apellido_materno;
      if (!tieneAlgo) continue;

      await client.query(
        `INSERT INTO referentes_politicos (id_persona, nivel, nombres, apellido_paterno, apellido_materno, cargo)
          VALUES ($1,$2,$3,$4,$5,$6)`,
        [id_persona, ref.nivel || null, 
          ref.nombres || null, 
          ref.apellido_paterno || null, 
          ref.apellido_materno || null,
          ref.cargo || null
        ]
      );
    }

    // 13) Controversias (solo si NO sinControversias)
    await del("controversias_persona");
    const sinControversias = persona.sin_controversias_publicas === true;
    if (!sinControversias) {
      for (const c of controversias) {
        const tieneAlgo = c?.id_tipo || c?.descripcion || c?.fuente || c?.fecha_registro || c?.estatus;
        if (!tieneAlgo) continue;

        await client.query(
          `INSERT INTO controversias_persona
            (id_persona, id_tipo, descripcion, fuente, fecha_registro, estatus)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            id_persona,
            c.id_tipo,
            c.descripcion || null,
            c.fuente || null,
            c.fecha_registro || null,
            c.estatus || null,
          ]
        );
      }
    }

    // 14) Familiares
    await del("familiares_politica");

    for (const f of familiares) {
      const idPartido = Number(f?.id_partido_politico || 0) || null;
      const otroPartido = String(f?.otro_partido_texto || "").trim() || null;

      const tieneAlgo =
        f?.nombre ||
        f?.parentesco ||
        f?.cargo ||
        f?.institucion ||
        idPartido ||
        otroPartido;

      if (!tieneAlgo) continue;

      await client.query(
        `
        INSERT INTO familiares_politica (
          id_persona,
          nombre,
          parentesco,
          cargo,
          institucion,
          id_partido_politico,
          otro_partido_texto
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        `,
        [
          id_persona,
          f.nombre || null,
          f.parentesco || null,
          f.cargo || null,
          f.institucion || null,
          idPartido,
          otroPartido
        ]
      );
    }

    // 15) Participación organizaciones
    await del("participacion_organizaciones");
    for (const po of participacion_organizaciones) {
      const tieneAlgo = po?.tipo || po?.nombre || po?.rol || po?.periodo || po?.notas;
      if (!tieneAlgo) continue;

      if (!po.nombre) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "participacion_organizaciones.nombre es obligatorio" });
      }

      await client.query(
        `INSERT INTO participacion_organizaciones (id_persona, tipo, nombre, rol, periodo, notas)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id_persona, po.tipo || "otro", po.nombre, po.rol || null, po.periodo || null, po.notas || null]
      );
    }

    // 16) Cargos elección popular
    await del("cargos_eleccion_popular");

    for (const c of (cargos_eleccion_popular || [])) {
      const idOrden = c?.id_orden_gobierno ? Number(c.id_orden_gobierno) : null;
      const idCargo = c?.id_cargo_catalogo ? Number(c.id_cargo_catalogo) : null;
      const idPart  = c?.id_partido_postulante ? Number(c.id_partido_postulante) : null;

      const periodo = (c?.periodo || "").toString().trim() || null;
      const modalidad = (c?.modalidad || "").toString().trim().toLowerCase() || null;

      // ✅ NUEVO: suplente + titular (tomados DESDE c)
      const es_suplente = c?.es_suplente === true;
      const titular = (c?.titular_candidatura || "").toString().trim(); // string (puede quedar "")

      // legacy opcional
      const cargoLegacy = (c?.cargo || "").toString().trim() || null;
      const partidoLegacy = (c?.partido_postulante || "").toString().trim() || null;

      const tieneAlgo =
        !!periodo ||
        !!modalidad ||
        Number.isFinite(idOrden) ||
        Number.isFinite(idCargo) ||
        Number.isFinite(idPart) ||
        !!cargoLegacy ||
        !!partidoLegacy ||
        es_suplente ||
        !!titular;

      if (!tieneAlgo) continue;

      // ✅ Requeridos base
      if (!periodo || !Number.isFinite(idOrden) || !Number.isFinite(idCargo)) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "Cada cargo de elección popular requiere periodo, orden de gobierno y cargo"
        });
      }

      // ✅ modalidad (tu CHECK en BD solo permite mr/rp o null)
      if (modalidad && !["mr", "rp"].includes(modalidad)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "modalidad inválida (mr|rp)" });
      }

      // ✅ Blindaje suplente (además del CHECK en BD)
      if (es_suplente && !titular) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: 'Si "Fue suplente" está activado, "Titular de la candidatura" es obligatorio.'
        });
      }

      await client.query(
        `INSERT INTO cargos_eleccion_popular
          (id_persona, periodo, modalidad,
          id_orden_gobierno, id_cargo_catalogo, id_partido_postulante,
          cargo, partido_postulante,
          es_suplente, titular_candidatura)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id_persona,
          periodo,
          modalidad || null,
          idOrden,
          idCargo,
          Number.isFinite(idPart) ? idPart : null,
          cargoLegacy,
          partidoLegacy,
          es_suplente,
          es_suplente ? (titular || null) : null // ✅ si NO es suplente => NULL (para pasar CHECK)
        ]
      );
    }

    // 17) Experiencia laboral
    await del("experiencia_laboral");
    for (const ex of experiencia_laboral) {
      const tieneAlgo = ex?.periodo || ex?.cargo || ex?.organizacion;
      if (!tieneAlgo) continue;

      await client.query(
        `INSERT INTO experiencia_laboral (id_persona, periodo, cargo, organizacion)
         VALUES ($1,$2,$3,$4)`,
        [id_persona, ex.periodo || null, ex.cargo || null, ex.organizacion || null]
      );
    }

    // 18) Fuentes consulta
    await client.query(`DELETE FROM fuentes_persona WHERE id_persona = $1`, [id_persona]);

    for (const f of (fuentes_consulta || [])) {
      const id_fuente = Number(f?.id_fuente);
      const detalle = (f?.detalle || '').toString().trim() || null;
      const fecha_consulta = (f?.fecha_consulta || '').toString().trim() || null; // 'YYYY-MM-DD'

      if (!Number.isFinite(id_fuente) || id_fuente <= 0) continue;

      // 🔒 validar que exista y esté activa
      const { rows: fr } = await client.query(
        `SELECT 1 FROM catalogo_fuentes_consulta WHERE id_fuente = $1 AND activo = true`,
        [id_fuente]
      );
      if (!fr[0]) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Fuente de consulta inválida" });
      }

      await client.query(
        `INSERT INTO fuentes_persona (id_persona, id_fuente, detalle, fecha_consulta)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (id_persona, id_fuente)
        DO UPDATE SET detalle = EXCLUDED.detalle, fecha_consulta = EXCLUDED.fecha_consulta`,
        [id_persona, id_fuente, detalle, fecha_consulta]
      );
    }

        //trabajo politico en varios municipios
    const municipios_trabajo = Array.isArray(req.body.municipios_trabajo) ? req.body.municipios_trabajo : [];

    await client.query(`DELETE FROM personas_municipios_trabajo WHERE id_persona=$1`, [id_persona]);

    const principal = persona.municipio_trabajo_politico ? Number(persona.municipio_trabajo_politico) : null;
    const ids = new Set();

    for (const it of municipios_trabajo) {
      const id_municipio = Number(it?.id_municipio);
      if (!Number.isFinite(id_municipio) || id_municipio <= 0) continue;
      if (ids.has(id_municipio)) continue;
      ids.add(id_municipio);

      await client.query(
        `INSERT INTO personas_municipios_trabajo (id_persona, id_municipio, es_principal, notas)
        VALUES ($1,$2,$3,$4)`,
        [id_persona, id_municipio, principal === id_municipio, (it?.notas || '').toString().trim() || null]
      );
    }

    // Forzar que el principal esté en la cobertura si existe
    if (principal && !ids.has(principal)) {
      await client.query(
        `INSERT INTO personas_municipios_trabajo (id_persona, id_municipio, es_principal)
        VALUES ($1,$2,true)
        ON CONFLICT (id_persona, id_municipio) DO UPDATE SET es_principal=true`,
        [id_persona, principal]
      );
    }

    // X) Liderazgo e influencia (1:1)
    const vLid = validateLiderazgo(liderazgo_influencia);
    if (!vLid.ok) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: vLid.error });
    }

    // ✅ enfoque actual: si no hay data => borrar
    if (!vLid.data) {
      await client.query(`DELETE FROM liderazgo_influencia WHERE id_persona = $1`, [id_persona]);
    } else {
      const d = vLid.data;

      // ✅ upsert (no necesitas borrar antes)
      await client.query(
        `INSERT INTO liderazgo_influencia
          (id_persona, nivel, tipos, tipo_otro_texto, cuenta_con_estructura, presencia_territorial, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6, now())
        ON CONFLICT (id_persona) DO UPDATE SET
          nivel = EXCLUDED.nivel,
          tipos = EXCLUDED.tipos,
          tipo_otro_texto = EXCLUDED.tipo_otro_texto,
          cuenta_con_estructura = EXCLUDED.cuenta_con_estructura,
          presencia_territorial = EXCLUDED.presencia_territorial,
          updated_at = now()`,
        [id_persona, d.nivel, d.tipos, d.tipo_otro_texto, d.cuenta_con_estructura, d.presencia_territorial]
      );
    }

    await client.query("COMMIT");
    return res.json({ ok: true, id_persona });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);

    if (String(e.message).includes("datos_ine_id_persona_key")) {
      return res.status(409).json({ error: "Esta persona ya tiene datos INE" });
    }
    if (String(e.message).includes("personas_curp_key")) return res.status(409).json({ error: "CURP ya existe" });
    if (String(e.message).includes("personas_rfc_key")) return res.status(409).json({ error: "RFC ya existe" });

    return res.status(500).json({ error: "Error al actualizar persona", detail: e.message });
  } finally {
    client.release();
  }
};

//eliminar
// controllers/personasController.js
exports.deletePersona = async (req, res) => {
  const client = await pool.connect();
  try {
    const id_persona = Number(req.params.id);
    await assertCanMutatePersona(client, req, id_persona);
    if (!Number.isFinite(id_persona)) {
      return res.status(400).json({ error: "id_persona inválido" });
    }

    const roles = req.user.roles || [];
    const isSuperadmin = roles.includes("superadmin");
    const isAnalista = roles.includes("analista");
    const isCapturista = roles.includes("capturista");

    if (!isSuperadmin && !isAnalista && !isCapturista) {
      return res.status(403).json({ error: "Sin permisos" });
    }

    if (!isSuperadmin && !req.user.id_oficina) {
      return res.status(403).json({ error: "Usuario sin oficina asignada" });
    }

    await client.query("BEGIN");

    // 1) Traer el registro con dueño/oficina
    const { rows } = await client.query(
      `
      SELECT id_persona, id_oficina, creado_por
      FROM personas
      WHERE id_persona = $1
      `,
      [id_persona]
    );

    if (!rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Persona no encontrada" });
    }

    const persona = rows[0];

    // 2) Reglas por rol
    if (!isSuperadmin) {
      // oficina obligatoria para analista/capturista
      if (persona.id_oficina !== req.user.id_oficina) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "No puedes eliminar registros de otra oficina" });
      }

      // capturista: solo lo suyo
      if (isCapturista && persona.creado_por !== req.user.id_usuario) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Solo puedes eliminar tus propios registros" });
      }
    }

    // 3) Borrar
    // (Idealmente tus FKs tienen ON DELETE CASCADE. Si alguna tabla no lo tiene,
    // aquí reventaría con error de FK y te avisará cuál falta.)
    const del = await client.query(
      `DELETE FROM personas WHERE id_persona = $1 RETURNING id_persona`,
      [id_persona]
    );

    await client.query("COMMIT");
    return res.json({ ok: true, id_persona: del.rows[0].id_persona });

  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    return res.status(500).json({ error: "Error al eliminar persona", detail: e.message });
  } finally {
    client.release();
  }
};


exports.getPayloadEdicion = async (req, res) => {
  const id_persona = Number(req.params.id);
  if (!Number.isFinite(id_persona) || id_persona <= 0) {
    return res.status(400).json({ error: "id inválido" });
  }

  const client = await pool.connect();
  try {

    await assertCanMutatePersona(client, req, id_persona);
    const { rows: pRows } = await client.query(
      `SELECT
        id_persona,
        nombre, apellido_paterno, apellido_materno, curp, rfc, clave_elector,
        estado_civil, escala_influencia, sin_servicio_publico, ha_contendido_eleccion,
        municipio_residencia_legal, municipio_residencia_real, municipio_trabajo_politico,

        -- 🔥 RESIDENCIAS FUERA EDOMEX
        res_legal_fuera_edomex,
        res_legal_estado_texto,
        res_legal_municipio_texto,
        res_real_fuera_edomex,
        res_real_estado_texto,
        res_real_municipio_texto,

        sin_controversias_publicas,
        id_partido_actual, partido_otro_texto,
        id_grupo_postulacion,
        id_ideologia_politica,
        sin_cargos_eleccion_popular,
        foto_url,
        id_oficina,
        creado_por,
        created_at,
        modificado_por,
        updated_at,
        nivel_confiabilidad,
        edad
      FROM personas
      WHERE id_persona = $1`,
      [id_persona]
    );

    if (!pRows.length) {
      return res.status(404).json({ error: "Persona no encontrada" });
    }

    const persona = pRows[0];
    if (!persona.res_legal_fuera_edomex) {
      persona.res_legal_estado_texto = null;
      persona.res_legal_municipio_texto = null;
    }
    if (!persona.res_real_fuera_edomex) {
      persona.res_real_estado_texto = null;
      persona.res_real_municipio_texto = null;
    }

    // 2️⃣ Auditoría (DESPUÉS de tener persona)
    const roles = req.user?.roles || [];
    const canSeeAudit = roles.includes("analista") || roles.includes("superadmin");

    if (canSeeAudit) {
      const { rows: aRows } = await client.query(
        `
        SELECT
          COALESCE(p.updated_at, p.created_at) AS fecha,
          CASE
            WHEN p.modificado_por IS NULL THEN 'Creación'
            ELSE 'Última modificación'
          END AS tipo,
          COALESCE(u_mod.id_usuario, u_crea.id_usuario) AS id_usuario,
          COALESCE(u_mod.nombre, u_crea.nombre) AS nombre,
          COALESCE(u_mod.email,  u_crea.email)  AS email,
          o.nombre AS oficina
        FROM personas p
        LEFT JOIN usuarios u_mod ON u_mod.id_usuario = p.modificado_por
        LEFT JOIN usuarios u_crea ON u_crea.id_usuario = p.creado_por
        LEFT JOIN oficinas o ON o.id_oficina = p.id_oficina
        WHERE p.id_persona = $1
        `,
        [id_persona]
      );

      persona.auditoria = aRows[0] || null;
    }

    // DATOS INE (tu PK es id_ine, pero aquí solo devolvemos campos del insert)
    const { rows: ineRows } = await client.query(
      `SELECT seccion_electoral, distrito_federal, distrito_local
       FROM datos_ine
       WHERE id_persona = $1
       ORDER BY id_ine DESC
       LIMIT 1`,
      [id_persona]
    );
    const datos_ine = ineRows[0] || null;

    const [
      telefonos,
      parejas,
      hijos,
      redes,
      empresas_persona,
      servicio_publico,
      elecciones,
      capacidad_movilizacion_eventos,
      equipos,
      referentes,
      controversias,
      formacion_academica,
      familiares,
      temas_interes,
      participacion_organizaciones,
      cargos_eleccion_popular,
      experiencia_laboral,
      fuentes_consulta,
      municipios_trabajo,
      liderazgoRow,
      grupos_postulacion,
    ] = await Promise.all([
      // telefonos (PK: id_telefono)
      client.query(
        `SELECT telefono, tipo, principal
         FROM telefonos
         WHERE id_persona = $1
         ORDER BY principal DESC, id_telefono ASC`,
        [id_persona]
      ).then(r => r.rows),

      // parejas (PK: id_pareja) + temp_id para compatibilidad front
      client.query(
        `SELECT
          id_pareja,
          id_pareja AS temp_id,
          nombre_pareja,
          tipo_relacion,
          periodo,
          id_relacion_sentimental
        FROM parejas
        WHERE id_persona = $1
        ORDER BY id_pareja ASC`,
        [id_persona]
      ).then(r => r.rows),

      // hijos (PK: id_hijo) + pareja_temp_id para compatibilidad front
      client.query(
        `SELECT
          id_hijo,
          id_pareja,
          id_pareja AS pareja_temp_id,
          nombre_completo,
          anios,
          sexo
        FROM hijos
        WHERE id_persona = $1
        ORDER BY id_hijo ASC`,
        [id_persona]
      ).then(r => r.rows),

      // redes_sociales_persona (PK: id_registro)
      client.query(
        `SELECT id_red, url
         FROM redes_sociales_persona
         WHERE id_persona = $1
         ORDER BY id_registro ASC`,
        [id_persona]
      ).then(r => r.rows),

      // empresas_persona (PK: id_empresa_persona)
      client.query(
        `SELECT
          id_empresa_persona,
          nombre_empresa,
          rol,
          rol_otro,
          nombre_relacionado,
          relacion,
          periodo,
          notas
        FROM empresas_persona
        WHERE id_persona = $1
        ORDER BY id_empresa_persona ASC`,
        [id_persona]
      ).then(r => r.rows),

      // servicio_publico (PK: id_servicio)
      client.query(
        `SELECT periodo, cargo, dependencia
         FROM servicio_publico
         WHERE id_persona = $1
         ORDER BY id_servicio ASC`,
        [id_persona]
      ).then(r => r.rows),

      // elecciones_contendidas (PK: id_eleccion)
      client.query(
        `SELECT anio_eleccion, candidatura, partido_postulacion, resultado, diferencia_votos, diferencia_porcentaje
         FROM elecciones_contendidas
         WHERE id_persona = $1
         ORDER BY id_eleccion ASC`,
        [id_persona]
      ).then(r => r.rows),


      // capacidad_movilizacion_eventos (PK: id_evento)  ✅ incluye id_evento
      client.query(
        `SELECT id_evento, nombre_evento, fecha_evento, asistencia, lugar_evento
        FROM capacidad_movilizacion_eventos
        WHERE id_persona = $1
        ORDER BY id_evento ASC`,
        [id_persona]
      ).then(r => r.rows),

      // equipos_politicos (PK: id_equipo)
      client.query(
        `SELECT nombre_equipo, activo
         FROM equipos_politicos
         WHERE id_persona = $1
         ORDER BY id_equipo ASC`,
        [id_persona]
      ).then(r => r.rows),

      // referentes_politicos (PK: id_referente)
      client.query(
        `SELECT nivel, nombres, apellido_paterno, apellido_materno, cargo
         FROM referentes_politicos
         WHERE id_persona = $1
         ORDER BY id_referente ASC`,
        [id_persona]
      ).then(r => r.rows),

      // controversias_persona (PK: id_controversia)
      client.query(
        `SELECT id_tipo, descripcion, fuente, fecha_registro, estatus
         FROM controversias_persona
         WHERE id_persona = $1
         ORDER BY id_controversia ASC`,
        [id_persona]
      ).then(r => r.rows),

      // formacion_academica (PK: id_formacion)
      client.query(
        `SELECT nivel, grado_obtenido, institucion, anio_inicio, anio_fin, grado, titulado, cedula_profesional
         FROM formacion_academica
         WHERE id_persona = $1
         ORDER BY id_formacion ASC`,
        [id_persona]
      ).then(r => r.rows),

      // familiares_politica (PK: id_familiar)
      client.query(
        `
        SELECT
          nombre,
          parentesco,
          cargo,
          institucion,
          id_partido_politico,
          otro_partido_texto
        FROM familiares_politica
        WHERE id_persona = $1
        ORDER BY id_familiar ASC
        `,
        [id_persona]
      ).then(r => r.rows),

      // personas_temas_interes (PK compuesta id_persona + id_tema)
      client.query(
        `SELECT id_tema, otro_texto
         FROM personas_temas_interes
         WHERE id_persona = $1
         ORDER BY id_tema ASC`,
        [id_persona]
      ).then(r => r.rows),

      // participacion_organizaciones (PK: id_participacion)
      client.query(
        `SELECT tipo, nombre, rol, periodo, notas
         FROM participacion_organizaciones
         WHERE id_persona = $1
         ORDER BY id_participacion ASC`,
        [id_persona]
      ).then(r => r.rows),

      // cargos_eleccion_popular (PK: id_cargo_eleccion)
      client.query(
        `SELECT
          periodo,
          modalidad,
          id_orden_gobierno,
          id_cargo_catalogo,
          id_partido_postulante,
          cargo,
          partido_postulante,
          es_suplente,
          titular_candidatura
        FROM cargos_eleccion_popular
        WHERE id_persona = $1
        ORDER BY id_cargo_eleccion ASC`,
        [id_persona]
      ).then(r => r.rows),

      // experiencia_laboral (PK: id_experiencia)
      client.query(
        `SELECT periodo, cargo, organizacion
         FROM experiencia_laboral
         WHERE id_persona = $1
         ORDER BY id_experiencia ASC`,
        [id_persona]
      ).then(r => r.rows),
      //consulta de fuentes
      client.query(
        `SELECT id_fuente, detalle, fecha_consulta
        FROM fuentes_persona
        WHERE id_persona = $1
        ORDER BY id_fuente_persona ASC`,
        [id_persona]
      ).then(r => r.rows),

      client.query(
      `SELECT id_municipio, es_principal, notas
      FROM personas_municipios_trabajo
      WHERE id_persona = $1
      ORDER BY es_principal DESC, id_municipio ASC`,
      [id_persona]
    ).then(r => r.rows),

    // liderazgo_influencia (1:1)
    client.query(
      `SELECT nivel, tipos, tipo_otro_texto, cuenta_con_estructura, presencia_territorial
      FROM liderazgo_influencia
      WHERE id_persona = $1`,
      [id_persona]
    ).then(r => r.rows[0] || null),

        // grupos de postulación (multi)
    client.query(
      `SELECT id_grupo
       FROM personas_grupos_postulacion
       WHERE id_persona = $1
       ORDER BY id_grupo ASC`,
      [id_persona]
    ).then(r => r.rows.map(x => Number(x.id_grupo))),

    ]);
//) Agrega fallback por compatibilidad.Como todavía conservas personas.id_grupo_postulacion, 
// conviene dejar fallback por si algún registro viejo no quedó en la tabla puente.
    const gruposPostulacionFinal =
    Array.isArray(grupos_postulacion) && grupos_postulacion.length
      ? grupos_postulacion
      : (persona.id_grupo_postulacion ? [Number(persona.id_grupo_postulacion)] : []);
    
        // ✅ cargar fotos de eventos
    const eventIds = (capacidad_movilizacion_eventos || []).map(e => e.id_evento).filter(Boolean);

    let fotosByEvento = new Map();
    if (eventIds.length) {
      const { rows: fRows } = await client.query(
        `SELECT id_evento, foto_url
        FROM capacidad_movilizacion_eventos_fotos
        WHERE id_evento = ANY($1::int[])
        ORDER BY id_foto ASC`,
        [eventIds]
      );

      for (const r of fRows) {
        if (!fotosByEvento.has(r.id_evento)) fotosByEvento.set(r.id_evento, []);
        fotosByEvento.get(r.id_evento).push(r.foto_url);
      }
    }

    // anexar fotos al arreglo de eventos
    for (const ev of capacidad_movilizacion_eventos) {
      ev.fotos = fotosByEvento.get(ev.id_evento) || [];
    }

    // ✅ AQUÍ: 3 LÍNEAS NUEVAS

  
    return res.json({
      persona,
      grupos_postulacion: gruposPostulacionFinal,
      datos_ine,
      telefonos,
      parejas,
      hijos,
      redes,
      servicio_publico,
      elecciones,
      capacidad_movilizacion_eventos,
      equipos,
      referentes,
      controversias,
      formacion_academica,
      familiares,
      temas_interes,
      participacion_organizaciones,
      cargos_eleccion_popular,
      experiencia_laboral,
      empresas_persona,
      fuentes_consulta,
      municipios_trabajo,
      liderazgo_influencia: liderazgoRow,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Error al obtener payload", detail: e.message });
  } finally {
    client.release();
  }
};


exports.getAdminCards = async (req, res) => {
  const client = await pool.connect();
  try {
    const roles = req.user?.roles || [];
    const isSuperadmin = roles.includes("superadmin");
    const isAnalista   = roles.includes("analista");
    const isCapturista = roles.includes("capturista");

    // paginación
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const size = Math.min(Math.max(parseInt(req.query.size || "24", 10), 1), 500);
    const offset = (page - 1) * size;

    // filtros
    let oficinaId = req.query.oficinaId ? Number(req.query.oficinaId) : null;
    const capturistaId = req.query.capturistaId ? Number(req.query.capturistaId) : null;
    const q = (req.query.q || "").trim();

    // ✅ filtro municipio por ID (como listPersonas)
    const idMun = Number(req.query.municipio_trabajo);
    const hasMun = Number.isFinite(idMun) && idMun > 0;

    // sort
    const sortFieldRaw = (req.query.sortField || "updated_at").trim();
    const sortDir = (req.query.sortDir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";

    const SORT_WHITELIST = new Set([
      "updated_at",
      "created_at",
      "id_persona",
      "nombre",
      "apellido_paterno",
      "apellido_materno",
      "municipio_trabajo_politico",
    ]);
    const sortField = SORT_WHITELIST.has(sortFieldRaw) ? sortFieldRaw : "updated_at";

    // reglas por rol
    if (isAnalista && !isSuperadmin) {
      oficinaId = Number(req.user.id_oficina || 0) || null; // usa tu campo real
    }
    const forceCreadoPor = (isCapturista && !isAnalista && !isSuperadmin)
      ? Number(req.user.id_usuario || 0) || null
      : null;

    const { addFullFilter } = req.smartFilters;
    // WHERE dinámico
    const where = [];
    const params = [];
    // 🎯 MÁGICO: Aplica filtros AUTOMÁTICOS por rol/cargo/area
    addFullFilter(params, where); 

    if (oficinaId) {
      params.push(oficinaId);
      where.push(`p.id_oficina = $${params.length}`);
    }

    if (capturistaId) {
      params.push(capturistaId);
      where.push(`p.creado_por = $${params.length}`);
    }

    if (forceCreadoPor) {
      params.push(forceCreadoPor);
      where.push(`p.creado_por = $${params.length}`);
    }

    if (hasMun) {
      params.push(idMun);
      where.push(`p.municipio_trabajo_politico = $${params.length}`);
    }

    if (q) {
      params.push(`%${q}%`);
      const i = params.length;
      where.push(`
        (
          COALESCE(p.nombre,'') ILIKE $${i}
          OR COALESCE(p.apellido_paterno,'') ILIKE $${i}
          OR COALESCE(p.apellido_materno,'') ILIKE $${i}
          OR COALESCE(p.curp,'') ILIKE $${i}
          OR COALESCE(p.rfc,'') ILIKE $${i}
          OR COALESCE(p.clave_elector,'') ILIKE $${i}
        )
      `);
    }

    const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // TOTAL
    const totalSql = `
      SELECT COUNT(*)::int AS total
      FROM personas p
      ${whereSQL}
    `;
    const { rows: totalRows } = await client.query(totalSql, params);
    const total = totalRows?.[0]?.total || 0;
    const last_page = Math.max(Math.ceil(total / size), 1);

    // DATA
    // ✅ Join a municipios para devolver nombre (y que tu card muestre bonito)
    const dataSql = `
      SELECT
        p.id_persona,
        p.nombre,
        p.apellido_paterno,
        p.apellido_materno,

        p.curp,
        p.rfc,
        p.clave_elector,

        mt.nombre AS municipio_trabajo_politico,

        p.foto_url,
        p.id_oficina,
        o.nombre AS oficina_nombre,

        p.creado_por,
        u_crea.nombre AS creado_por_nombre,
        u_crea.email  AS creado_por_email,

        p.modificado_por,
        u_mod.nombre AS modificado_por_nombre,
        u_mod.email  AS modificado_por_email,

        p.created_at,
        p.updated_at,

        t.telefono AS telefono_principal

      FROM personas p
      LEFT JOIN oficinas o ON o.id_oficina = p.id_oficina
      LEFT JOIN usuarios u_crea ON u_crea.id_usuario = p.creado_por
      LEFT JOIN usuarios u_mod  ON u_mod.id_usuario  = p.modificado_por
      LEFT JOIN municipios mt   ON mt.id_municipio   = p.municipio_trabajo_politico

      LEFT JOIN LATERAL (
        SELECT telefono
        FROM telefonos
        WHERE id_persona = p.id_persona
        ORDER BY principal DESC, id_telefono ASC
        LIMIT 1
      ) t ON true

      ${whereSQL}
      ORDER BY p.${sortField} ${sortDir}, p.id_persona DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;

    const dataParams = params.concat([size, offset]);
    const { rows } = await client.query(dataSql, dataParams);

    const data = rows.map(r => ({
      id_persona: r.id_persona,
      nombre_completo: [r.nombre, r.apellido_paterno, r.apellido_materno].filter(Boolean).join(" "),

      curp: r.curp,
      rfc: r.rfc,
      clave_elector: r.clave_elector,

      municipio_trabajo_politico: r.municipio_trabajo_politico || "—",

      foto_url: r.foto_url,
      telefono_principal: r.telefono_principal,

      id_oficina: r.id_oficina,
      oficina_nombre: r.oficina_nombre,

      creado_por: r.creado_por,
      creado_por_nombre: r.creado_por_nombre,
      creado_por_email: r.creado_por_email,

      modificado_por: r.modificado_por,
      modificado_por_nombre: r.modificado_por_nombre,
      modificado_por_email: r.modificado_por_email,

      created_at: r.created_at,
      updated_at: r.updated_at,
    }));

    return res.json({ data, total, page, size, last_page });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Error al obtener cards", detail: e.message });
  } finally {
    client.release();
  }
};

//listar oficinas
exports.listOficinas = async (req, res) => {
  try {
    const roles = req.user.roles || [];
    const isSuperadmin = roles.includes('superadmin');
    const isAnalista   = roles.includes('analista');

    let sql = `
      SELECT id_oficina, nombre
      FROM oficinas
    `;
    const params = [];

    if (!isSuperadmin) {
      // analista / capturista: solo su oficina
      if (!req.user.id_oficina) {
        return res.json([]);
      }
      sql += ` WHERE id_oficina = $1`;
      params.push(req.user.id_oficina);
    }

    sql += ` ORDER BY nombre`;

    const { rows } = await pool.query(sql, params);
    return res.json(rows);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Error al listar oficinas' });
  }
};

// ADMIN: listar capturistas por oficina (para filtros del grid)
exports.listCapturistasByOficina = async (req, res) => {
  try {
    const rolesUser = req.user?.roles || [];
    const isSuperadmin = rolesUser.includes("superadmin");
    
    // 🆕 FUNCIÓN para parsear cargos
    function getPermissionLevel(cargo) {
      const cargoClean = (cargo || '').toLowerCase().trim();
      
      // COORDINADOR: ve TODO (incluye variaciones)
      if (cargoClean.includes('coordinador') || 
          cargoClean.includes('coordinadora') ||
          cargoClean.includes('gerente') ||
          cargoClean.includes('supervisor')) {
        return 'coordinador'; // Ve TODOS capturistas de oficina
      }
      
      // DIRECTOR: ve SOLO su área (variaciones)
      if (cargoClean.includes('director') || 
          cargoClean.includes('directora') ||
          cargoClean.includes('jefe') ||
          cargoClean.includes('jefa')) {
        return 'director'; // Ve SOLO capturistas de SU área
      }
      
      return null; // Otros cargos bloqueados
    }

    let oficinaId = null;
    const permissionLevel = getPermissionLevel(req.user.cargo);

    // 🔒 Validar permisos
    if (!isSuperadmin && !permissionLevel) {
      return res.status(403).json({ error: "Cargo no autorizado para esta acción" });
    }

    // Determinar oficina
    if (!isSuperadmin) {
      oficinaId = Number(req.user.id_oficina || 0);
      if (!Number.isFinite(oficinaId) || oficinaId <= 0) {
        return res.status(403).json({ error: "Usuario sin oficina asignada" });
      }
    } else {
      oficinaId = req.query.oficinaId ? Number(req.query.oficinaId) : null;
    }

    const params = [];
    const where = [];

    // Filtro oficina (siempre)
    if (Number.isFinite(oficinaId) && oficinaId > 0) {
      params.push(oficinaId);
      where.push(`u.id_oficina = $${params.length}`);
    }

    // 🔑 LÓGICA por NIVEL DE PERMISO
    if (!isSuperadmin) {
      if (permissionLevel === 'coordinador') {
        // Coordinador: TODOS capturistas de oficina
        where.push(`r.nombre = 'capturista'`);
      } else if (permissionLevel === 'director') {
        // Director: SOLO capturistas de SU área
        if (!req.user.area) {
          return res.status(403).json({ error: "Director sin área asignada" });
        }
        params.push(req.user.area);
        where.push(`u.area = $${params.length}`);
        where.push(`r.nombre = 'capturista'`);
      }
    } else {
      // Superadmin: solo rol capturista
      where.push(`r.nombre = 'capturista'`);
    }

    const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const { rows } = await pool.query(
      `
      SELECT DISTINCT
        u.id_usuario,
        u.nombre,
        u.email,
        u.area,
        u.cargo,
        u.id_oficina
      FROM usuarios u
      JOIN usuarios_roles ur ON ur.id_usuario = u.id_usuario
      JOIN roles r ON r.id_rol = ur.id_rol
      ${whereSQL}
      ORDER BY u.nombre ASC
      `,
      params
    );

    return res.json(rows);

  } catch (e) {
    console.error(e);
    return res.status(500).json({
      error: "Error al listar capturistas",
      detail: e.message
    });
  }
};



exports.verificarPersona = async (req, res) => {
  const client = await pool.connect();
  try {
    
    const id_persona = Number(req.params.id);
    if (!Number.isFinite(id_persona) || id_persona <= 0) {
      return res.status(400).json({ error: "id inválido" });
    }

    const puedeVerificarFinal = req.user?.puede_verificar_final === true;
    const roles = req.user?.roles || [];
    const scope = req.user?.scope || null;
    const isSuperadmin = roles.includes("superadmin") || scope === "ALL";
    const isAnalista = roles.includes("analista");
    

    // Solo analista/superadmin, y scope permitido
    if (!isSuperadmin && !isAnalista) return res.status(403).json({ error: "Prohibido" });
    if (!["AREA", "OFFICE", "ALL"].includes(scope)) {
      return res.status(403).json({ error: "Sin permiso de verificación" });
    }

    await client.query("BEGIN");

    const { rows } = await client.query(
      `
      SELECT
        p.id_persona, p.id_oficina,
        p.verif_area_at, p.verif_office_at, p.verificado_at
      FROM personas p
      WHERE p.id_persona = $1
      FOR UPDATE
      `,
      [id_persona]
    );

    if (!rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Persona no encontrada" });
    }


    // Alcance: superadmin todo, AREA/OFFICE solo su oficina (igual que antes)
    if (!isSuperadmin) {
      const forced = Number(req.user.id_oficina || 0);
      if (!forced) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Usuario sin oficina asignada" });
      }
      if (Number(rows[0].id_oficina) !== forced) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "No autorizado" });
      }
    }
    //permisos para verificar
    if (scope === "ALL" && !puedeVerificarFinal) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Este usuario no tiene permiso para verificación FINAL." });
    }

    // Pipeline: OFFICE requiere AREA, ALL requiere OFFICE
    if (scope === "OFFICE" && !rows[0].verif_area_at) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Primero debe verificar el Director (AREA)." });
    }
    if (scope === "ALL" && !rows[0].verif_office_at) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Primero debe verificar el Coordinador (OFFICE)." });
    }

    let setSql = "";
    if (scope === "AREA") {
      setSql = `verif_area_por = $2, verif_area_at = now()`;
    } else if (scope === "OFFICE") {
      setSql = `verif_office_por = $2, verif_office_at = now()`;
    } else {
      // ALL (superadmin) -> reutiliza tus columnas existentes
      setSql = `verificado_por = $2, verificado_at = now()`;
    }

    const { rows: upd } = await client.query(
      `
      UPDATE personas
      SET ${setSql},
          modificado_por = $2,
          updated_at     = now()
      WHERE id_persona = $1
      RETURNING
        id_persona,
        verif_area_por, verif_area_at,
        verif_office_por, verif_office_at,
        verificado_por, verificado_at
      `,
      [id_persona, req.user.id_usuario]
    );

    await client.query("COMMIT");
    return res.json({ ok: true, persona: upd[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    return res.status(500).json({ error: "Error al verificar", detail: e.message });
  } finally {
    client.release();
  }
};

exports.desverificarPersona = async (req, res) => {
  const client = await pool.connect();
  try {
    const id_persona = Number(req.params.id);
    if (!Number.isFinite(id_persona) || id_persona <= 0) {
      return res.status(400).json({ error: "id inválido" });
    }
    const puedeVerificarFinal = req.user?.puede_verificar_final === true;
    const roles = req.user?.roles || [];
    const scope = req.user?.scope || null;
    const isSuperadmin = roles.includes("superadmin") || scope === "ALL";
    const isAnalista = roles.includes("analista");
    

    if (!isSuperadmin && !isAnalista) return res.status(403).json({ error: "Prohibido" });
    if (!["AREA", "OFFICE", "ALL"].includes(scope)) {
      return res.status(403).json({ error: "Sin permiso de desverificación" });
    }

    if (scope === "ALL" && !puedeVerificarFinal) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Este usuario no tiene permiso para retirar la verificación FINAL." });
    }

    await client.query("BEGIN");

    const { rows } = await client.query(
      `SELECT id_persona, id_oficina FROM personas WHERE id_persona = $1 FOR UPDATE`,
      [id_persona]
    );

    if (!rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Persona no encontrada" });
    }

    if (!isSuperadmin) {
      const forced = Number(req.user.id_oficina || 0);
      if (!forced) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Usuario sin oficina asignada" });
      }
      if (Number(rows[0].id_oficina) !== forced) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "No autorizado" });
      }
    }

    let setSql = "";
    if (scope === "AREA") {
      // si se cae AREA, se cae todo arriba
      setSql = `
        verif_area_por = NULL, verif_area_at = NULL,
        verif_office_por = NULL, verif_office_at = NULL,
        verificado_por = NULL, verificado_at = NULL
      `;
    } else if (scope === "OFFICE") {
      // si se cae OFFICE, se cae admin
      setSql = `
        verif_office_por = NULL, verif_office_at = NULL,
        verificado_por = NULL, verificado_at = NULL
      `;
    } else {
      // ALL: solo quita el último sello
      setSql = `verificado_por = NULL, verificado_at = NULL`;
    }

    const { rows: upd } = await client.query(
      `
      UPDATE personas
      SET ${setSql},
          modificado_por = $2,
          updated_at     = now()
      WHERE id_persona = $1
      RETURNING
        id_persona,
        verif_area_por, verif_area_at,
        verif_office_por, verif_office_at,
        verificado_por, verificado_at
      `,
      [id_persona, req.user.id_usuario]
    );

    await client.query("COMMIT");
    return res.json({ ok: true, persona: upd[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    return res.status(500).json({ error: "Error al desverificar", detail: e.message });
  } finally {
    client.release();
  }
};
//observaciones
exports.listObservacionesPersona = async (req, res) => {
  const client = await pool.connect();
  try {
    const id_persona = Number(req.params.id);
    if (!Number.isFinite(id_persona) || id_persona <= 0) {
      return res.status(400).json({ error: "id invalido" });
    }

    const { addFullFilter } = req.smartFilters;
    const params = [];
    const where = [];
    addFullFilter(params, where);

    params.push(id_persona);
    where.push(`p.id_persona = $${params.length}`);

    if (!req.smartFilters?.isSuperadmin && req.smartFilters?.scope && req.smartFilters.scope !== "ALL") {
      params.push(req.smartFilters.scope);
      where.push(`po.dirigido_a = $${params.length}`);
    }

    const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const { rows } = await client.query(
      `
      SELECT
        po.id_observacion,
        po.id_persona,
        po.nivel,
        po.dirigido_a,
        po.observacion,
        po.creado_por,
        po.created_at,
        po.atendida,
        po.atendida_at,
        po.atendida_por,
        u_crea.nombre AS creado_por_nombre,
        u_crea.cargo AS creado_por_cargo,
        u_atiende.nombre AS atendida_por_nombre
      FROM personas_observaciones po
      JOIN personas p ON p.id_persona = po.id_persona
      LEFT JOIN usuarios u_crea ON u_crea.id_usuario = po.creado_por
      LEFT JOIN usuarios u_atiende ON u_atiende.id_usuario = po.atendida_por
      ${whereSQL}
      ORDER BY po.atendida ASC, po.created_at DESC, po.id_observacion DESC
      `,
      params
    );

    return res.json({ ok: true, data: rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      error: "Error al obtener observaciones",
      detail: e.message
    });
  } finally {
    client.release();
  }
};

exports.devolverPersonaFinal = async (req, res) => {
  const client = await pool.connect();
  try {
    const id_persona = Number(req.params.id);
    const observacion = String(req.body?.observacion || "").trim();
    const dirigidoA = String(req.body?.dirigido_a || "SELF").trim().toUpperCase();

    if (!Number.isFinite(id_persona) || id_persona <= 0) {
      return res.status(400).json({ error: "id inválido" });
    }

    if (!observacion) {
      return res.status(400).json({ error: "La observación es obligatoria" });
    }

    if (!["AREA", "OFFICE", "SELF"].includes(dirigidoA)) {
      return res.status(400).json({ error: "Destino de observacion invalido" });
    }

    const scope = req.user?.scope || null;
    const puedeVerificarFinal = req.user?.puede_verificar_final === true;

    if (scope !== "ALL" || !puedeVerificarFinal) {
      return res.status(403).json({ error: "Sin permiso para devolución FINAL" });
    }

    await client.query("BEGIN");

    const { rows } = await client.query(
      `
      SELECT
        p.id_persona,
        p.verif_area_at,
        p.verif_office_at,
        p.verificado_at,
        p.creado_por,
        p.verif_area_por,
        p.verif_office_por
      FROM personas p
      WHERE p.id_persona = $1
      FOR UPDATE
      `,
      [id_persona]
    );

    if (!rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Persona no encontrada" });
    }

    await client.query(
      `
      INSERT INTO personas_observaciones
        (id_persona, nivel, dirigido_a, observacion, creado_por)
      VALUES
        ($1, 'FINAL', $2, $3, $4)
      `,
      [id_persona, dirigidoA, observacion, req.user.id_usuario]
    );

    const { rows: upd } = await client.query(
      `
      UPDATE personas
      SET
        verificado_por = NULL,
        verificado_at = NULL,
        modificado_por = $2,
        updated_at = now()
      WHERE id_persona = $1
      RETURNING
        id_persona,
        verif_area_por, verif_area_at,
        verif_office_por, verif_office_at,
        verificado_por, verificado_at
      `,
      [id_persona, req.user.id_usuario]
    );

    await client.query("COMMIT");

    return res.json({
      ok: true,
      message: "Observación enviada y verificación final retirada.",
      persona: upd[0]
    });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    return res.status(500).json({
      error: "Error al devolver registro con observación",
      detail: e.message
    });
  } finally {
    client.release();
  }
};

//observaciones atendidas
exports.atenderObservacionPersona = async (req, res) => {
  const client = await pool.connect();
  try {
    const id_observacion = Number(req.params.idObservacion);
    if (!Number.isFinite(id_observacion) || id_observacion <= 0) {
      return res.status(400).json({ error: "idObservacion inválido" });
    }

    const { addScopeFilter } = req.smartFilters;
    const params = [];
    const where = [];
    addScopeFilter(params, where);

    params.push(id_observacion);
    where.push(`po.id_observacion = $${params.length}`);

    if (!req.smartFilters?.isSuperadmin && req.smartFilters?.scope && req.smartFilters.scope !== "ALL") {
      params.push(req.smartFilters.scope);
      where.push(`po.dirigido_a = $${params.length}`);
    }

    const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

    await client.query("BEGIN");

    const sqlCheck = `
      SELECT
        po.id_observacion,
        po.id_persona,
        po.dirigido_a,
        po.atendida
      FROM personas_observaciones po
      JOIN personas p ON p.id_persona = po.id_persona
      ${whereSQL}
      FOR UPDATE
    `;

    const { rows } = await client.query(sqlCheck, params);

    if (!rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Observación no encontrada o sin acceso" });
    }

    if (rows[0].atendida === true) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "La observación ya fue atendida" });
    }

    const { rows: upd } = await client.query(
      `
      UPDATE personas_observaciones
      SET
        atendida = true,
        atendida_at = now(),
        atendida_por = $2
      WHERE id_observacion = $1
      RETURNING
        id_observacion,
        id_persona,
        nivel,
        observacion,
        created_at,
        atendida,
        atendida_at,
        atendida_por
      `,
      [id_observacion, req.user.id_usuario]
    );

    await client.query("COMMIT");
    return res.json({ ok: true, observacion: upd[0] });

  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    return res.status(500).json({
      error: "Error al marcar observación como atendida",
      detail: e.message
    });
  } finally {
    client.release();
  }
};

exports.kpiAlertasDashboard = async (req, res) => {
  const client = await pool.connect();
  try {
    const { addFullFilter } = req.smartFilters;
    const params = [];
    const where = [];
    addFullFilter(params, where);

    const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const sql = `
      WITH base_personas AS (
        SELECT p.id_persona
        FROM personas p
        ${whereSQL}
      )
      SELECT
        (
          SELECT COUNT(*)::int
          FROM personas_observaciones po
          JOIN base_personas bp ON bp.id_persona = po.id_persona
          WHERE po.atendida = false
        ) AS observaciones_pendientes,

        (
          SELECT COUNT(*)::int
          FROM personas_observaciones po
          JOIN base_personas bp ON bp.id_persona = po.id_persona
          WHERE po.atendida = true
        ) AS observaciones_atendidas_hoy,

        (
          SELECT COUNT(*)::int
          FROM personas_observaciones po
          JOIN base_personas bp ON bp.id_persona = po.id_persona
          WHERE po.nivel = 'FINAL'
            AND po.created_at >= now() - interval '7 days'
        ) AS devoluciones_final_7d,

        COALESCE((
          SELECT jsonb_agg(to_jsonb(x))
          FROM (
            SELECT
              po.id_observacion,
              po.id_persona,
              concat_ws(' ', p.nombre, p.apellido_paterno, p.apellido_materno) AS persona,
              po.nivel,
              po.dirigido_a,
              po.observacion,
              po.created_at,
              u_crea.nombre    AS creado_por_nombre,
              o.nombre         AS oficina_nombre,
              u_cap.nombre     AS capturista_nombre,
              CASE po.dirigido_a
                WHEN 'SELF' THEN u_cap.nombre
                WHEN 'AREA' THEN (
                  SELECT u.nombre FROM usuarios u
                  WHERE u.id_oficina = p.id_oficina AND u.scope = 'AREA' AND u.activo = true
                  LIMIT 1
                )
                WHEN 'OFFICE' THEN (
                  SELECT u.nombre FROM usuarios u
                  WHERE u.id_oficina = p.id_oficina AND u.scope = 'OFFICE' AND u.activo = true
                  LIMIT 1
                )
                ELSE NULL
              END AS dirigido_a_nombre
            FROM personas_observaciones po
            JOIN base_personas bp ON bp.id_persona = po.id_persona
            JOIN personas p        ON p.id_persona  = po.id_persona
            LEFT JOIN usuarios u_crea ON u_crea.id_usuario = po.creado_por
            LEFT JOIN oficinas o      ON o.id_oficina      = p.id_oficina
            LEFT JOIN usuarios u_cap  ON u_cap.id_usuario  = p.creado_por
            WHERE po.atendida = false
            ORDER BY po.created_at DESC, po.id_observacion DESC
            LIMIT 25
          ) x
        ), '[]'::jsonb) AS observaciones_pendientes_detalle,

        COALESCE((
          SELECT jsonb_agg(to_jsonb(x))
          FROM (
            SELECT
              po.id_observacion,
              po.id_persona,
              concat_ws(' ', p.nombre, p.apellido_paterno, p.apellido_materno) AS persona,
              po.nivel,
              po.dirigido_a,
              po.observacion,
              po.created_at,
              po.atendida_at,
              u_crea.nombre    AS creado_por_nombre,
              u_atiende.nombre AS atendida_por_nombre,
              o.nombre         AS oficina_nombre,
              u_cap.nombre     AS capturista_nombre,
              CASE po.dirigido_a
                WHEN 'SELF' THEN u_cap.nombre
                WHEN 'AREA' THEN (
                  SELECT u.nombre FROM usuarios u
                  WHERE u.id_oficina = p.id_oficina AND u.scope = 'AREA' AND u.activo = true
                  LIMIT 1
                )
                WHEN 'OFFICE' THEN (
                  SELECT u.nombre FROM usuarios u
                  WHERE u.id_oficina = p.id_oficina AND u.scope = 'OFFICE' AND u.activo = true
                  LIMIT 1
                )
                ELSE NULL
              END AS dirigido_a_nombre
            FROM personas_observaciones po
            JOIN base_personas bp ON bp.id_persona = po.id_persona
            JOIN personas p        ON p.id_persona  = po.id_persona
            LEFT JOIN usuarios u_crea    ON u_crea.id_usuario   = po.creado_por
            LEFT JOIN usuarios u_atiende ON u_atiende.id_usuario = po.atendida_por
            LEFT JOIN oficinas o         ON o.id_oficina         = p.id_oficina
            LEFT JOIN usuarios u_cap     ON u_cap.id_usuario     = p.creado_por
            WHERE po.atendida = true
            ORDER BY po.atendida_at DESC, po.id_observacion DESC
            LIMIT 25
          ) x
        ), '[]'::jsonb) AS observaciones_atendidas_hoy_detalle,

        COALESCE((
          SELECT jsonb_agg(to_jsonb(x))
          FROM (
            SELECT
              po.id_observacion,
              po.id_persona,
              concat_ws(' ', p.nombre, p.apellido_paterno, p.apellido_materno) AS persona,
              po.nivel,
              po.dirigido_a,
              po.observacion,
              po.created_at,
              u_crea.nombre AS creado_por_nombre,
              o.nombre      AS oficina_nombre,
              u_cap.nombre  AS capturista_nombre,
              CASE po.dirigido_a
                WHEN 'SELF' THEN u_cap.nombre
                WHEN 'AREA' THEN (
                  SELECT u.nombre FROM usuarios u
                  WHERE u.id_oficina = p.id_oficina AND u.scope = 'AREA' AND u.activo = true
                  LIMIT 1
                )
                WHEN 'OFFICE' THEN (
                  SELECT u.nombre FROM usuarios u
                  WHERE u.id_oficina = p.id_oficina AND u.scope = 'OFFICE' AND u.activo = true
                  LIMIT 1
                )
                ELSE NULL
              END AS dirigido_a_nombre
            FROM personas_observaciones po
            JOIN base_personas bp ON bp.id_persona = po.id_persona
            JOIN personas p       ON p.id_persona  = po.id_persona
            LEFT JOIN usuarios u_crea ON u_crea.id_usuario = po.creado_por
            LEFT JOIN oficinas o      ON o.id_oficina      = p.id_oficina
            LEFT JOIN usuarios u_cap  ON u_cap.id_usuario  = p.creado_por
            WHERE po.nivel = 'FINAL'
              AND po.created_at >= now() - interval '7 days'
            ORDER BY po.created_at DESC, po.id_observacion DESC
            LIMIT 25
          ) x
        ), '[]'::jsonb) AS devoluciones_final_7d_detalle,


        -- registros ocultos (solo superadmin ve esto; para otros siempre 0)
        (
          SELECT COUNT(*)::int
          FROM personas p2
          WHERE p2.oculto = true
        ) AS registros_ocultos,

        COALESCE((
          SELECT jsonb_agg(to_jsonb(x))
          FROM (
            SELECT
              p2.id_persona,
              concat_ws(' ', p2.nombre, p2.apellido_paterno, p2.apellido_materno) AS persona,
              p2.oculto_at,
              u_oculto.nombre AS oculto_por_nombre,
              o.nombre AS oficina_nombre
            FROM personas p2
            LEFT JOIN usuarios u_oculto ON u_oculto.id_usuario = p2.oculto_por
            LEFT JOIN oficinas o ON o.id_oficina = p2.id_oficina
            WHERE p2.oculto = true
            ORDER BY p2.oculto_at DESC
            LIMIT 10
          ) x
        ), '[]'::jsonb) AS registros_ocultos_detalle
    `;

    const { rows } = await client.query(sql, params);
    const data = rows[0] || {};

    // ── Desverificados automáticos (columnas opcionales, requieren migración) ─
    try {
      const { rows: dv } = await client.query(`
        SELECT
          COUNT(*)::int AS desverificados_auto,
          COALESCE((
            SELECT jsonb_agg(to_jsonb(x))
            FROM (
              SELECT
                p2.id_persona,
                concat_ws(' ', p2.nombre, p2.apellido_paterno, p2.apellido_materno) AS persona,
                p2.desverf_final_at,
                p2.desverf_final_campos,
                p2.verif_office_at,
                u_dv.nombre AS desverf_por_nombre,
                o.nombre    AS oficina_nombre
              FROM personas p2
              LEFT JOIN usuarios u_dv ON u_dv.id_usuario = p2.desverf_final_por
              LEFT JOIN oficinas o   ON o.id_oficina     = p2.id_oficina
              WHERE p2.desverf_final_at IS NOT NULL
                AND p2.verificado_at    IS NULL
              ORDER BY p2.desverf_final_at DESC
              LIMIT 10
            ) x
          ), '[]'::jsonb) AS desverificados_auto_detalle
        FROM personas p2
        WHERE p2.desverf_final_at IS NOT NULL
          AND p2.verificado_at    IS NULL
      `);
      data.desverificados_auto         = dv[0]?.desverificados_auto         ?? 0;
      data.desverificados_auto_detalle = dv[0]?.desverificados_auto_detalle ?? [];
    } catch (_) {
      // Columnas aún no existen — se ignora hasta correr la migración
      data.desverificados_auto         = 0;
      data.desverificados_auto_detalle = [];
    }

    return res.json({ ok: true, data });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Error KPI alertas", detail: e.message });
  } finally {
    client.release();
  }
};

// ── KPI Alertas para panel analista ──────────────────────────────────────────
// ── Observaciones paginadas para modal ───────────────────────────────────────
exports.alertasObservacionesPaginadas = async (req, res) => {
  const client = await pool.connect();
  try {
    const { addFullFilter } = req.smartFilters;
    const params = [];
    const where  = [];
    addFullFilter(params, where);
    const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const tipo   = String(req.query.tipo || "pendientes"); // pendientes | atendidas_hoy | final_7d
    const page   = Math.max(1, parseInt(req.query.page  || "1",  10));
    const size   = Math.min(100, Math.max(10, parseInt(req.query.size || "25", 10)));
    const offset = (page - 1) * size;

    // Construir condición según tipo
    let whereObs = "";
    let orderBy  = "po.created_at DESC, po.id_observacion DESC";
    if (tipo === "pendientes") {
      whereObs = "AND po.atendida = false";
    } else if (tipo === "atendidas_hoy") {
      whereObs = "AND po.atendida = true";
      orderBy  = "po.atendida_at DESC, po.id_observacion DESC";
    } else if (tipo === "final_7d") {
      whereObs = "AND po.nivel = 'FINAL' AND po.created_at >= now() - interval '7 days'";
    }

    const sqlTotal = `
      SELECT COUNT(*)::int AS total
      FROM personas_observaciones po
      JOIN (SELECT p.id_persona FROM personas p ${whereSQL}) bp ON bp.id_persona = po.id_persona
      WHERE 1=1 ${whereObs}
    `;

    const sqlData = `
      SELECT
        po.id_observacion, po.id_persona,
        concat_ws(' ', p.nombre, p.apellido_paterno, p.apellido_materno) AS persona,
        po.nivel, po.dirigido_a, po.observacion, po.created_at, po.atendida_at,
        u_crea.nombre    AS creado_por_nombre,
        u_atiende.nombre AS atendida_por_nombre,
        o.nombre         AS oficina_nombre,
        u_cap.nombre     AS capturista_nombre,
        CASE po.dirigido_a
          WHEN 'SELF' THEN u_cap.nombre
          WHEN 'AREA' THEN (
            SELECT u.nombre FROM usuarios u
            WHERE u.id_oficina = p.id_oficina AND u.scope = 'AREA' AND u.activo = true LIMIT 1
          )
          WHEN 'OFFICE' THEN (
            SELECT u.nombre FROM usuarios u
            WHERE u.id_oficina = p.id_oficina AND u.scope = 'OFFICE' AND u.activo = true LIMIT 1
          )
          ELSE NULL
        END AS dirigido_a_nombre
      FROM personas_observaciones po
      JOIN (SELECT p2.id_persona, p2.id_oficina, p2.creado_por,
                   p2.nombre, p2.apellido_paterno, p2.apellido_materno
            FROM personas p2 ${whereSQL}) p ON p.id_persona = po.id_persona
      LEFT JOIN usuarios u_crea    ON u_crea.id_usuario    = po.creado_por
      LEFT JOIN usuarios u_atiende ON u_atiende.id_usuario = po.atendida_por
      LEFT JOIN oficinas o         ON o.id_oficina         = p.id_oficina
      LEFT JOIN usuarios u_cap     ON u_cap.id_usuario     = p.creado_por
      WHERE 1=1 ${whereObs}
      ORDER BY ${orderBy}
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const [rTotal, rData] = await Promise.all([
      client.query(sqlTotal, params),
      client.query(sqlData,  [...params, size, offset])
    ]);

    const total     = rTotal.rows[0]?.total || 0;
    const last_page = Math.max(1, Math.ceil(total / size));

    return res.json({ ok: true, data: rData.rows, total, page, size, last_page });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Error al paginar observaciones", detail: e.message });
  } finally {
    client.release();
  }
};

exports.kpiAlertasAnalista = async (req, res) => {
  const client = await pool.connect();
  try {
    const { addFullFilter } = req.smartFilters;
    const params = [];
    const where  = [];
    addFullFilter(params, where);
    const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // Observaciones pendientes dirigidas al analista (scope: AREA u OFFICE)
    const sql = `
      WITH base_personas AS (
        SELECT p.id_persona FROM personas p ${whereSQL}
      )
      SELECT
        (
          SELECT COUNT(*)::int
          FROM personas_observaciones po
          JOIN base_personas bp ON bp.id_persona = po.id_persona
          WHERE po.atendida = false
        ) AS observaciones_pendientes,

        COALESCE((
          SELECT jsonb_agg(to_jsonb(x))
          FROM (
            SELECT
              po.id_observacion,
              po.id_persona,
              concat_ws(' ', p.nombre, p.apellido_paterno, p.apellido_materno) AS persona,
              po.nivel, po.dirigido_a, po.observacion, po.created_at,
              u_crea.nombre AS creado_por_nombre,
              CASE po.dirigido_a
                WHEN 'SELF' THEN u_cap.nombre
                WHEN 'AREA' THEN (
                  SELECT u.nombre FROM usuarios u
                  WHERE u.id_oficina = p.id_oficina AND u.scope = 'AREA' AND u.activo = true
                  LIMIT 1
                )
                WHEN 'OFFICE' THEN (
                  SELECT u.nombre FROM usuarios u
                  WHERE u.id_oficina = p.id_oficina AND u.scope = 'OFFICE' AND u.activo = true
                  LIMIT 1
                )
                ELSE NULL
              END AS dirigido_a_nombre
            FROM personas_observaciones po
            JOIN base_personas bp ON bp.id_persona = po.id_persona
            JOIN personas p        ON p.id_persona  = po.id_persona
            LEFT JOIN usuarios u_crea ON u_crea.id_usuario = po.creado_por
            LEFT JOIN usuarios u_cap  ON u_cap.id_usuario  = p.creado_por
            WHERE po.atendida = false
            ORDER BY po.created_at DESC
            LIMIT 8
          ) x
        ), '[]'::jsonb) AS observaciones_pendientes_detalle
    `;

    const { rows } = await client.query(sql, params);
    const data = rows[0] || {};

    // Desverificaciones AREA y OFFICE (columnas opcionales — requieren migración)
    try {
      const { rows: dv } = await client.query(`
        WITH base AS (SELECT p.id_persona FROM personas p ${whereSQL})
        SELECT
          COUNT(*) FILTER (
            WHERE p2.desverf_area_at IS NOT NULL AND p2.verif_area_at IS NULL
          )::int AS desverf_area,

          COUNT(*) FILTER (
            WHERE p2.desverf_office_at IS NOT NULL AND p2.verif_office_at IS NULL
          )::int AS desverf_office,

          COALESCE((
            SELECT jsonb_agg(to_jsonb(x))
            FROM (
              SELECT
                p2b.id_persona,
                concat_ws(' ', p2b.nombre, p2b.apellido_paterno, p2b.apellido_materno) AS persona,
                p2b.desverf_area_at, p2b.desverf_area_campos,
                u_a.nombre AS desverf_por_nombre,
                o.nombre   AS oficina_nombre
              FROM personas p2b
              JOIN base bp ON bp.id_persona = p2b.id_persona
              LEFT JOIN usuarios u_a ON u_a.id_usuario = p2b.desverf_area_por
              LEFT JOIN oficinas o   ON o.id_oficina   = p2b.id_oficina
              WHERE p2b.desverf_area_at IS NOT NULL AND p2b.verif_area_at IS NULL
              ORDER BY p2b.desverf_area_at DESC LIMIT 8
            ) x
          ), '[]'::jsonb) AS desverf_area_detalle,

          COALESCE((
            SELECT jsonb_agg(to_jsonb(x))
            FROM (
              SELECT
                p2b.id_persona,
                concat_ws(' ', p2b.nombre, p2b.apellido_paterno, p2b.apellido_materno) AS persona,
                p2b.desverf_office_at, p2b.desverf_office_campos,
                u_o.nombre AS desverf_por_nombre,
                o.nombre   AS oficina_nombre
              FROM personas p2b
              JOIN base bp ON bp.id_persona = p2b.id_persona
              LEFT JOIN usuarios u_o ON u_o.id_usuario = p2b.desverf_office_por
              LEFT JOIN oficinas o   ON o.id_oficina   = p2b.id_oficina
              WHERE p2b.desverf_office_at IS NOT NULL AND p2b.verif_office_at IS NULL
              ORDER BY p2b.desverf_office_at DESC LIMIT 8
            ) x
          ), '[]'::jsonb) AS desverf_office_detalle

        FROM personas p2
        JOIN base bp ON bp.id_persona = p2.id_persona
      `, params);

      Object.assign(data, dv[0] || {});
    } catch (_) {
      data.desverf_area           = 0;
      data.desverf_office         = 0;
      data.desverf_area_detalle   = [];
      data.desverf_office_detalle = [];
    }

    return res.json({ ok: true, data });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Error KPI alertas analista", detail: e.message });
  } finally {
    client.release();
  }
};

//notificaciones
exports.listNotificacionesDashboard = async (req, res) => {
  const client = await pool.connect();
  try {
    const params = [];
    const where = [];
    const scope = String(req.user?.scope || "").toUpperCase();
    const isSuper = (req.user?.roles || []).includes("superadmin") || scope === "ALL";

    if (!isSuper && req.smartFilters?.addScopeFilter) {
      req.smartFilters.addScopeFilter(params, where);
    }

    params.push(req.user.id_usuario);
    const idxUsuario = params.length;
    params.push(scope || "SELF");
    const idxScope = params.length;

    where.push(`
      po.creado_por <> $${idxUsuario}
      AND (
        (po.dirigido_a = 'SELF' AND p.creado_por = $${idxUsuario})
        OR (po.dirigido_a IN ('AREA', 'OFFICE') AND po.dirigido_a = $${idxScope})
      )
    `);

    const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const sql = `
      SELECT
        po.id_observacion AS id_evento,
        po.id_persona,
        po.nivel,
        po.dirigido_a,
        po.observacion AS detalle,
        po.created_at AS fecha,
        po.atendida,
        po.atendida_at,
        u.nombre AS usuario,
        concat_ws(' ', p.nombre, p.apellido_paterno, p.apellido_materno) AS nombre_completo,
        CASE
          WHEN pnl.id_lectura IS NOT NULL THEN true
          ELSE false
        END AS leida
      FROM personas_observaciones po
      JOIN personas p ON p.id_persona = po.id_persona
      LEFT JOIN usuarios u
        ON u.id_usuario = po.creado_por
      LEFT JOIN personas_notificaciones_lectura pnl
        ON pnl.id_observacion = po.id_observacion
       AND pnl.id_usuario = $${idxUsuario}
      ${whereSQL}
      ORDER BY po.atendida ASC, po.created_at DESC, po.id_observacion DESC
      LIMIT 30
    `;

    const { rows } = await client.query(sql, params);
    return res.json({ ok: true, data: rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      error: "Error al obtener notificaciones",
      detail: e.message
    });
  } finally {
    client.release();
  }
};

exports.marcarNotificacionLeida = async (req, res) => {
  const client = await pool.connect();
  try {
    const idObservacion = Number(req.params.idObservacion);
    if (!Number.isFinite(idObservacion) || idObservacion <= 0) {
      return res.status(400).json({ error: "idObservacion inválido" });
    }

    await client.query(
      `
      INSERT INTO personas_notificaciones_lectura (id_observacion, id_usuario)
      VALUES ($1, $2)
      ON CONFLICT (id_observacion, id_usuario) DO NOTHING
      `,
      [idObservacion, req.user.id_usuario]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      error: "Error al marcar notificación como leída",
      detail: e.message
    });
  } finally {
    client.release();
  }
};

exports.toggleOcultoPersona = async (req, res) => {
  const client = await pool.connect();
  try {
    const id_persona = Number(req.params.id);
    if (!Number.isFinite(id_persona) || id_persona <= 0)
      return res.status(400).json({ error: "id inválido" });

    const observacion = (req.body?.observacion || "").trim();
    const dirigidoA   = String(req.body?.dirigido_a || "SELF").toUpperCase();

    const { rows } = await client.query(
      `SELECT id_persona, oculto FROM personas WHERE id_persona = $1`,
      [id_persona]
    );
    if (!rows.length) return res.status(404).json({ error: "Persona no encontrada" });

    const nuevoEstado = !rows[0].oculto;

    // Al ocultar exigimos motivo; al mostrar no
    if (nuevoEstado && !observacion)
      return res.status(400).json({ error: "Debes escribir el motivo para ocultar el registro." });

    await client.query("BEGIN");

    const { rows: upd } = await client.query(
      `UPDATE personas
       SET oculto     = $2,
           oculto_at  = CASE WHEN $2 THEN now() ELSE NULL END,
           oculto_por = CASE WHEN $2 THEN $3::integer ELSE NULL END,
           updated_at = now()
       WHERE id_persona = $1
       RETURNING id_persona, oculto, oculto_at, oculto_por`,
      [id_persona, nuevoEstado, req.user.id_usuario]
    );

    // Solo al ocultar guardamos la observación (nivel OCULTO para identificarla)
    if (nuevoEstado) {
      await client.query(
        `INSERT INTO personas_observaciones
           (id_persona, nivel, dirigido_a, observacion, creado_por)
         VALUES ($1, 'OCULTO', $2, $3, $4)`,
        [id_persona, dirigidoA, observacion, req.user.id_usuario]
      );
    }

    await client.query("COMMIT");
    return res.json({ ok: true, oculto: upd[0].oculto, persona: upd[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    return res.status(500).json({ error: "Error al cambiar visibilidad", detail: e.message });
  } finally {
    client.release();
  }
};
