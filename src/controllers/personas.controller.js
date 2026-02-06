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
  try {

    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize || 25)));
    const offset = (page - 1) * pageSize;

    const q = (req.query.q || '').trim();
    const creadoPor = req.query.creado_por ? Number(req.query.creado_por) : null;
    const municipioTrabajo = req.query.municipio_trabajo ? Number(req.query.municipio_trabajo) : null;

    const sortMap = {
      created_at: 'p.created_at',
      nombre: 'p.nombre',
      municipio: 'mt.nombre',
      escala_influencia: 'p.escala_influencia',
      capturista: 'u.nombre'
    };
    const sortKey = String(req.query.sort || 'created_at');
    const sortCol = sortMap[sortKey] || 'p.created_at';
    const dir = String(req.query.dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const where = [];
    const params = [];
    let i = 1;

    if (Number.isFinite(creadoPor) && creadoPor > 0) {
      where.push(`p.creado_por = $${i++}`);
      params.push(creadoPor);
    }

    if (Number.isFinite(municipioTrabajo) && municipioTrabajo > 0) {
      where.push(`p.municipio_trabajo_politico = $${i++}`);
      params.push(municipioTrabajo);
    }

    if (q) {
      where.push(`(
        p.nombre ILIKE $${i} OR
        p.curp ILIKE $${i} OR
        p.rfc ILIKE $${i} OR
        p.clave_elector ILIKE $${i}
      )`);
      params.push(`%${q}%`);
      i++;
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const fromSql = `
      FROM personas p
      LEFT JOIN municipios mt ON mt.id_municipio = p.municipio_trabajo_politico
      LEFT JOIN catalogo_partidos cp ON cp.id_partido = p.id_partido_actual
      LEFT JOIN catalogo_temas_interes cti ON cti.id_tema = p.id_tema_interes_central
      LEFT JOIN catalogo_grupos_postulacion cgp ON cgp.id_grupo = p.id_grupo_postulacion
      LEFT JOIN catalogo_ideologia_politica cip ON cip.id_ideologia = p.id_ideologia_politica
      LEFT JOIN usuarios u ON u.id_usuario = p.creado_por
      LEFT JOIN usuarios_roles ur ON ur.id_usuario = u.id_usuario
      LEFT JOIN roles r ON r.id_rol = ur.id_rol
      ${whereSql}
    `;

    const totalQ = await pool.query(`SELECT COUNT(DISTINCT p.id_persona)::int AS total ${fromSql}`, params);
    const total = totalQ.rows[0]?.total ?? 0;

    params.push(pageSize, offset);

    const dataQ = await pool.query(
      `
      SELECT
        p.id_persona,
        p.nombre,
        p.escala_influencia,
        p.created_at,
        p.sin_controversias_publicas,

        mt.nombre AS municipio_trabajo_politico,

        cp.siglas AS partido_actual_siglas,
        cp.nombre AS partido_actual,
        cti.nombre AS tema_interes_central,
        cgp.nombre AS grupo_postulacion,
        cip.nombre AS ideologia_politica,

        p.creado_por,
        u.nombre AS creado_por_nombre,
        u.email  AS creado_por_email,

        COALESCE(
          jsonb_agg(DISTINCT r.nombre) FILTER (WHERE r.nombre IS NOT NULL),
          '[]'::jsonb
        ) AS creado_por_roles
      ${fromSql}
      GROUP BY
        p.id_persona, p.nombre, p.escala_influencia, p.created_at, p.sin_controversias_publicas,
        mt.nombre,
        cp.siglas, cp.nombre,
        cti.nombre,
        cgp.nombre,
        cip.nombre,
        p.creado_por, u.nombre, u.email
      ORDER BY ${sortCol} ${dir}
      LIMIT $${i++} OFFSET $${i++}
      `,
      params
    );

    return res.json({ page, pageSize, total, rows: dataQ.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Error al listar grid', detail: e.message });
  }
};

// 2) CREAR PERSONA COMPLETA (transacción)
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
    } = req.body;

      if (persona.sin_controversias_publicas === true && controversias.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'No puede haber controversias si se marca "Sin controversias públicas"'
        });
      }
      // Si tema de interés es "Otro", debe venir texto
      // (mejor validar por id consultando el catálogo)
      if (persona.id_tema_interes_central) {
        const { rows: temaRows } = await client.query(
          'SELECT requiere_otro_texto FROM catalogo_temas_interes WHERE id_tema = $1',
          [persona.id_tema_interes_central]
        );

        if (!temaRows[0]) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Tema de interés inválido' });
        }

        if (temaRows[0].requiere_otro_texto && !persona.tema_interes_otro_texto) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Para el tema "Otro" se requiere texto' });
        }
      }

    // Validación mínima
    if (!persona?.nombre) {
      return res.status(400).json({ error: 'persona.nombre es obligatorio' });
    }

    await client.query('BEGIN');

    //reglas oficina por usuario:
    const roles = req.user.roles || [];
    const isSuperadmin = roles.includes("superadmin");

    if (!isSuperadmin && !req.user.id_oficina) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Usuario sin oficina asignada" });
    }

    const oficinaFinal = isSuperadmin
      ? (persona.id_oficina || req.user.id_oficina || null)
      : req.user.id_oficina;

    // PERSONA
    const creadoPor = req.user.id_usuario;
    const insertPersona = await client.query(
      `
      INSERT INTO personas (
        nombre, apellido_paterno, apellido_materno, curp, rfc, clave_elector, estado_civil, escala_influencia,sin_servicio_publico, ha_contendido_eleccion, creado_por,
        municipio_residencia_legal, municipio_residencia_real, municipio_trabajo_politico,
        sin_controversias_publicas,
        id_partido_actual, partido_otro_texto,
        id_grupo_postulacion,
        id_ideologia_politica,
        sin_cargos_eleccion_popular,
        foto_url,
        id_oficina
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
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
        oficinaFinal
      ]
    );


    const id_persona = insertPersona.rows[0].id_persona;
      
    // Validar "Otro" partido
    if (persona.id_partido_actual) {
      const { rows: pr } = await client.query(
        'SELECT nombre, siglas FROM catalogo_partidos WHERE id_partido = $1',
        [persona.id_partido_actual]
      );

      if (!pr[0]) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Partido inválido' });
      }

      const esOtro = (pr[0].nombre || '').toLowerCase() === 'otro' || (pr[0].siglas || '').toUpperCase() === 'OTRO';

      if (esOtro && !persona.partido_otro_texto) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Si partido es "Otro", se requiere partido_otro_texto' });
      }

      if (!esOtro && persona.partido_otro_texto) {
        // opcional: limpia si mandaron basura
        persona.partido_otro_texto = null;
      }
    }
    //validacion no contradiccion cargos eleccion popular
    if (persona.sin_cargos_eleccion_popular === true && cargos_eleccion_popular.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'No puede haber cargos de elección popular si se marca "No ha ocupado cargos de elección popular"'
      });
    }

    // temas de interes 1:N
    for (const t of temas_interes) {
      if (!t?.id_tema) continue;

      // validar si requiere otro_texto
      const { rows } = await client.query(
        'SELECT requiere_otro_texto FROM catalogo_temas_interes WHERE id_tema = $1',
        [t.id_tema]
      );

      if (!rows[0]) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Tema de interés inválido' });
      }

      if (rows[0].requiere_otro_texto && !t.otro_texto) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Para el tema "Otro" se requiere texto' });
      }

      await client.query(
        `
        INSERT INTO personas_temas_interes (id_persona, id_tema, otro_texto)
        VALUES ($1,$2,$3)
        `,
        [id_persona, t.id_tema, t.otro_texto || null]
      );
    }

    // FORMACION ACADEMICA (histórico-ready)
  for (const fa of formacion_academica) {
    const tieneAlgo =
      fa?.nivel ||
      fa?.grado ||
      fa?.grado_obtenido ||
      fa?.institucion ||
      fa?.anio_inicio ||
      fa?.titulado ||
      fa?.anio_fin;

    if (!tieneAlgo) continue;

    if (!fa.nivel) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'formacion_academica.nivel es obligatorio'
      });
    }

    const requiereDetalle = ['Educación Superior', 'Posgrado'].includes(fa.nivel);

    if (requiereDetalle && (!fa.grado_obtenido || !fa.institucion)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Para Educación Superior o Posgrado se requiere grado_obtenido e institucion'
      });
    }

    if (['Educación Superior', 'Posgrado'].includes(fa.nivel)) {
      if (fa.titulado === null || fa.titulado === undefined) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Debes indicar si está titulado'
        });
      }
    }

    await client.query(
      `
      INSERT INTO formacion_academica
        (id_persona, nivel, grado_obtenido, institucion, anio_inicio, anio_fin, grado,titulado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `,
      [
        id_persona,
        fa.nivel,
        requiereDetalle ? (fa.grado_obtenido || null) : null,
        requiereDetalle ? (fa.institucion || null) : null,
        fa.anio_inicio || null,
        fa.anio_fin || null,
        fa.grado || null,
        fa.titulado ?? null
      ]
      
    );
  }

    // 2) DATOS INE (1 por persona) - tu tabla tiene UNIQUE(id_persona)
    if (datos_ine && (datos_ine.seccion_electoral || datos_ine.distrito_federal || datos_ine.distrito_local)) {
      await client.query(
        `
        INSERT INTO datos_ine (id_persona, seccion_electoral, distrito_federal, distrito_local)
        VALUES ($1,$2,$3,$4)
        `,
        [
          id_persona,
          datos_ine.seccion_electoral || null,
          datos_ine.distrito_federal || null,
          datos_ine.distrito_local || null
        ]
      );
    }

    // TELEFONOS
    for (const t of telefonos) {
      await client.query(
        `
        INSERT INTO telefonos (id_persona, telefono, tipo, principal)
        VALUES ($1,$2,$3,$4)
        `,
        [id_persona, t.telefono, t.tipo || null, t.principal ?? false]
      );
    }


    // 4) PAREJAS con MAP temp_id -> id_pareja
    const parejaMap = new Map();

    for (const p of parejas) {
      const periodo = normalizePeriodo(p?.periodo);

      const tieneAlgo = p?.nombre_pareja || p?.tipo_relacion || periodo;
      if (!tieneAlgo) continue;

      // Validación: si mandan periodo, debe ser AAAA o AAAA-AAAA
      if (periodo && !isPeriodoValido(periodo)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Formato de periodo inválido en parejas. Usa AAAA o AAAA-AAAA',
          detail: { temp_id: p?.temp_id || null, periodo }
        });
      }

      const { rows } = await client.query(
        `
        INSERT INTO parejas (id_persona, nombre_pareja, tipo_relacion, periodo)
        VALUES ($1,$2,$3,$4)
        RETURNING id_pareja
        `,
        [
          id_persona,
          p.nombre_pareja || null,
          p.tipo_relacion || null,
          periodo || null
        ]
      );

      if (p.temp_id) parejaMap.set(p.temp_id, rows[0].id_pareja);
    }
// 5) HIJOS ligados a pareja
    for (const h of hijos) {
      const tieneAlgo = h?.anio_nacimiento || h?.sexo || h?.pareja_temp_id;
      if (!tieneAlgo) continue;

      const id_pareja = h.pareja_temp_id ? (parejaMap.get(h.pareja_temp_id) || null) : null;

      await client.query(
        `
        INSERT INTO hijos (id_persona, id_pareja, anio_nacimiento, sexo)
        VALUES ($1,$2,$3,$4)
        `,
        [id_persona, id_pareja, h.anio_nacimiento || null, h.sexo || null]
      );
    }

    // REDES (requiere id_red)
    for (const r of redes) {
      await client.query(
        `
        INSERT INTO redes_sociales_persona (id_persona, id_red, url)
        VALUES ($1,$2,$3)
        `,
        [id_persona, r.id_red, r.url]
      );
    }

    // SERVICIO PUBLICO
    for (const s of servicio_publico) {
      await client.query(
        `
        INSERT INTO servicio_publico (id_persona, periodo, cargo, dependencia)
        VALUES ($1,$2,$3,$4)
        `,
        [id_persona, s.periodo || null, s.cargo || null, s.dependencia || null]
      );
    }

    // ELECCIONES
    for (const e of elecciones) {
      await client.query(
        `
        INSERT INTO elecciones_contendidas
        (id_persona, anio_eleccion, candidatura, partido_postulacion, resultado, diferencia_votos, diferencia_porcentaje)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        `,
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

    // ✅ EVENTOS DE MOVILIZACIÓN (lista)
    for (const ev of capacidad_movilizacion_eventos) {
      const nombre = (ev?.nombre_evento || '').toString().trim();
      const fecha = ev?.fecha_evento || null;

      // asistencia puede venir como string desde el front
      const asistencia =
        ev?.asistencia === '' || ev?.asistencia == null
          ? null
          : Number(ev.asistencia);

      // ignora líneas totalmente vacías
      if (!nombre && !fecha && (asistencia == null)) continue;

      // validación: si hay evento, debe traer todo
      if (!nombre || !fecha || asistencia == null || Number.isNaN(asistencia)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Cada evento requiere nombre_evento, fecha_evento y asistencia'
        });
      }

      if (asistencia < 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'La asistencia no puede ser negativa'
        });
      }

      await client.query(
        `
        INSERT INTO capacidad_movilizacion_eventos
          (id_persona, nombre_evento, fecha_evento, asistencia)
        VALUES ($1,$2,$3,$4)
        `,
        [id_persona, nombre, fecha, asistencia]
      );
    }

    // EQUIPOS
    for (const eq of equipos) {
      await client.query(
        `
        INSERT INTO equipos_politicos (id_persona, nombre_equipo, activo)
        VALUES ($1,$2,$3)
        `,
        [id_persona, eq.nombre_equipo || null, eq.activo ?? true]
      );
    }

    // REFERENTES
    for (const ref of referentes) {
      await client.query(
        `
        INSERT INTO referentes_politicos
          (id_persona, nivel, nombres, apellido_paterno, apellido_materno)
        VALUES ($1,$2,$3,$4,$5)
        `,
        [
          id_persona,
          ref.nivel || null,
          ref.nombres || null,
          ref.apellido_paterno || null,
          ref.apellido_materno || null
        ]
      );
    }
    // Si se marcó "sin controversias públicas", NO se insertan controversias
    const sinControversias = persona.sin_controversias_publicas === true;
    // CONTROVERSIAS (requiere id_tipo)
    // CONTROVERSIAS (solo si NO marcó "sin controversias públicas")
    if (!sinControversias) {
      for (const c of controversias) {
        await client.query(
          `
          INSERT INTO controversias_persona
          (id_persona, id_tipo, descripcion, fuente, fecha_registro, estatus)
          VALUES ($1,$2,$3,$4,$5,$6)
          `,
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

    // FAMILIARES
    for (const f of familiares) {
      await client.query(
        `
        INSERT INTO familiares_politica (id_persona, nombre, parentesco, cargo, institucion)
        VALUES ($1,$2,$3,$4,$5)
        `,
        [id_persona, f.nombre || null, f.parentesco || null, f.cargo || null, f.institucion || null]
      );
    }
    // PARTICIPACIÓN EN OTROS PARTIDOS / ORGANIZACIONES
    for (const po of participacion_organizaciones) {
      const tieneAlgo = po?.tipo || po?.nombre || po?.rol || po?.periodo || po?.notas;
      if (!tieneAlgo) continue;

      if (!po.nombre) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'participacion_organizaciones.nombre es obligatorio' });
      }

      await client.query(
        `
        INSERT INTO participacion_organizaciones
          (id_persona, tipo, nombre, rol, periodo, notas)
        VALUES ($1,$2,$3,$4,$5,$6)
        `,
        [
          id_persona,
          po.tipo || 'otro',
          po.nombre,
          po.rol || null,
          po.periodo || null,
          po.notas || null
        ]
      );
    }
    //Eleccion popular
    for (const c of cargos_eleccion_popular) {
      const tieneAlgo = c?.periodo || c?.cargo || c?.partido_postulante || c?.modalidad;
      if (!tieneAlgo) continue;

      // Validación mínima: si hay registro, exige cargo y periodo
      if (!c.cargo || !c.periodo) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Cada cargo de elección popular requiere periodo y cargo'
        });
      }

      // modalidad opcional pero si viene, debe ser mr/rp
      if (c.modalidad && !['mr','rp'].includes(c.modalidad)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'modalidad inválida (mr|rp)' });
      }

      await client.query(
        `
        INSERT INTO cargos_eleccion_popular
          (id_persona, periodo, cargo, partido_postulante, modalidad)
        VALUES ($1,$2,$3,$4,$5)
        `,
        [
          id_persona,
          c.periodo || null,
          c.cargo || null,
          c.partido_postulante || null,
          c.modalidad || null
        ]
      );
    }
    // EXPERIENCIA LABORAL (fuera del servicio público)
    for (const ex of experiencia_laboral) {
      const tieneAlgo = ex?.periodo || ex?.cargo || ex?.organizacion;
      if (!tieneAlgo) continue;

      await client.query(
        `
        INSERT INTO experiencia_laboral (id_persona, periodo, cargo, organizacion)
        VALUES ($1,$2,$3,$4)
        `,
        [
          id_persona,
          ex.periodo || null,
          ex.cargo || null,
          ex.organizacion || null
        ]
      );
    }
      await client.query('COMMIT');
      return res.status(201).json({ ok: true, id_persona });

    } catch (e) {
      await client.query('ROLLBACK');
      console.error(e);

      // si algún día insertas ine dos veces para la misma persona, caerá aquí por UNIQUE
      if (String(e.message).includes('datos_ine_id_persona_key')) {
        return res.status(409).json({ error: 'Esta persona ya tiene datos INE' });
      }
      if (String(e.message).includes('personas_curp_key')) return res.status(409).json({ error: 'CURP ya existe' });
      if (String(e.message).includes('personas_rfc_key')) return res.status(409).json({ error: 'RFC ya existe' });


      return res.status(500).json({ error: 'Error al crear persona', detail: e.message });
    } finally {
      client.release();
    }
};


// 3) PERFIL COMPLETO (usa tu query consolidado)
exports.getPerfilCompleto = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "ID inválido" });
    }

    const { rows } = await pool.query(
      `
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
        p.created_at,
        p.creado_por,

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

        -- =========================
        -- 1) DATOS INE (objeto 1:1)
        -- =========================
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
          LIMIT 1
        ) AS datos_ine,

        -- =========================
        -- 2) TELEFONOS
        -- =========================
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

        -- =========================
        -- 3) FORMACION ACADEMICA
        -- =========================
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_formacion',   fa.id_formacion,
              'nivel',          fa.nivel,
              'grado',          fa.grado,
              'grado_obtenido', fa.grado_obtenido,
              'institucion',    fa.institucion,
              'anio_inicio',    fa.anio_inicio,
              'anio_fin',       fa.anio_fin
            )
            ORDER BY fa.id_formacion ASC
          )
          FROM formacion_academica fa
          WHERE fa.id_persona = p.id_persona
        ), '[]'::jsonb) AS formacion_academica,

        -- =========================
        -- 4) REDES (con catálogo)
        -- =========================
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

        -- =========================
        -- 5) PAREJAS con HIJOS anidados
        -- =========================
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_pareja',      pa.id_pareja,
              'nombre_pareja',  pa.nombre_pareja,
              'tipo_relacion',  pa.tipo_relacion,
              'periodo',   pa.periodo,
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

        -- (Opcional) Si tu frontend todavía consume hijos "plano", lo dejamos también:
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_hijo',         h.id_hijo,
              'id_pareja',       h.id_pareja,
              'anio_nacimiento', h.anio_nacimiento,
              'sexo',            h.sexo
            )
            ORDER BY h.id_hijo ASC
          )
          FROM hijos h
          WHERE h.id_persona = p.id_persona
        ), '[]'::jsonb) AS hijos,

        -- =========================
        -- 6) SERVICIO PUBLICO
        -- =========================
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

        -- =========================
        -- 7) ELECCIONES
        -- =========================
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

        -- =========================
        -- 8) CAPACIDAD MOVILIZACION (1:1)
        -- =========================
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

        -- =========================
        -- 9) EQUIPOS
        -- =========================
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

        -- =========================
        -- 10) REFERENTES
        -- =========================
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

        -- =========================
        -- 11) FAMILIARES
        -- =========================
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_familiar',  fp.id_familiar,
              'nombre',       fp.nombre,
              'parentesco',   fp.parentesco,
              'cargo',        fp.cargo,
              'institucion',  fp.institucion
            )
            ORDER BY fp.id_familiar ASC
          )
          FROM familiares_politica fp
          WHERE fp.id_persona = p.id_persona
        ), '[]'::jsonb) AS familiares,

        -- =========================
        -- 12) PARTICIPACION ORGANIZACIONES
        -- =========================
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

        -- =========================
        -- 13) CONTROVERSIAS (condicional)
        -- =========================
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

      LEFT JOIN catalogo_partidos cp            ON cp.id_partido = p.id_partido_actual
      LEFT JOIN catalogo_temas_interes cti      ON cti.id_tema    = p.id_tema_interes_central
      LEFT JOIN catalogo_grupos_postulacion cgp ON cgp.id_grupo   = p.id_grupo_postulacion
      LEFT JOIN catalogo_ideologia_politica cip ON cip.id_ideologia = p.id_ideologia_politica

      WHERE p.id_persona = $1
      LIMIT 1
      `,
      [id]
    );
//edicion
  if (!rows[0]) return res.status(404).json({ error: "Persona no encontrada" });

  const roles = req.user.roles || [];
  if (roles.includes('capturista') && rows[0].creado_por !== req.user.id_usuario) {
    return res.status(403).json({ error: 'No autorizado' });
  }

  return res.json(rows[0]);
 //edicion    
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Error al obtener perfil", detail: e.message });
  }
};

// 4. Usuarios para filtro

exports.listUsuariosParaFiltro = async (req, res) => {
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
        MIN(r.nombre) AS rol_principal
      FROM usuarios u
      LEFT JOIN usuarios_roles ur ON ur.id_usuario = u.id_usuario
      LEFT JOIN roles r ON r.id_rol = ur.id_rol
      WHERE u.activo = true
      GROUP BY u.id_usuario, u.nombre, u.email
      ORDER BY u.nombre ASC
    `);

    return res.json(rows);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Error al listar usuarios', detail: e.message });
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
const PDFDocument = require("pdfkit");

