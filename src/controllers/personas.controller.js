const pool = require('../db');

// 1) LISTA (para mapa o tablas)
// /api/personas?municipio_trabajo=34
exports.listPersonas = async (req, res) => {
  try {
    const { municipio_trabajo } = req.query;

    const params = [];
    let where = '';

    const idMun = Number(municipio_trabajo);
    if (Number.isFinite(idMun) && idMun > 0) {
      params.push(idMun);
      where = `WHERE p.municipio_trabajo_politico = $1`;
    }

    const { rows } = await pool.query(
      `
      SELECT
        p.id_persona,
        p.nombre,
        p.escala_influencia,
        p.created_at,

        -- ✅ flags
        p.sin_controversias_publicas,

        -- ✅ ids (por si los ocupas en front)
        p.id_partido_actual,
        p.id_tema_interes_central,
        p.tema_interes_otro_texto,
        p.id_grupo_postulacion,
        p.id_ideologia_politica,

        -- ✅ nombres (para badges)
        cp.nombre  AS partido_actual,
        cp.siglas  AS partido_actual_siglas,
        cti.nombre AS tema_interes_central,
        cgp.nombre AS grupo_postulacion,
        cip.nombre AS ideologia_politica,

        -- ✅ municipio trabajo (texto)
        mt.nombre  AS municipio_trabajo_politico

      FROM personas p
      LEFT JOIN municipios mt ON mt.id_municipio = p.municipio_trabajo_politico

      -- mismos catálogos que tu perfil
      LEFT JOIN catalogo_partidos cp ON cp.id_partido = p.id_partido_actual
      LEFT JOIN catalogo_temas_interes cti ON cti.id_tema = p.id_tema_interes_central
      LEFT JOIN catalogo_grupos_postulacion cgp ON cgp.id_grupo = p.id_grupo_postulacion
      LEFT JOIN catalogo_ideologia_politica cip ON cip.id_ideologia = p.id_ideologia_politica

      ${where}
      ORDER BY p.id_persona DESC
      `,
      params
    );

    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al listar personas' });
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
      capacidad_movilizacion = null,
      equipos = [],
      referentes = [],
      controversias = [],
      formacion_academica = [],
      familiares = [],
      participacion_organizaciones = []
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

    // PERSONA
    const creadoPor = req.user.id_usuario;
    const insertPersona = await client.query(
      `
      INSERT INTO personas (
        nombre, curp, rfc, clave_elector, estado_civil, escala_influencia,
        sin_servicio_publico, ha_contendido_eleccion, creado_por,
        municipio_residencia_legal, municipio_residencia_real, municipio_trabajo_politico,
        sin_controversias_publicas,
        id_partido_actual,
        id_tema_interes_central,
        tema_interes_otro_texto,
        id_grupo_postulacion,
        id_ideologia_politica
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      RETURNING id_persona
      `,
      [
        persona.nombre,
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
        persona.id_tema_interes_central || null,
        (persona.tema_interes_otro_texto || '').trim() || null,
        persona.id_grupo_postulacion || null,
        persona.id_ideologia_politica || null
      ]
    );


    const id_persona = insertPersona.rows[0].id_persona;

    // FORMACION ACADEMICA (histórico-ready)
  for (const fa of formacion_academica) {
    const tieneAlgo =
      fa?.nivel ||
      fa?.grado ||
      fa?.grado_obtenido ||
      fa?.institucion ||
      fa?.anio_inicio ||
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

    await client.query(
      `
      INSERT INTO formacion_academica
        (id_persona, nivel, grado_obtenido, institucion, anio_inicio, anio_fin, grado)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      `,
      [
        id_persona,
        fa.nivel,
        requiereDetalle ? (fa.grado_obtenido || null) : null,
        requiereDetalle ? (fa.institucion || null) : null,
        fa.anio_inicio || null,
        fa.anio_fin || null,
        fa.grado || null
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
      const tieneAlgo = p?.nombre_pareja || p?.tipo_relacion || p?.fecha_inicio || p?.fecha_fin;
      if (!tieneAlgo) continue;

      const { rows } = await client.query(
        `
        INSERT INTO parejas (id_persona, nombre_pareja, tipo_relacion, fecha_inicio, fecha_fin)
        VALUES ($1,$2,$3,$4,$5)
        RETURNING id_pareja
        `,
        [id_persona, p.nombre_pareja || null, p.tipo_relacion || null, p.fecha_inicio || null, p.fecha_fin || null]
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

    // CAPACIDAD MOVILIZACION (1 por persona)
    if (capacidad_movilizacion) {
      await client.query(
        `
        INSERT INTO capacidad_movilizacion (id_persona, eventos_ultimos_3_anios, asistencia_promedio)
        VALUES ($1,$2,$3)
        `,
        [id_persona, capacidad_movilizacion.eventos_ultimos_3_anios || null, capacidad_movilizacion.asistencia_promedio || null]
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
        INSERT INTO referentes_politicos (id_persona, nivel, nombre_referente)
        VALUES ($1,$2,$3)
        `,
        [id_persona, ref.nivel || null, ref.nombre_referente || null]
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
              'nombre_referente', rp.nombre_referente
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

    const roles = req.user.roles || [];
    if (roles.includes('capturista') && rows[0].creado_por !== req.user.id_usuario) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    if (!rows[0]) return res.status(404).json({ error: "Persona no encontrada" });
    return res.json(rows[0]);
    
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
              'nombre_referente', rp.nombre_referente
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

