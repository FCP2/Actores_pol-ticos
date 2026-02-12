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

//helpers para actualizar:
async function getPersonaScope(client, id_persona) {
    const { rows } = await client.query(
      `SELECT id_persona, id_oficina, creado_por
      FROM personas
      WHERE id_persona = $1`,
      [id_persona]
    );
    return rows[0] || null;
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
  try {
    const { municipio_trabajo, search } = req.query;
    const limit = Math.min(Number(req.query.limit) || 30, 100);

    const roles = req.user?.roles || [];
    const isSuperadmin = roles.includes("superadmin");
    const isAnalista   = roles.includes("analista");
    const isCapturista = roles.includes("capturista");

    const params = [];
    const where = [];

    // ✅ SCOPE POR ROL
    if (!isSuperadmin) {
      if (isCapturista && !isAnalista) {
        // capturista puro: solo sus registros
        params.push(req.user.id_usuario);
        where.push(`p.creado_por = $${params.length}`);
      } else {
        // analista (y cualquier no-superadmin): por oficina
        if (!req.user?.id_oficina) {
          return res.status(403).json({ error: "Usuario sin oficina asignada" });
        }
        params.push(req.user.id_oficina);
        where.push(`p.id_oficina = $${params.length}`);
      }
    }

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
          p.nombre ILIKE $${i}
          OR p.apellido_paterno ILIKE $${i}
          OR p.apellido_materno ILIKE $${i}
          OR p.curp ILIKE $${i}
          OR p.rfc ILIKE $${i}
          OR p.clave_elector ILIKE $${i}
        )
      `);
    }

    // limit al final
    params.push(limit);

    const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const { rows } = await pool.query(
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
  }
};



//1.1. listar personas usuarios
exports.listPersonasAdminGrid = async (req, res) => {
  const client = await pool.connect();
  try {
    const roles = req.user?.roles || [];
    const isSuperadmin = roles.includes("superadmin");
    const isAnalista   = roles.includes("analista");
    const isCapturista = roles.includes("capturista");

    // -------- paginación
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const size = Math.min(Math.max(parseInt(req.query.size || "25", 10), 1), 200);
    const offset = (page - 1) * size;

    // -------- filtros
    let oficinaId = req.query.oficinaId ? Number(req.query.oficinaId) : null;
    const capturistaId = req.query.capturistaId ? Number(req.query.capturistaId) : null;
    const idMunTrabajo = req.query.municipio_trabajo ? Number(req.query.municipio_trabajo) : null;
    const q = (req.query.q || "").trim();

    // -------- ordenamiento (seguro)
    const sortDir = (String(req.query.sortDir || "desc").toLowerCase() === "asc") ? "ASC" : "DESC";
    const sortFieldRaw = String(req.query.sortField || "updated_at").trim();

    // Campos que sí permitimos ordenar
    const SORT_WHITELIST = new Set([
      "id_persona",
      "created_at",
      "updated_at",
      "nombre",
      "apellido_paterno",
      "apellido_materno",
      // Nota: si quieres ordenar por municipio/oficina/capturista, mejor lo hacemos con alias.
      // Por seguridad, aquí mantenemos solo campos reales de personas.
    ]);
    const sortField = SORT_WHITELIST.has(sortFieldRaw) ? sortFieldRaw : "updated_at";

    // -------- reglas por rol
    // analista: siempre forzamos su oficina
    if (isAnalista && !isSuperadmin) {
      const forced = Number(req.user.id_oficina || 0);
      if (!forced) return res.status(403).json({ error: "Usuario sin oficina asignada" });
      oficinaId = forced;
    }

    // capturista puro: solo sus registros (por si lo habilitas para grid)
    const forceCreadoPor = (isCapturista && !isAnalista && !isSuperadmin)
      ? Number(req.user.id_usuario || 0)
      : null;

    // -------- WHERE dinámico
    const where = [];
    const params = [];

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

    const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // -------- TOTAL
    const totalSql = `
      SELECT COUNT(*)::int AS total
      FROM personas p
      ${whereSQL}
    `;
    const { rows: totalRows } = await client.query(totalSql, params);
    const total = totalRows?.[0]?.total || 0;
    const last_page = Math.max(Math.ceil(total / size), 1);

    // -------- DATA
    const dataSql = `
      SELECT
        p.id_persona,
        p.nombre,
        p.apellido_paterno,
        p.apellido_materno,
        (p.nombre || ' ' || COALESCE(p.apellido_paterno,'') || ' ' || COALESCE(p.apellido_materno,'')) AS nombre_completo,

        p.curp,
        p.rfc,
        p.clave_elector,

        p.id_oficina,
        o.nombre AS oficina_nombre,

        p.creado_por,
        u_crea.nombre AS creado_por_nombre,
        u_crea.email  AS creado_por_email,

        p.modificado_por,
        u_mod.nombre AS modificado_por_nombre,
        u_mod.email  AS modificado_por_email,

        p.municipio_trabajo_politico,
        mt.nombre AS municipio_trabajo_nombre,

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

    return res.json({
      data: rows,
      total,
      page,
      size,
      last_page
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Error al obtener grid", detail: e.message });
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
      municipios_trabajo = [] // ✅ ya lo tomamos aquí en lugar de req.body después
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
        sin_controversias_publicas,
        id_partido_actual, partido_otro_texto,
        id_grupo_postulacion,
        id_ideologia_politica,
        sin_cargos_eleccion_popular,
        foto_url,
        id_oficina,
        nivel_confiabilidad
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
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
        persona.sin_controversias_publicas ?? null,
        persona.id_partido_actual || null,
        persona.partido_otro_texto || null,
        persona.id_grupo_postulacion || null,
        persona.id_ideologia_politica || null,
        persona.sin_cargos_eleccion_popular ?? null,
        persona.foto_url || null,
        oficinaFinal,
        nc // ✅ aquí va el valor final
      ]
    );

    const id_persona = insertPersona.rows[0].id_persona;

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

      const { rows } = await client.query(
        `INSERT INTO parejas (id_persona, nombre_pareja, tipo_relacion, periodo)
         VALUES ($1,$2,$3,$4)
         RETURNING id_pareja`,
        [id_persona, p.nombre_pareja || null, p.tipo_relacion || null, periodo || null]
      );

      if (p.temp_id) parejaMap.set(p.temp_id, rows[0].id_pareja);
    }

    for (const h of hijos) {
      const tieneAlgo = h?.anio_nacimiento || h?.sexo || h?.pareja_temp_id;
      if (!tieneAlgo) continue;

      const id_pareja = h.pareja_temp_id ? (parejaMap.get(h.pareja_temp_id) || null) : null;

      await client.query(
        `INSERT INTO hijos (id_persona, id_pareja, anio_nacimiento, sexo) VALUES ($1,$2,$3,$4)`,
        [id_persona, id_pareja, h.anio_nacimiento || null, h.sexo || null]
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
        `INSERT INTO referentes_politicos (id_persona, nivel, nombres, apellido_paterno, apellido_materno)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          id_persona,
          ref.nivel || null,
          ref.nombres || null,
          ref.apellido_paterno || null,
          ref.apellido_materno || null
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
      const tieneAlgo = f?.nombre || f?.parentesco || f?.cargo || f?.institucion;
      if (!tieneAlgo) continue;

      await client.query(
        `INSERT INTO familiares_politica (id_persona, nombre, parentesco, cargo, institucion)
         VALUES ($1,$2,$3,$4,$5)`,
        [id_persona, f.nombre || null, f.parentesco || null, f.cargo || null, f.institucion || null]
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
    for (const c of cargos_eleccion_popular) {
      const tieneAlgo = c?.periodo || c?.cargo || c?.partido_postulante || c?.modalidad;
      if (!tieneAlgo) continue;

      if (!c.cargo || !c.periodo) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Cada cargo de elección popular requiere periodo y cargo" });
      }

      if (c.modalidad && !["mr", "rp"].includes(c.modalidad)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "modalidad inválida (mr|rp)" });
      }

      await client.query(
        `INSERT INTO cargos_eleccion_popular (id_persona, periodo, cargo, partido_postulante, modalidad)
         VALUES ($1,$2,$3,$4,$5)`,
        [id_persona, c.periodo || null, c.cargo || null, c.partido_postulante || null, c.modalidad || null]
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
      const periodo = normalizePeriodo(e?.periodo);
      const notas = (e?.notas || "").trim();

      const tieneAlgo = nombre || rol || periodo || notas;
      if (!tieneAlgo) continue;

      if (!nombre) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Cada empresa requiere nombre_empresa" });
      }

      if (periodo && !isPeriodoValido(periodo)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Formato inválido en empresa. Usa AAAA o AAAA-AAAA" });
      }

      await client.query(
        `INSERT INTO empresas_persona (id_persona, nombre_empresa, rol, periodo, notas)
         VALUES ($1,$2,$3,$4,$5)`,
        [id_persona, nombre, rol || null, periodo || null, notas || null]
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
        -- NUEVO
        u_crea.nombre  AS creado_por_nombre,
        u_mod.nombre   AS modificado_por_nombre,
        o.nombre       AS oficina_nombre,
        p.created_at,
        p.updated_at,

        p.curp,
        p.rfc,
        p.clave_elector,
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

        ml.nombre AS municipio_residencia_legal,
        mr.nombre AS municipio_residencia_real,
        mt.nombre AS municipio_trabajo_politico,

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

        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'nombre_empresa', e.nombre_empresa,
            'rol', e.rol,
            'periodo', e.periodo,
            'notas', e.notas
          ) ORDER BY e.id_empresa_persona ASC)
          FROM empresas_persona e
          WHERE e.id_persona = $1
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

        -- CAPACIDAD MOVILIZACION (1:1)
        (
          SELECT CASE
            WHEN cm.id_persona IS NULL THEN NULL
            ELSE jsonb_build_object(
              'eventos_ultimos_3_anios', cm.eventos_ultimos_3_anios,
              'asistencia_promedio',     cm.asistencia_promedio
            )
          END
          FROM capacidad_movilizacion cm
          WHERE cm.id_persona = p.id_persona
          LIMIT 1
        ) AS capacidad_movilizacion,

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

        -- REFERENTES (nombres + apellidos, como en tu UI)
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_referente',     rp.id_referente,
              'nivel',            rp.nivel,
              'nombres',          rp.nombres,
              'apellido_paterno', rp.apellido_paterno,
              'apellido_materno', rp.apellido_materno
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
              'institucion', fp.institucion
            )
            ORDER BY fp.id_familiar ASC
          )
          FROM familiares_politica fp
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

        -- CARGOS DE ELECCION POPULAR (lista)
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_cargo_eleccion', cep.id_cargo_eleccion,
              'periodo', cep.periodo,
              'cargo', cep.cargo,
              'partido_postulante', cep.partido_postulante,
              'modalidad', cep.modalidad
            )
            ORDER BY cep.id_cargo_eleccion ASC
          )
          FROM cargos_eleccion_popular cep
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

        -- CAPACIDAD MOVILIZACION EVENTOS (lista)
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_evento', cme.id_evento,
              'nombre_evento', cme.nombre_evento,
              'fecha_evento', cme.fecha_evento,
              'asistencia', cme.asistencia,
              'lugar_evento', cme.lugar_evento,
              'foto_evento_url', cme.foto_evento_url
            )
            ORDER BY cme.id_evento ASC
          )
          FROM capacidad_movilizacion_eventos cme
          WHERE cme.id_persona = p.id_persona
        ), '[]'::jsonb) AS capacidad_movilizacion_eventos,

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
    if (roles.includes("capturista") && !roles.includes("analista") && !roles.includes("superadmin")) {
      const userId = Number(req.user.id_usuario || 0);
      if (rows[0].creado_por !== userId) {
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


// 4. Usuarios para filtro


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

// ===================== helpers =====================

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


function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
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


 function escAttr(s){
    return String(s ?? "").replace(/"/g, "&quot;");
  }


function buildPerfilHtml(p) {

  const nombreCompleto = joinFullName(p) || "—";
  const partido = p.partido_actual_siglas || p.partido_actual || "";
  const municipio = p.municipio_trabajo_politico || p.municipio_residencia_real || p.municipio_residencia_legal || "—";
  const foto = p.foto_url ? String(p.foto_url) : "";

 
  

  const flags = [
    p.sin_servicio_publico === true ? badge("Sin servicio público", "sec") : "",
    p.ha_contendido_eleccion === true ? badge("Ha contendió elección", "prim") : "",
    p.sin_controversias_publicas === true ? badge("Sin controversias", "ok") : "",
  ].filter(Boolean).join("");

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Perfil - ${esc(nombreCompleto)}</title>
  <style>
    :root{
      --prim:#8b2136;
      --sec:#b89056;
      --mut:#6b7280;
      --bg:#ffffff;
      --line:#e5e7eb;
      --ok:#16a34a;
    }
    *{ box-sizing:border-box; }
    body{
      font-family: Arial, Helvetica, sans-serif;
      background: var(--bg);
      margin: 0;
      padding: 22px;
      color:#111827;
    }
    .top{
      display:flex;
      gap:16px;
      align-items:flex-start;
      border:1px solid var(--line);
      border-radius:14px;
      padding:16px;
    }
    .photo{
      width:110px; height:140px;
      border-radius:12px;
      border:1px solid var(--line);
      background:#f3f4f6;
      overflow:hidden;
      flex:0 0 auto;
      display:flex; align-items:center; justify-content:center;
      color:var(--mut);
      font-size:12px;
    }
    .photo img{ width:100%; height:100%; object-fit:cover; }
    .title{ flex:1 1 auto; min-width:0; }
    .h1{ font-size:20px; margin:0; color:var(--prim); font-weight:800; }
    .sub{ margin-top:6px; color:var(--mut); font-size:13px; }
    .badges{ margin-top:10px; display:flex; gap:6px; flex-wrap:wrap; }
    .badge{
      display:inline-block;
      font-size:11px;
      padding:4px 8px;
      border-radius:999px;
      border:1px solid var(--line);
      background:#fafafa;
      white-space:nowrap;
    }
    .badge.prim{ background: rgba(139,33,54,.08); border-color: rgba(139,33,54,.18); }
    .badge.sec{ background: rgba(184,144,86,.10); border-color: rgba(184,144,86,.22); }
    .badge.ok{ background: rgba(22,163,74,.10); border-color: rgba(22,163,74,.20); color:#065f46; }
    .section{
      margin-top:14px;
      border:1px solid var(--line);
      border-radius:14px;
      padding:14px 16px;
    }
    .h2{
      font-size:12px;
      letter-spacing:.3px;
      color:var(--prim);
      font-weight:800;
      margin:0 0 10px 0;
      text-transform:uppercase;
    }
    .kv{
      display:grid;
      grid-template-columns: 190px 1fr;
      gap:8px 12px;
      font-size:12px;
    }
    .k{ color:var(--mut); }
    .v{ color:#111827; }
    .grid{
      display:grid;
      grid-template-columns: 1fr 1fr;
      gap:10px;
    }
    .item{
      border:1px solid var(--line);
      border-radius:12px;
      padding:10px;
      font-size:12px;
      break-inside: avoid;
    }
    .item .t{ font-weight:800; margin-bottom:4px; }
    .item .m{ color:var(--mut); font-size:11px; }
    .foot{
      margin-top:10px;
      color:var(--mut);
      font-size:10px;
      display:flex;
      justify-content:space-between;
      gap:10px;
    }
    .mono{ font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
  </style>
</head>
<body>

  <div class="top">
    <div class="photo">
      ${foto ? `<img src="${escAttr(foto)}" alt="foto"/>` : `Sin foto`}
    </div>

    <div class="title">
      <h1 class="h1">${esc(nombreCompleto)}</h1>
      <div class="sub">• ${esc(municipio)}</div>

      <div class="badges">
        ${badge(p.grupo_postulacion)}
        ${partido ? badge(partido, "prim") : ""}
        ${badge(p.ideologia_politica)}
        ${badge(p.tema_interes_central, "sec")}
        ${flags}
      </div>
    </div>
  </div>

  <section class="section">
    <div class="h2">Datos generales</div>
    <div class="kv">
      <div class="k">CURP</div><div class="v mono">${esc(p.curp || "—")}</div>
      <div class="k">RFC</div><div class="v mono">${esc(p.rfc || "—")}</div>
      <div class="k">Clave elector</div><div class="v mono">${esc(p.clave_elector || "—")}</div>
      <div class="k">Estado civil</div><div class="v">${esc(p.estado_civil || "—")}</div>

      <div class="k">Municipio legal</div><div class="v">${esc(p.municipio_residencia_legal || "—")}</div>
      <div class="k">Municipio real</div><div class="v">${esc(p.municipio_residencia_real || "—")}</div>
      <div class="k">Municipio trabajo</div><div class="v">${esc(p.municipio_trabajo_politico || "—")}</div>
    </div>
  </section>

  <section class="section">
    <div class="h2">INE</div>
    <div class="kv">
      <div class="k">Sección</div><div class="v">${esc(p?.datos_ine?.seccion_electoral || "—")}</div>
      <div class="k">Distrito federal</div><div class="v">${esc(p?.datos_ine?.distrito_federal || "—")}</div>
      <div class="k">Distrito local</div><div class="v">${esc(p?.datos_ine?.distrito_local || "—")}</div>
    </div>
  </section>

  ${listSection("Teléfonos", p.telefonos, (t)=>`
    <div class="item">
      <div class="t">${esc(t.telefono || "—")} ${t.principal ? badge("Principal", "ok") : ""}</div>
      <div class="m">${esc(t.tipo || "—")}</div>
    </div>
  `)}

  ${listSection("Formación académica", p.formacion_academica, (x)=>`
    <div class="item">
      <div class="t">${esc([x.nivel, x.grado_obtenido || x.grado].filter(Boolean).join(" • ") || "—")}</div>
      <div class="m">${esc(x.institucion || "")}</div>
      <div class="m">${esc((x.anio_inicio || "—") + " - " + (x.anio_fin || "—"))} ${x.titulado === true ? "• Titulado" : ""}</div>
    </div>
  `)}

  ${listSection("Redes sociales", p.redes_sociales, (r)=>`
    <div class="item">
      <div class="t">${esc(r.red || "—")}</div>
      <div class="m">${r.url ? esc(r.url) : "—"}</div>
    </div>
  `)}

  ${listSection("Temas de interés", p.temas_interes, (t)=>`
    <div class="item">
      <div class="t">${esc(t.tema || (t.id_tema ? ("Tema #" + t.id_tema) : "—"))}</div>
      ${t.otro_texto ? `<div class="m">${esc(t.otro_texto)}</div>` : `<div class="m">—</div>`}
    </div>
  `)}

  ${listSection("Cargos de elección popular", p.cargos_eleccion_popular, (c)=>`
    <div class="item">
      <div class="t">${esc(c.cargo || "—")}</div>
      <div class="m">${esc([c.periodo, c.modalidad, c.partido_postulante].filter(Boolean).join(" • ") || "")}</div>
    </div>
  `)}

  ${listSection("Servicio público", p.servicio_publico, (s)=>`
    <div class="item">
      <div class="t">${esc(s.cargo || "—")}</div>
      <div class="m">${esc(s.dependencia || "")}</div>
      <div class="m">${esc(s.periodo || "")}</div>
    </div>
  `)}

  ${listSection("Elecciones contendidas", p.elecciones, (e)=>`
    <div class="item">
      <div class="t">${esc([e.anio_eleccion, e.candidatura].filter(Boolean).join(" • ") || "—")}</div>
      <div class="m">${esc([e.partido_postulacion, e.resultado].filter(Boolean).join(" • ") || "")}</div>
      ${(e.diferencia_votos || e.diferencia_porcentaje) ? `<div class="m">Diferencia: ${esc(e.diferencia_votos ?? "—")} votos • ${esc(e.diferencia_porcentaje ?? "—")}%</div>` : `<div class="m"></div>`}
    </div>
  `)}

  ${listSection("Eventos de movilización", p.capacidad_movilizacion_eventos, (e)=>`
    <div class="item">
      <div class="t">${esc(e.nombre_evento || "—")}</div>
      <div class="m">${esc([e.fecha_evento, (e.asistencia != null ? ("Asistencia: " + e.asistencia) : null)].filter(Boolean).join(" • ") || "")}</div>
    </div>
  `)}

  ${listSection("Equipos políticos", p.equipos, (eq)=>`
    <div class="item">
      <div class="t">${esc(eq.nombre_equipo || "—")}</div>
      <div class="m">${eq.activo === true ? "Activo" : "Inactivo"}</div>
    </div>
  `)}

  ${listSection("Referentes políticos", p.referentes, (r)=>`
    <div class="item">
      <div class="t">${esc([r.nombres, r.apellido_paterno, r.apellido_materno].filter(Boolean).join(" ") || "—")}</div>
      <div class="m">${esc(r.nivel || "")}</div>
    </div>
  `)}

  ${listSection("Familiares en política", p.familiares, (f)=>`
    <div class="item">
      <div class="t">${esc([f.nombre, f.parentesco].filter(Boolean).join(" • ") || "—")}</div>
      <div class="m">${esc([f.cargo, f.institucion].filter(Boolean).join(" • ") || "")}</div>
    </div>
  `)}

  ${listSection("Participación en organizaciones", p.participacion_organizaciones, (o)=>`
    <div class="item">
      <div class="t">${esc((o.tipo ? (o.tipo + ": ") : "") + (o.nombre || "—"))}</div>
      <div class="m">${esc([o.rol, o.periodo].filter(Boolean).join(" • ") || "")}</div>
      ${o.notas ? `<div class="m">${esc(o.notas)}</div>` : ``}
    </div>
  `)}

  ${listSection("Experiencia laboral", p.experiencia_laboral, (x)=>`
    <div class="item">
      <div class="t">${esc(x.cargo || "—")}</div>
      <div class="m">${esc(x.organizacion || "")}</div>
      <div class="m">${esc(x.periodo || "")}</div>
    </div>
  `)}

  ${
    p.sin_controversias_publicas === true
      ? `<section class="section">
           <div class="h2">Controversias</div>
           <div class="item">Marcado como <strong>Sin controversias públicas</strong>.</div>
         </section>`
      : listSection("Controversias", p.controversias, (c)=>`
          <div class="item">
            <div class="t">${esc(c.tipo || ("Tipo #" + (c.id_tipo ?? "—")))}</div>
            <div class="m">${esc([c.estatus, c.fecha_registro].filter(Boolean).join(" • ") || "")}</div>
            ${c.fuente ? `<div class="m">Fuente: ${esc(c.fuente)}</div>` : ``}
            ${c.descripcion ? `<div class="m">${esc(c.descripcion)}</div>` : ``}
          </div>
        `)
  }

  <div class="foot">
    <div>Generado: ${esc(fmtDate(new Date()))}</div>
    <div>ID persona: ${esc(p.id_persona)}</div>
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

    // ⬆️ En lugar de pegarlo manualmente dentro de comentario,
    // pega tu SQL string aquí abajo (ya te lo dejo integrado):
    const sqlPerfil = `
      SELECT
        p.id_persona,
        p.nombre,
        p.apellido_paterno,
        p.apellido_materno,
        p.curp,
        p.rfc,
        p.clave_elector,
        p.estado_civil,
        p.escala_influencia,
        p.sin_servicio_publico,
        p.ha_contendido_eleccion,
        p.sin_controversias_publicas,
        p.foto_url,
        p.creado_por,
        p.created_at,
        p.updated_at,

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

        ml.nombre AS municipio_residencia_legal,
        mr.nombre AS municipio_residencia_real,
        mt.nombre AS municipio_trabajo_politico,

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

        (
          SELECT CASE
            WHEN cm.id_persona IS NULL THEN NULL
            ELSE jsonb_build_object(
              'eventos_ultimos_3_anios', cm.eventos_ultimos_3_anios,
              'asistencia_promedio',     cm.asistencia_promedio
            )
          END
          FROM capacidad_movilizacion cm
          WHERE cm.id_persona = p.id_persona
          LIMIT 1
        ) AS capacidad_movilizacion,

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
              'apellido_materno', rp.apellido_materno
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
              'institucion', fp.institucion
            )
            ORDER BY fp.id_familiar ASC
          )
          FROM familiares_politica fp
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
              'cargo', cep.cargo,
              'partido_postulante', cep.partido_postulante,
              'modalidad', cep.modalidad
            )
            ORDER BY cep.id_cargo_eleccion ASC
          )
          FROM cargos_eleccion_popular cep
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
              'id_evento', cme.id_evento,
              'nombre_evento', cme.nombre_evento,
              'fecha_evento', cme.fecha_evento,
              'asistencia', cme.asistencia
            )
            ORDER BY cme.id_evento ASC
          )
          FROM capacidad_movilizacion_eventos cme
          WHERE cme.id_persona = p.id_persona
        ), '[]'::jsonb) AS capacidad_movilizacion_eventos,

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

      LEFT JOIN catalogo_partidos cp            ON cp.id_partido   = p.id_partido_actual
      LEFT JOIN catalogo_temas_interes cti      ON cti.id_tema     = p.id_tema_interes_central
      LEFT JOIN catalogo_grupos_postulacion cgp ON cgp.id_grupo    = p.id_grupo_postulacion
      LEFT JOIN catalogo_ideologia_politica cip ON cip.id_ideologia = p.id_ideologia_politica

      WHERE p.id_persona = $1
      LIMIT 1
    `;

    const { rows } = await pool.query(sqlPerfil, [id]);
    if (!rows[0]) return res.status(404).json({ error: "Persona no encontrada" });

    // 🔒 regla capturista
    const roles = req.user?.roles || [];
    if (roles.includes("capturista") && rows[0].creado_por !== req.user.id_usuario) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const perfil = rows[0];

    // ✅ Foto URL -> base64 data-uri
    let fotoDataUri = null;
    try {
      fotoDataUri = await imageUrlToDataUri(perfil.foto_url);
    } catch (e) {
      console.warn("Foto no disponible para PDF:", e.message);
    }
    console.log("foto_url:", perfil.foto_url);
    console.log("fotoDataUri head:", (fotoDataUri || "").slice(0, 30));
    const html = buildPerfilHtml({ ...perfil, foto_url: fotoDataUri });

    // ✅ Render-friendly
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });

    const page = await browser.newPage();

    // Si usas base64, waitUntil:"load" es suficiente y más estable
    await page.setContent(html, { waitUntil: "load", timeout: 60000 });

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
    res.setHeader("Content-Disposition", `inline; filename="perfil_${id}.pdf"`);
    return res.end(pdfBuf);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Error al generar PDF", detail: e.message });
  } finally {
    try { if (browser) await browser.close(); } catch {}
  }
};



//kpi completitud de registros 
exports.kpiCompletitud = async (req, res) => {
  try {
    const SQL = `
      WITH base AS (
        SELECT
          p.id_persona,
          p.creado_por,

          -- Base fields
          p.nombre,
          p.municipio_trabajo_politico,
          p.id_partido_actual,
          p.escala_influencia,
          p.id_tema_interes_central,
          p.id_grupo_postulacion,
          p.id_ideologia_politica,

          -- flags
          p.sin_servicio_publico,
          p.ha_contendido_eleccion,
          p.sin_controversias_publicas,
          

          -- existence counts
          EXISTS (SELECT 1 FROM datos_ine di WHERE di.id_persona = p.id_persona) AS has_ine,
          (SELECT COUNT(*) FROM telefonos t WHERE t.id_persona = p.id_persona) AS n_telefonos,
          (SELECT COUNT(*) FROM redes_sociales_persona rs WHERE rs.id_persona = p.id_persona) AS n_redes,
          (SELECT COUNT(*) FROM formacion_academica fa WHERE fa.id_persona = p.id_persona) AS n_formacion,
          (SELECT COUNT(*) FROM servicio_publico sp WHERE sp.id_persona = p.id_persona) AS n_serv_pub,
          (SELECT COUNT(*) FROM elecciones_contendidas ec WHERE ec.id_persona = p.id_persona) AS n_elecciones,
          EXISTS (SELECT 1 FROM capacidad_movilizacion cm WHERE cm.id_persona = p.id_persona) AS has_movilizacion,
          (SELECT COUNT(*) FROM equipos_politicos ep WHERE ep.id_persona = p.id_persona) AS n_equipos,
          (SELECT COUNT(*) FROM referentes_politicos rp WHERE rp.id_persona = p.id_persona) AS n_referentes,
          (SELECT COUNT(*) FROM familiares_politica fp WHERE fp.id_persona = p.id_persona) AS n_familiares,
          (SELECT COUNT(*) FROM participacion_organizaciones po WHERE po.id_persona = p.id_persona) AS n_orgs,
          (SELECT COUNT(*) FROM controversias_persona c WHERE c.id_persona = p.id_persona) AS n_controversias

        FROM personas p
      ),

      scored AS (
        SELECT
          b.*,

          (
            -- ===== Base (30)
            (CASE WHEN NULLIF(TRIM(b.nombre), '') IS NOT NULL THEN 6 ELSE 0 END) +
            (CASE WHEN b.municipio_trabajo_politico IS NOT NULL THEN 6 ELSE 0 END) +
            (CASE WHEN b.id_partido_actual IS NOT NULL THEN 5 ELSE 0 END) +
            (CASE WHEN b.escala_influencia IS NOT NULL THEN 5 ELSE 0 END) +
            (CASE WHEN b.id_tema_interes_central IS NOT NULL THEN 4 ELSE 0 END) +
            (CASE WHEN b.id_grupo_postulacion IS NOT NULL THEN 2 ELSE 0 END) +
            (CASE WHEN b.id_ideologia_politica IS NOT NULL THEN 2 ELSE 0 END) +

            -- ===== Secciones (70)
            (CASE WHEN b.has_ine THEN 5 ELSE 0 END) +
            (CASE WHEN b.n_telefonos > 0 THEN 10 ELSE 0 END) +
            (CASE WHEN b.n_redes > 0 THEN 5 ELSE 0 END) +
            (CASE WHEN b.n_formacion > 0 THEN 7 ELSE 0 END) +

            -- Servicio público (10)
            (CASE
              WHEN b.sin_servicio_publico = true THEN 10
              WHEN b.sin_servicio_publico = false AND b.n_serv_pub > 0 THEN 10
              ELSE 0
            END) +

            -- Elecciones (10)
            (CASE
              WHEN b.ha_contendido_eleccion = false THEN 10
              WHEN b.ha_contendido_eleccion = true AND b.n_elecciones > 0 THEN 10
              ELSE 0
            END) +

            (CASE WHEN b.has_movilizacion THEN 6 ELSE 0 END) +
            (CASE WHEN b.n_equipos > 0 THEN 4 ELSE 0 END) +
            (CASE WHEN b.n_referentes > 0 THEN 4 ELSE 0 END) +
            (CASE WHEN b.n_familiares > 0 THEN 4 ELSE 0 END) +
            (CASE WHEN b.n_orgs > 0 THEN 3 ELSE 0 END) +

            -- Controversias (3)
            (CASE
              WHEN b.sin_controversias_publicas = true THEN 3
              WHEN b.sin_controversias_publicas = false AND b.n_controversias > 0 THEN 3
              ELSE 0
            END)
          )::int AS score

        FROM base b
      ),

      global AS (
        SELECT
          COUNT(*)::int AS total_personas,
          AVG(score)::numeric(5,2) AS score_promedio,
          SUM(CASE WHEN score >= 80 THEN 1 ELSE 0 END)::int AS completos_80,
          ROUND(100.0 * SUM(CASE WHEN score >= 80 THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2) AS pct_completos_80,
          SUM(CASE WHEN score < 50 THEN 1 ELSE 0 END)::int AS criticos_lt50
        FROM scored
      ),

      por_usuario AS (
        SELECT
          u.id_usuario,
          u.nombre,
          u.email,
          COUNT(s.id_persona)::int AS total,
          AVG(s.score)::numeric(5,2) AS score_promedio,
          SUM(CASE WHEN s.score >= 80 THEN 1 ELSE 0 END)::int AS completos_80,
          ROUND(100.0 * SUM(CASE WHEN s.score >= 80 THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2) AS pct_completos_80
        FROM scored s
        JOIN usuarios u ON u.id_usuario = s.creado_por
        GROUP BY u.id_usuario, u.nombre, u.email
        ORDER BY score_promedio DESC, total DESC
      )

      SELECT
        (SELECT row_to_json(global) FROM global) AS global,
        (SELECT COALESCE(json_agg(por_usuario), '[]'::json) FROM por_usuario) AS por_usuario;
    `;

    const { rows } = await pool.query(SQL);
    return res.json(rows[0]);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Error KPI completitud", detail: e.message });
  }
};

//kpi municipio trabajo político

exports.kpiMunicipios = async (req, res) => {
  try {
    const SQL = `
      WITH conteo AS (
        SELECT
          m.id_municipio,
          m.nombre AS municipio,
          COUNT(p.id_persona)::int AS total
        FROM municipios m
        LEFT JOIN personas p
          ON p.municipio_trabajo_politico = m.id_municipio
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
        (SELECT COALESCE(json_agg(conteo ORDER BY municipio), '[]'::json) FROM conteo) AS conteo;
    `;

    const { rows } = await pool.query(SQL);
    return res.json(rows[0]);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Error KPI municipios", detail: e.message });
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


//editar 

exports.updatePersonaCompleta = async (req, res) => {
  const client = await pool.connect();
  const id_persona = Number(req.params.id);
  if (!id_persona) return res.status(400).json({ error: "id inválido" });
  await assertCanMutatePersona(client, req, id_persona);
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
      empresas_persona=[],
      fuentes_consulta=[]
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



    // Reglas oficina por usuario (idénticas a create)
    const roles = req.user.roles || [];
    const isSuperadmin = roles.includes("superadmin");

    if (!isSuperadmin && !req.user.id_oficina) {
      return res.status(403).json({ error: "Usuario sin oficina asignada" });
    }

    const oficinaFinal = isSuperadmin
      ? (persona.id_oficina || req.user.id_oficina || null)
      : req.user.id_oficina;

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

    // reglas por rol
    const isCapturista = roles.includes("capturista");

    if (!isSuperadmin) {
      // oficina obligatoria
      if (owner.id_oficina !== req.user.id_oficina) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "No puedes editar registros de otra oficina" });
      }

      // capturista solo puede editar lo suyo
      if (isCapturista && owner.creado_por !== req.user.id_usuario) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Solo puedes editar tus propios registros" });
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
        sin_controversias_publicas = $15,
        id_partido_actual = $16,
        partido_otro_texto = $17,
        id_grupo_postulacion = $18,
        id_ideologia_politica = $19,
        sin_cargos_eleccion_popular = $20,
        foto_url = $21,
        id_oficina = $22,
        updated_at = now(),
        modificado_por = $23,
        nivel_confiabilidad = $24
      WHERE id_persona = $1
      `,
      [
        id_persona,
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
        persona.municipio_residencia_legal || null,
        persona.municipio_residencia_real || null,
        persona.municipio_trabajo_politico || null,
        persona.sin_controversias_publicas ?? null,
        persona.id_partido_actual || null,
        persona.partido_otro_texto || null,
        persona.id_grupo_postulacion || null,
        persona.id_ideologia_politica || null,
        persona.sin_cargos_eleccion_popular ?? null,
        persona.foto_url || null,
        oficinaFinal,
         req.user.id_usuario,                         // $23 ✅ modificado_por
        persona.nivel_confiabilidad = nc,
      ]
    );

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

      const { rows } = await client.query(
        `INSERT INTO parejas (id_persona, nombre_pareja, tipo_relacion, periodo)
         VALUES ($1,$2,$3,$4)
         RETURNING id_pareja`,
        [id_persona, p.nombre_pareja || null, p.tipo_relacion || null, periodo || null]
      );

      if (p.temp_id) parejaMap.set(p.temp_id, rows[0].id_pareja);
    }

    for (const h of hijos) {
      const tieneAlgo = h?.anio_nacimiento || h?.sexo || h?.pareja_temp_id || h?.id_pareja;
      if (!tieneAlgo) continue;

      const idPareja =
        h.id_pareja ||
        (h.pareja_temp_id ? (parejaMap.get(h.pareja_temp_id) || null) : null);

      await client.query(
        `INSERT INTO hijos (id_persona, id_pareja, anio_nacimiento, sexo)
         VALUES ($1,$2,$3,$4)`,
        [id_persona, idPareja, h.anio_nacimiento || null, h.sexo || null]
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
      const rol    = (em?.rol || "").toString().trim() || null;
      const notas  = (em?.notas || "").toString().trim() || null;
      const periodo = normalizePeriodo(em?.periodo); // ✅ igual que parejas

      const tieneAlgo = nombre || rol || periodo || notas;
      if (!tieneAlgo) continue;

      if (!nombre) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Cada empresa requiere nombre_empresa" });
      }

      if (periodo && !isPeriodoValido(periodo)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Periodo inválido en empresa. Usa AAAA o AAAA-AAAA" });
      }

      await client.query(
        `INSERT INTO empresas_persona (id_persona, nombre_empresa, rol, periodo, notas)
        VALUES ($1,$2,$3,$4,$5)`,
        [id_persona, nombre, rol, periodo || null, notas]
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
        `INSERT INTO referentes_politicos (id_persona, nivel, nombres, apellido_paterno, apellido_materno)
         VALUES ($1,$2,$3,$4,$5)`,
        [id_persona, ref.nivel || null, ref.nombres || null, ref.apellido_paterno || null, ref.apellido_materno || null]
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
      const tieneAlgo = f?.nombre || f?.parentesco || f?.cargo || f?.institucion;
      if (!tieneAlgo) continue;

      await client.query(
        `INSERT INTO familiares_politica (id_persona, nombre, parentesco, cargo, institucion)
         VALUES ($1,$2,$3,$4,$5)`,
        [id_persona, f.nombre || null, f.parentesco || null, f.cargo || null, f.institucion || null]
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
    for (const c of cargos_eleccion_popular) {
      const tieneAlgo = c?.periodo || c?.cargo || c?.partido_postulante || c?.modalidad;
      if (!tieneAlgo) continue;

      if (!c.cargo || !c.periodo) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Cada cargo de elección popular requiere periodo y cargo" });
      }
      if (c.modalidad && !["mr", "rp"].includes(c.modalidad)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "modalidad inválida (mr|rp)" });
      }

      await client.query(
        `INSERT INTO cargos_eleccion_popular (id_persona, periodo, cargo, partido_postulante, modalidad)
         VALUES ($1,$2,$3,$4,$5)`,
        [id_persona, c.periodo || null, c.cargo || null, c.partido_postulante || null, c.modalidad || null]
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
    // 1️⃣ PERSONA (primero SIEMPRE)
    await assertCanMutatePersona(client, req, id_persona);
    const { rows: pRows } = await client.query(
      `SELECT
        id_persona,
        nombre, apellido_paterno, apellido_materno, curp, rfc, clave_elector,
        estado_civil, escala_influencia, sin_servicio_publico, ha_contendido_eleccion,
        municipio_residencia_legal, municipio_residencia_real, municipio_trabajo_politico,
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
        nivel_confiabilidad
      FROM personas
      WHERE id_persona = $1`,
      [id_persona]
    );

    if (!pRows.length) {
      return res.status(404).json({ error: "Persona no encontrada" });
    }

    const persona = pRows[0];

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
           periodo
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
           anio_nacimiento,
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
        `SELECT id_empresa_persona, nombre_empresa, rol, periodo, notas
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
        `SELECT nivel, nombres, apellido_paterno, apellido_materno
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
        `SELECT nombre, parentesco, cargo, institucion
         FROM familiares_politica
         WHERE id_persona = $1
         ORDER BY id_familiar ASC`,
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
        `SELECT periodo, cargo, partido_postulante, modalidad
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

    ]);
    
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

    return res.json({
      persona,
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

    // WHERE dinámico
    const where = [];
    const params = [];

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
// ADMIN: listar capturistas por oficina (para filtros del grid)
exports.listCapturistasByOficina = async (req, res) => {
  try {
    const rolesUser = req.user?.roles || [];
    const isSuperadmin = rolesUser.includes("superadmin");
    const isAnalista   = rolesUser.includes("analista");

    let oficinaId = null;

    // 🔒 Regla por rol:
    // - Analista: siempre su oficina
    // - Superadmin: puede mandar oficinaId en query (opcional)
    if (isAnalista && !isSuperadmin) {
      oficinaId = Number(req.user.id_oficina || 0);
      if (!Number.isFinite(oficinaId) || oficinaId <= 0) {
        return res.status(403).json({ error: "Usuario sin oficina asignada" });
      }
    } else {
      oficinaId = req.query.oficinaId ? Number(req.query.oficinaId) : null;
    }

    const params = [];
    const where = [];

    if (Number.isFinite(oficinaId) && oficinaId > 0) {
      params.push(oficinaId);
      where.push(`u.id_oficina = $${params.length}`);
    }

    // ✅ Solo usuarios con rol "capturista" (y si quieres incluir analista también, lo agregamos)
    // Aquí lo dejo: capturista (y opcionalmente analista)
    where.push(`r.nombre IN ('capturista')`);

    const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const { rows } = await pool.query(
      `
      SELECT DISTINCT
        u.id_usuario,
        u.nombre,
        u.email
      FROM usuarios u
      JOIN usuarios_roles ur ON ur.id_usuario = u.id_usuario
      JOIN roles r           ON r.id_rol     = ur.id_rol
      ${whereSQL}
      ORDER BY u.nombre ASC
      `,
      params
    );

    return res.json(rows);
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      error: "Error al listar capturistas por oficina",
      detail: e.message
    });
  }
};