exports.getPerfilPdf = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

    // ✅ TU QUERY COMPLETO (igual que getPerfilCompleto)
    const { rows } = await pool.query(
      `
        SELECT
        p.id_persona,
        p.nombre,
        p.curp,
        p.rfc,
        p.clave_elector,
        p.estado_civil,
        p.escala_influencia,
        p.sin_servicio_publico,
        p.ha_contendido_eleccion,
        p.created_at,
        p.creado_por,

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

        -- =========================
        -- 1) DATOS INE (objeto 1:1)
        -- =========================
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
          LIMIT 1
        ) AS datos_ine,

        -- =========================
        -- 2) TELEFONOS
        -- =========================
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

        -- =========================
        -- 3) FORMACION ACADEMICA
        -- =========================
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_formacion',   fa.id_formacion,
              'nivel',          fa.nivel,
              'grado',          fa.grado,
              'grado_obtenido', fa.grado_obtenido,
              'institucion',    fa.institucion,
              'anio_inicio',    fa.anio_inicio,
              'anio_fin',       fa.anio_fin
            )
            ORDER BY fa.id_formacion ASC
          )
          FROM formacion_academica fa
          WHERE fa.id_persona = p.id_persona
        ), '[]'::jsonb) AS formacion_academica,

        -- =========================
        -- 4) REDES (con catálogo)
        -- =========================
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

        -- =========================
        -- 5) PAREJAS con HIJOS anidados
        -- =========================
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_pareja',      pa.id_pareja,
              'nombre_pareja',  pa.nombre_pareja,
              'tipo_relacion',  pa.tipo_relacion,
              'fecha_inicio',   pa.fecha_inicio,
              'fecha_fin',      pa.fecha_fin,
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

        -- (Opcional) Si tu frontend todavía consume hijos "plano", lo dejamos también:
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_hijo',         h.id_hijo,
              'id_pareja',       h.id_pareja,
              'anio_nacimiento', h.anio_nacimiento,
              'sexo',            h.sexo
            )
            ORDER BY h.id_hijo ASC
          )
          FROM hijos h
          WHERE h.id_persona = p.id_persona
        ), '[]'::jsonb) AS hijos,

        -- =========================
        -- 6) SERVICIO PUBLICO
        -- =========================
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

        -- =========================
        -- 7) ELECCIONES
        -- =========================
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

        -- =========================
        -- 8) CAPACIDAD MOVILIZACION (1:1)
        -- =========================
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

        -- =========================
        -- 9) EQUIPOS
        -- =========================
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

        -- =========================
        -- 10) REFERENTES
        -- =========================
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

        -- =========================
        -- 11) FAMILIARES
        -- =========================
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_familiar',  fp.id_familiar,
              'nombre',       fp.nombre,
              'parentesco',   fp.parentesco,
              'cargo',        fp.cargo,
              'institucion',  fp.institucion
            )
            ORDER BY fp.id_familiar ASC
          )
          FROM familiares_politica fp
          WHERE fp.id_persona = p.id_persona
        ), '[]'::jsonb) AS familiares,

        -- =========================
        -- 12) PARTICIPACION ORGANIZACIONES
        -- =========================
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

        -- =========================
        -- 13) CONTROVERSIAS (condicional)
        -- =========================
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

      LEFT JOIN catalogo_partidos cp            ON cp.id_partido = p.id_partido_actual
      LEFT JOIN catalogo_temas_interes cti      ON cti.id_tema    = p.id_tema_interes_central
      LEFT JOIN catalogo_grupos_postulacion cgp ON cgp.id_grupo   = p.id_grupo_postulacion
      LEFT JOIN catalogo_ideologia_politica cip ON cip.id_ideologia = p.id_ideologia_politica

      WHERE p.id_persona = $1
      LIMIT 1`
      , [id]);
    const p = rows[0];
    if (!p) return res.status(404).json({ error: "Persona no encontrada" });

    // ✅ Seguridad: capturista solo su registro
    const roles = req.user.roles || [];
    if (roles.includes("capturista") && p.creado_por !== req.user.id_usuario) {
      return res.status(403).json({ error: "No autorizado" });
    }

    // ====== Headers respuesta
    const safeName = String(p.nombre || `persona_${p.id_persona}`)
      .replace(/[\\/:*?"<>|]/g, "")
      .slice(0, 60);

    res.setHeader("Content-Type", "application/pdf");
    // inline (abre en navegador) o attachment (descarga)
    res.setHeader("Content-Disposition", `inline; filename="perfil_${safeName}.pdf"`);

    const doc = new PDFDocument({ size: "A4", margin: 36, bufferPages: true });
    doc.pipe(res);

    // ====== Colores institucionales
    const C = {
      prim: "#8b2136",     // vino
      sec:  "#b89056",     // dorado
      text: "#111827",     // gris oscuro
      muted:"#6b7280",
      line: "#e5e7eb",
      bg:   "#ffffff"
    };

    const M = doc.page.margins;
    const pageW = () => doc.page.width;
    const pageH = () => doc.page.height;
    const contentW = () => pageW() - M.left - M.right;
    const bottomY = () => pageH() - M.bottom;

    const GAP = 14; // gap entre columnas
    const COL_W = () => (contentW() - GAP) / 2;

    // ====== Helpers paginación
    function ensure(h = 24) {
      if (doc.y + h > bottomY()) {
        doc.addPage();
        header(); // re-dibuja header en cada página
      }
    }

    // ====== Header institucional (se repite en cada página)
function header() {
  const x = M.left;
  const y = M.top;   // ✅ sin negativos
  const w = contentW();

  doc.save();
  doc.rect(x, y, w, 36).fill(C.prim);
  doc.rect(x, y + 33, w, 3).fill(C.sec);

  doc.fillColor("white").font("Helvetica-Bold").fontSize(14)
    .text("Actores Políticos", x + 10, y + 10, { width: w - 20, align: "left" });

  doc.fillColor("white").font("Helvetica").fontSize(9)
    .text("Perfil individual", x + 10, y + 24, { width: w - 20, align: "left" });

  doc.restore();

  // cursor fijo debajo del header
  doc.y = y + 48;
}

    // ====== Badge de sección
    function section(title) {
      ensure(26);
      const x = M.left;
      const y = doc.y;
      const w = contentW();

      doc.save();
      doc.roundedRect(x, y, w, 22, 8).fill(C.prim);
      doc.fillColor("white").font("Helvetica-Bold").fontSize(10)
        .text(title.toUpperCase(), x + 10, y + 6, { width: w - 20, align: "left" });
      doc.restore();
      doc.y = y + 28;
    }

    // ====== Row de 2 columnas (campo + valor con línea)
    function field2(labelL, valueL, labelR, valueR) {
      ensure(44);
      const x0 = M.left;
      const y0 = doc.y;

      const renderField = (x, label, value) => {
        doc.save();
        doc.fillColor(C.muted).font("Helvetica-Bold").fontSize(8).text(String(label || "").toUpperCase(), x, y0);
        doc.fillColor(C.text).font("Helvetica").fontSize(10).text(String(value ?? "-"), x, y0 + 11, { width: COL_W() });
        doc.strokeColor(C.line).lineWidth(1).moveTo(x, y0 + 32).lineTo(x + COL_W(), y0 + 32).stroke();
        doc.restore();
      };

      renderField(x0, labelL, valueL);
      renderField(x0 + COL_W() + GAP, labelR, valueR);

      doc.y = y0 + 40;
    }

    // ====== Campo a 1 columna (para textos largos)
    function field1(label, value) {
      ensure(44);
      const x = M.left;
      const y = doc.y;

      doc.fillColor(C.muted).font("Helvetica-Bold").fontSize(8).text(String(label || "").toUpperCase(), x, y);
      doc.fillColor(C.text).font("Helvetica").fontSize(10)
        .text(String(value ?? "-"), x, y + 11, { width: contentW() });

      doc.strokeColor(C.line).lineWidth(1).moveTo(x, doc.y + 2).lineTo(x + contentW(), doc.y + 2).stroke();
      doc.moveDown(0.8);
    }

    // ====== Chips/badges (partido, ideología, etc.)
    function chips(items) {
      if (!items.length) return;
      ensure(18);
      let x = M.left;
      let y = doc.y;
      const h = 16;
      const padX = 8;
      const gap = 6;

      items.forEach(it => {
        const t = String(it.text || "");
        if (!t) return;
        doc.font("Helvetica-Bold").fontSize(8);
        const w = doc.widthOfString(t) + padX * 2;

        if (x + w > M.left + contentW()) {
          x = M.left;
          y += h + 6;
          ensure(h + 12);
        }

        doc.roundedRect(x, y, w, h, 8).fill(it.color || C.sec);
        doc.fillColor("white").text(t, x + padX, y + 4);
        doc.fillColor(C.text);

        x += w + gap;
      });

      doc.y = y + h + 10;
    }

    // ====== Tabla simple (auto page-break por renglón)
    function table(title, headers, rowsData) {
       if (!Array.isArray(rowsData) || rowsData.length === 0) {
          section(title);
          field1("Registro", "-");
          return;
        }

        section(title);

      const x = M.left;
      const w = contentW();
      const colCount = headers.length;
      const colW = w / colCount;
      const rowH = 18;

      // header row
      ensure(rowH + 10);
      doc.save();
      doc.rect(x, doc.y, w, rowH).fill(C.sec);
      doc.fillColor("white").font("Helvetica-Bold").fontSize(9);
      headers.forEach((h, i) => {
        doc.text(h, x + i * colW + 6, doc.y + 5, { width: colW - 12, ellipsis: true });
      });
      doc.restore();
      doc.y += rowH;

      // body rows
      doc.font("Helvetica").fontSize(9).fillColor(C.text);
      rowsData.forEach((r, idx) => {
        ensure(rowH + 10);

        // zebra
        if (idx % 2 === 0) {
          doc.save();
          doc.rect(x, doc.y, w, rowH).fill("#f9fafb");
          doc.restore();
        }

        r.forEach((cell, i) => {
          doc.fillColor(C.text).text(String(cell ?? "-"), x + i * colW + 6, doc.y + 5, {
            width: colW - 12,
            ellipsis: true
          });
        });

        // line
        doc.strokeColor(C.line).lineWidth(1).moveTo(x, doc.y + rowH).lineTo(x + w, doc.y + rowH).stroke();
        doc.y += rowH;
      });

      doc.moveDown(0.6);
    }

    // ============ Render PDF ============
    header();

    // Chips “arriba”
    chips([
      p.grupo_postulacion ? { text: p.grupo_postulacion, color: "#0ea5e9" } : null,
      (p.partido_actual_siglas || p.partido_actual) ? { text: (p.partido_actual_siglas || p.partido_actual), color: C.prim } : null,
      p.ideologia_politica ? { text: p.ideologia_politica, color: "#374151" } : null,
      p.tema_interes_central ? { text: p.tema_interes_central, color: "#f59e0b" } : null,
      p.sin_controversias_publicas === true ? { text: "Sin controversias", color: "#16a34a" } : null
    ].filter(Boolean));

    // Datos generales (2 columnas)
    section("Datos generales");
    field2("Nombre", p.nombre, "CURP", p.curp);
    field2("RFC", p.rfc, "Clave elector", p.clave_elector);
    field2("Estado civil", p.estado_civil, "Escala influencia", p.escala_influencia);
    field2("Mun. residencia legal", p.municipio_residencia_legal, "Mun. residencia real", p.municipio_residencia_real);
    field1("Municipio trabajo político", p.municipio_trabajo_politico);

    // Datos INE
    section("Datos INE");
    if (p.datos_ine) {
      field2("Sección electoral", p.datos_ine.seccion_electoral, "Distrito federal", p.datos_ine.distrito_federal);
      field2("Distrito local", p.datos_ine.distrito_local, "—", "—");
    } else {
      field1("Registro", "-");
    }

    // Teléfonos
    section("Teléfonos");
    if (Array.isArray(p.telefonos) && p.telefonos.length) {
      p.telefonos.forEach(t => {
        ensure(18);
        doc.fillColor(C.text).font("Helvetica").fontSize(10)
          .text(`• ${t.telefono || "-"} (${t.tipo || "s/tipo"})${t.principal ? " [principal]" : ""}`);
      });
      doc.moveDown(0.6);
    } else {
      field1("Registro", "-");
    }

    // Redes
    section("Redes sociales");
    if (Array.isArray(p.redes_sociales) && p.redes_sociales.length) {
      p.redes_sociales.forEach(r => {
        ensure(18);
        doc.fillColor(C.text).font("Helvetica").fontSize(10)
          .text(`• ${r.red || "-"}: ${r.url || "-"}`);
      });
      doc.moveDown(0.6);
    } else {
      field1("Registro", "-");
    }

    // Formación
    section("Formación académica");
    if (Array.isArray(p.formacion_academica) && p.formacion_academica.length) {
      p.formacion_academica.forEach(fa => {
        ensure(22);
        const periodo = [fa.anio_inicio, fa.anio_fin].filter(Boolean).join(" - ");
        doc.fillColor(C.text).font("Helvetica").fontSize(10)
          .text(`• ${fa.nivel || "-"} | ${fa.grado || "-"} | ${fa.institucion || "-"}${periodo ? ` (${periodo})` : ""}${fa.grado_obtenido ? " [obtenido]" : ""}`);
      });
      doc.moveDown(0.6);
    } else {
      field1("Registro", "-");
    }

    // Tablas: Servicio público y Elecciones
    const spRows = (p.sin_servicio_publico === true) ? [] : (p.servicio_publico || []).map(sp => [
      sp.periodo || "-",
      sp.cargo || "-",
      sp.dependencia || "-"
    ]);

    table("Servicio público", ["Periodo", "Cargo", "Dependencia"], spRows);
    if (p.sin_servicio_publico === true) {
      field1("Registro", "Marcado como: Sin servicio público");
    }

    const elRows = (p.ha_contendido_eleccion === false) ? [] : (p.elecciones || []).map(ec => [
      ec.anio_eleccion || "-",
      ec.candidatura || "-",
      ec.partido_postulacion || "-",
      ec.resultado || "-"
    ]);

    table("Elecciones contendidas", ["Año", "Candidatura", "Partido", "Resultado"], elRows);
    if (p.ha_contendido_eleccion === false) {
      field1("Registro", "Marcado como: No ha contendiendo elección");
    }

    // Movilización (2 columnas)
    section("Capacidad de movilización");
    if (p.capacidad_movilizacion) {
      field2("Eventos últimos 3 años", p.capacidad_movilizacion.eventos_ultimos_3_anios,
             "Asistencia promedio", p.capacidad_movilizacion.asistencia_promedio);
    } else {
      field1("Registro", "-");
    }

    // Equipos / Referentes (2 columnas como listas cortas)
    section("Equipos y referentes");
    const equiposTxt = (p.equipos || []).map(e => `${e.nombre_equipo}${e.activo ? " [activo]" : ""}`).join("\n") || "-";
    const refTxt = (p.referentes || []).map(r => `${r.nivel || "-"} — ${r.nombre_referente || "-"}`).join("\n") || "-";
    ensure(70);
    const xL = M.left, xR = M.left + COL_W() + GAP;
    const y = doc.y;
    doc.fillColor(C.muted).font("Helvetica-Bold").fontSize(8).text("EQUIPOS", xL, y);
    doc.fillColor(C.text).font("Helvetica").fontSize(10).text(equiposTxt, xL, y + 12, { width: COL_W() });

    doc.fillColor(C.muted).font("Helvetica-Bold").fontSize(8).text("REFERENTES", xR, y);
    doc.fillColor(C.text).font("Helvetica").fontSize(10).text(refTxt, xR, y + 12, { width: COL_W() });
    doc.y = Math.max(doc.y, y + 60);
    doc.moveDown(0.4);

    // Familiares
    section("Familiares");
    if (Array.isArray(p.familiares) && p.familiares.length) {
      p.familiares.forEach(f => {
        ensure(18);
        doc.font("Helvetica").fontSize(10).fillColor(C.text)
          .text(`• ${f.nombre || "-"} (${f.parentesco || "-"}) — ${f.cargo || "-"} | ${f.institucion || "-"}`);
      });
      doc.moveDown(0.6);
    } else {
      field1("Registro", "-");
    }

    // Participación organizaciones
    section("Participación en organizaciones");
    if (Array.isArray(p.participacion_organizaciones) && p.participacion_organizaciones.length) {
      p.participacion_organizaciones.forEach(o => {
        ensure(22);
        doc.font("Helvetica").fontSize(10).fillColor(C.text)
          .text(`• ${o.tipo || "-"} — ${o.nombre || "-"} | Rol: ${o.rol || "-"} | Periodo: ${o.periodo || "-"}${o.notas ? ` | Notas: ${o.notas}` : ""}`);
      });
      doc.moveDown(0.6);
    } else {
      field1("Registro", "-");
    }

    // Parejas e hijos
    section("Parejas e hijos");
    if (Array.isArray(p.parejas) && p.parejas.length) {
      p.parejas.forEach(pa => {
        ensure(30);
        doc.font("Helvetica-Bold").fontSize(10).fillColor(C.text)
          .text(`• ${pa.nombre_pareja || "-"} (${pa.tipo_relacion || "-"})`);
        doc.font("Helvetica").fontSize(9).fillColor(C.muted)
          .text(`${pa.fecha_inicio || ""}${pa.fecha_fin ? " a " + pa.fecha_fin : ""}`);

        if (Array.isArray(pa.hijos) && pa.hijos.length) {
          pa.hijos.forEach(h => {
            ensure(16);
            doc.font("Helvetica").fontSize(10).fillColor(C.text)
              .text(`   - Hijo: ${h.anio_nacimiento || "-"} | Sexo: ${h.sexo || "-"}`);
          });
        } else {
          ensure(16);
          doc.font("Helvetica").fontSize(10).fillColor(C.text).text(`   - Hijos: -`);
        }
        doc.moveDown(0.3);
      });
      doc.moveDown(0.4);
    } else {
      field1("Registro", "-");
    }

    // Controversias
    section("Controversias");
    if (p.sin_controversias_publicas === true) {
      field1("Registro", "Marcado como: Sin controversias públicas");
    } else if (Array.isArray(p.controversias) && p.controversias.length) {
      p.controversias.forEach(c => {
        ensure(28);
        doc.font("Helvetica-Bold").fontSize(10).fillColor(C.text)
          .text(`• ${c.tipo || "-"}`);
        doc.font("Helvetica").fontSize(10).fillColor(C.text)
          .text(`${c.descripcion || "-"}`);
        if (c.fuente) doc.font("Helvetica").fontSize(9).fillColor(C.muted).text(`Fuente: ${c.fuente}`);
        doc.moveDown(0.3);
      });
      doc.moveDown(0.4);
    } else {
      field1("Registro", "-");
    }

    // ===== Footer con numeración de páginas
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      const pageNum = i + 1;
      const total = range.count;

      doc.fillColor(C.muted).font("Helvetica").fontSize(9)
        .text(`Página ${pageNum} de ${total}`, M.left, pageH() - M.bottom + 10, { width: contentW(), align: "right" });
    }

    doc.end();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Error al generar PDF", detail: e.message });
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

    // 5) Exacto por sección electoral (en datos_ine)
    if (seccion_electoral) {
      const params = [seccion_electoral];
      let extra = "";

      if (excludeOk) {
        params.push(excludeId);
        extra = ` AND p.id_persona <> $2 `;
      }

      const q = await pool.query(
        `
        SELECT p.id_persona, p.nombre, p.apellido_paterno, p.apellido_materno, p.id_oficina
        FROM datos_ine d
        JOIN personas p ON p.id_persona = d.id_persona
        WHERE d.seccion_electoral = $1
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
    } = req.body;

    if (!persona?.nombre) {
      return res.status(400).json({ error: "persona.nombre es obligatorio" });
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
        modificado_por = $23
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
         req.user.id_usuario                         // $23 ✅ modificado_por
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

      await client.query(
        `INSERT INTO formacion_academica
          (id_persona, nivel, grado_obtenido, institucion, anio_inicio, anio_fin, grado, titulado)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id_persona,
          fa.nivel,
          requiereDetalle ? (fa.grado_obtenido || null) : null,
          requiereDetalle ? (fa.institucion || null) : null,
          fa.anio_inicio || null,
          fa.anio_fin || null,
          fa.grado || null,
          fa.titulado ?? null,
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
    await del("capacidad_movilizacion_eventos");
    for (const ev of capacidad_movilizacion_eventos) {
      const nombre = (ev?.nombre_evento || "").toString().trim();
      const fecha = ev?.fecha_evento || null;
      const asistencia =
        ev?.asistencia === "" || ev?.asistencia == null ? null : Number(ev.asistencia);

      if (!nombre && !fecha && asistencia == null) continue;

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

      await client.query(
        `INSERT INTO capacidad_movilizacion_eventos (id_persona, nombre_evento, fecha_evento, asistencia)
         VALUES ($1,$2,$3,$4)`,
        [id_persona, nombre, fecha, asistencia]
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
  if (!id_persona) return res.status(400).json({ error: "id inválido" });

  const client = await pool.connect();
  try {
    // 1️⃣ PERSONA (primero SIEMPRE)
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
        updated_at
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

      // capacidad_movilizacion_eventos (PK: id_evento)
      client.query(
        `SELECT nombre_evento, fecha_evento, asistencia
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
        `SELECT nivel, grado_obtenido, institucion, anio_inicio, anio_fin, grado, titulado
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
    ]);

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
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Error al obtener payload", detail: e.message });
  } finally {
    client.release();
  }
};


/*
exports.getPayloadEdicion = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

    // ===== permisos por rol/oficina/creador =====
    const sc = await pool.query(
      `SELECT id_persona, id_oficina, creado_por
       FROM personas
       WHERE id_persona = $1`,
      [id]
    );
    if (!sc.rows[0]) return res.status(404).json({ error: "Persona no encontrada" });

    const roles = req.user.roles || [];
    const isSuperadmin = roles.includes("superadmin");
    const isAnalista = roles.includes("analista");
    const isCapturista = roles.includes("capturista");

    if (!isSuperadmin) {
      if (!req.user.id_oficina) return res.status(403).json({ error: "Usuario sin oficina asignada" });
      if (sc.rows[0].id_oficina !== req.user.id_oficina) return res.status(403).json({ error: "No autorizado (oficina)" });

      if (isCapturista && !isAnalista && sc.rows[0].creado_por !== req.user.id_usuario) {
        return res.status(403).json({ error: "No autorizado (capturista)" });
      }
    }

    // ===== query en formato edición (IDs + arrays) =====
    const { rows } = await pool.query(
      `
      SELECT
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
        p.municipio_residencia_legal,
        p.municipio_residencia_real,
        p.municipio_trabajo_politico,
        p.sin_controversias_publicas,
        p.id_partido_actual,
        p.partido_otro_texto,
        p.id_grupo_postulacion,
        p.id_ideologia_politica,
        p.sin_cargos_eleccion_popular,
        p.foto_url,

        (SELECT CASE WHEN di.id_persona IS NULL THEN NULL ELSE jsonb_build_object(
          'seccion_electoral', di.seccion_electoral,
          'distrito_federal', di.distrito_federal,
          'distrito_local', di.distrito_local
        ) END
        FROM datos_ine di WHERE di.id_persona = $1 LIMIT 1) AS datos_ine,

        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'telefono', t.telefono, 'tipo', t.tipo, 'principal', t.principal
        ) ORDER BY t.principal DESC, t.id_telefono ASC)
        FROM telefonos t WHERE t.id_persona = $1), '[]'::jsonb) AS telefonos,

        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'nivel', fa.nivel,
          'grado', fa.grado,
          'grado_obtenido', fa.grado_obtenido,
          'institucion', fa.institucion,
          'anio_inicio', fa.anio_inicio,
          'anio_fin', fa.anio_fin,
          'titulado', fa.titulado
        ) ORDER BY fa.id_formacion ASC)
        FROM formacion_academica fa WHERE fa.id_persona = $1), '[]'::jsonb) AS formacion_academica,

        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id_red', rsp.id_red,
          'url', rsp.url
        ) ORDER BY rsp.id_red ASC)
        FROM redes_sociales_persona rsp WHERE rsp.id_persona = $1), '[]'::jsonb) AS redes,

        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id_pareja', pa.id_pareja,
          'nombre_pareja', pa.nombre_pareja,
          'tipo_relacion', pa.tipo_relacion,
          'periodo', pa.periodo
        ) ORDER BY pa.id_pareja ASC)
        FROM parejas pa WHERE pa.id_persona = $1), '[]'::jsonb) AS parejas,

        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id_hijo', h.id_hijo,
          'id_pareja', h.id_pareja,
          'anio_nacimiento', h.anio_nacimiento,
          'sexo', h.sexo
        ) ORDER BY h.id_hijo ASC)
        FROM hijos h WHERE h.id_persona = $1), '[]'::jsonb) AS hijos,

        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'periodo', sp.periodo,
          'cargo', sp.cargo,
          'dependencia', sp.dependencia
        ) ORDER BY sp.id_servicio ASC)
        FROM servicio_publico sp WHERE sp.id_persona = $1), '[]'::jsonb) AS servicio_publico,

        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'anio_eleccion', ec.anio_eleccion,
          'candidatura', ec.candidatura,
          'partido_postulacion', ec.partido_postulacion,
          'resultado', ec.resultado,
          'diferencia_votos', ec.diferencia_votos,
          'diferencia_porcentaje', ec.diferencia_porcentaje
        ) ORDER BY ec.id_eleccion ASC)
        FROM elecciones_contendidas ec WHERE ec.id_persona = $1), '[]'::jsonb) AS elecciones,

        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'nombre_evento', ev.nombre_evento,
          'fecha_evento', ev.fecha_evento,
          'asistencia', ev.asistencia
        ) ORDER BY ev.id_evento ASC)
        FROM capacidad_movilizacion_eventos ev WHERE ev.id_persona = $1), '[]'::jsonb) AS capacidad_movilizacion_eventos,

        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'nombre_equipo', ep.nombre_equipo,
          'activo', ep.activo
        ) ORDER BY ep.id_equipo ASC)
        FROM equipos_politicos ep WHERE ep.id_persona = $1), '[]'::jsonb) AS equipos,

        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'nivel', rp.nivel,
          'nombres', rp.nombres,
          'apellido_paterno', rp.apellido_paterno,
          'apellido_materno', rp.apellido_materno
        ) ORDER BY rp.id_referente ASC)
        FROM referentes_politicos rp WHERE rp.id_persona = $1), '[]'::jsonb) AS referentes,

        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'nombre', fp.nombre,
          'parentesco', fp.parentesco,
          'cargo', fp.cargo,
          'institucion', fp.institucion
        ) ORDER BY fp.id_familiar ASC)
        FROM familiares_politica fp WHERE fp.id_persona = $1), '[]'::jsonb) AS familiares,

        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'tipo', po.tipo,
          'nombre', po.nombre,
          'rol', po.rol,
          'periodo', po.periodo,
          'notas', po.notas
        ) ORDER BY po.id_participacion ASC)
        FROM participacion_organizaciones po WHERE po.id_persona = $1), '[]'::jsonb) AS participacion_organizaciones,

        CASE WHEN (SELECT sin_controversias_publicas FROM personas WHERE id_persona=$1) = true THEN '[]'::jsonb
        ELSE COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id_tipo', cper.id_tipo,
          'estatus', cper.estatus,
          'fecha_registro', cper.fecha_registro,
          'descripcion', cper.descripcion,
          'fuente', cper.fuente
        ) ORDER BY cper.id_controversia ASC)
        FROM controversias_persona cper WHERE cper.id_persona = $1), '[]'::jsonb)
        END AS controversias,

        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id_tema', pti.id_tema,
          'otro_texto', pti.otro_texto
        ) ORDER BY pti.id_tema ASC)
        FROM personas_temas_interes pti WHERE pti.id_persona = $1), '[]'::jsonb) AS temas_interes,

        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'periodo', c.periodo,
            'cargo', c.cargo,
            'partido_postulante', c.partido_postulante,
            'modalidad', c.modalidad
          ) ORDER BY c.id_cargo_eleccion ASC)
          FROM cargos_eleccion_popular c
          WHERE c.id_persona = $1
        ), '[]'::jsonb) AS cargos_eleccion_popular,

        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'periodo', ex.periodo,
            'cargo', ex.cargo,
            'organizacion', ex.organizacion
          ) ORDER BY ex.id_experiencia ASC)
          FROM experiencia_laboral ex
          WHERE ex.id_persona = $1
        ), '[]'::jsonb) AS experiencia_laboral

      FROM personas p
      WHERE p.id_persona = $1
      LIMIT 1
      `,
      [id]
    );

    const r = rows[0];

    // ===== payload EXACTO que tu front espera =====
    const payload = {
      persona: {
        nombre: r.nombre,
        apellido_paterno: r.apellido_paterno,
        apellido_materno: r.apellido_materno,
        curp: r.curp,
        rfc: r.rfc,
        clave_elector: r.clave_elector,
        estado_civil: r.estado_civil,
        escala_influencia: r.escala_influencia,
        sin_servicio_publico: r.sin_servicio_publico,
        ha_contendido_eleccion: r.ha_contendido_eleccion,
        municipio_residencia_legal: r.municipio_residencia_legal,
        municipio_residencia_real: r.municipio_residencia_real,
        municipio_trabajo_politico: r.municipio_trabajo_politico,
        sin_controversias_publicas: r.sin_controversias_publicas,
        id_partido_actual: r.id_partido_actual,
        partido_otro_texto: r.partido_otro_texto,
        id_grupo_postulacion: r.id_grupo_postulacion,
        id_ideologia_politica: r.id_ideologia_politica,
        sin_cargos_eleccion_popular: r.sin_cargos_eleccion_popular,
        foto_url: r.foto_url || null
      },
      datos_ine: r.datos_ine,
      telefonos: r.telefonos,
      parejas: (r.parejas || []).map(pa => ({
        // en edición no hay temp_id, lo usamos como "id_pareja" para selects/hijos
        temp_id: `id_${pa.id_pareja}`,
        nombre_pareja: pa.nombre_pareja,
        tipo_relacion: pa.tipo_relacion,
        periodo: pa.periodo
      })),
      hijos: (r.hijos || []).map(h => ({
        // mapeamos id_pareja al temp_id que creamos arriba
        pareja_temp_id: h.id_pareja ? `id_${h.id_pareja}` : null,
        anio_nacimiento: h.anio_nacimiento,
        sexo: h.sexo
      })),
      redes: r.redes,
      servicio_publico: r.servicio_publico,
      elecciones: r.elecciones,
      capacidad_movilizacion_eventos: r.capacidad_movilizacion_eventos,
      equipos: r.equipos,
      referentes: r.referentes,
      controversias: r.controversias,
      familiares: r.familiares,
      formacion_academica: r.formacion_academica,
      temas_interes: r.temas_interes,
      participacion_organizaciones: r.participacion_organizaciones,

      // si ya tienes estos módulos en el front, los llenas igual
      cargos_eleccion_popular: [],
      experiencia_laboral: [],
      cargos_eleccion_popular: r.cargos_eleccion_popular,
      experiencia_laboral: r.experiencia_laboral

    };

    return res.json(payload);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Error al obtener payload edición", detail: e.message });
  }
};*/
