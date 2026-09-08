const pool = require('../db');
const jwt = require('jsonwebtoken');

//turnstile
const TURNSTILE_VERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });
}

const INACTIVE_USER_ERROR = {
  ok: false,
  code: 'USER_INACTIVE',
  error: 'Usuario dado de baja. Reporte a su dirección.'
};

function rejectInactiveUser(res, status = 403) {
  return res.status(status).json(INACTIVE_USER_ERROR);
}

//turnstile
async function verifyTurnstile(token, remoteIp) {
  if (!token) {
    return {
      success: false,
      errorCodes: ['missing-token']
    };
  }

  if (!process.env.TURNSTILE_SECRET_KEY) {
    console.error('TURNSTILE_SECRET_KEY no está configurada');

    return {
      success: false,
      errorCodes: ['server-config-error']
    };
  }

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 8000);

  try {
    const body = new URLSearchParams();

    body.append('secret', process.env.TURNSTILE_SECRET_KEY);
    body.append('response', token);

    if (remoteIp) {
      body.append('remoteip', remoteIp);
    }

    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body,
      signal: controller.signal
    });

    if (!response.ok) {
      console.error(
        'Turnstile Siteverify respondió:',
        response.status
      );

      return {
        success: false,
        errorCodes: ['siteverify-error']
      };
    }

    const data = await response.json();

    return {
      success: data.success === true,
      hostname: data.hostname,
      action: data.action,
      challengeTs: data.challenge_ts,
      errorCodes: data['error-codes'] || []
    };

  } catch (error) {

    console.error(
      'Error verificando Turnstile:',
      error.name === 'AbortError'
        ? 'Timeout'
        : error.message
    );

    return {
      success: false,
      errorCodes: ['siteverify-unavailable']
    };

  } finally {
    clearTimeout(timeout);
  }
}

exports.login = async (req, res) => {
  try {

    const {
      email,
      password,
      turnstileToken
    } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({
        error: 'email y password son obligatorios'
      });
    }


    // ─────────────────────────────────────────────
    // CLOUDFLARE TURNSTILE
    // ─────────────────────────────────────────────

    if (!turnstileToken) {
      return res.status(400).json({
        ok: false,
        code: 'TURNSTILE_REQUIRED',
        error: 'Completa la verificación de seguridad.'
      });
    }

    const turnstileResult = await verifyTurnstile(
      turnstileToken,
      req.ip
    );

    if (!turnstileResult.success) {

      console.warn(
        'Turnstile rechazado:',
        turnstileResult.errorCodes
      );

      return res.status(403).json({
        ok: false,
        code: 'TURNSTILE_FAILED',
        error: 'No se pudo validar la verificación de seguridad.'
      });
    }


    // Validar que el token fue generado específicamente
    // para la acción login
    if (
      turnstileResult.action &&
      turnstileResult.action !== 'login'
    ) {

      console.warn(
        'Turnstile action inválida:',
        turnstileResult.action
      );

      return res.status(403).json({
        ok: false,
        code: 'TURNSTILE_INVALID_ACTION',
        error: 'Verificación de seguridad inválida.'
      });
    }


    // ─────────────────────────────────────────────
    // LOGIN NORMAL
    // ─────────────────────────────────────────────

    const q = await pool.query(
      `
      SELECT 
        u.id_usuario,
        u.nombre,
        u.email,
        u.activo,
        u.id_oficina,
        u.cargo,
        u.area,
        u.scope,
        u.puede_verificar_final,
        array_remove(array_agg(r.nombre), NULL) AS roles
      FROM usuarios u
      LEFT JOIN usuarios_roles ur
        ON ur.id_usuario = u.id_usuario
      LEFT JOIN roles r
        ON r.id_rol = ur.id_rol
      WHERE u.email = $1
        AND u.password_hash = crypt($2, u.password_hash)
      GROUP BY u.id_usuario
      `,
      [
        email.toLowerCase().trim(),
        password
      ]
    );

    if (q.rowCount === 0) {
      return res.status(401).json({
        error: 'Credenciales inválidas'
      });
    }

    const user = q.rows[0];

    if (user.activo !== true) {
      return rejectInactiveUser(res);
    }

    const token = signToken({
      id_usuario: user.id_usuario,
      email: user.email,
      area: user.area,
      cargo: user.cargo,
      roles: user.roles || [],
      id_oficina: user.id_oficina ?? null,
      scope: user.scope,
      puede_verificar_final:
        user.puede_verificar_final === true
    });

    return res.json({
      ok: true,
      token,

      user: {
        id_usuario: user.id_usuario,
        nombre: user.nombre,
        email: user.email,
        cargo: user.cargo ?? null,
        area: user.area ?? null,
        roles: user.roles || [],
        id_oficina: user.id_oficina ?? null,
        scope: user.scope,
        puede_verificar_final:
          user.puede_verificar_final === true
      }
    });

  } catch (e) {

    console.error(e);

    res.status(500).json({
      error: 'Error en login',
      detail: e.message
    });
  }
};

exports.me = async (req, res) => {
  try {
    const client = await pool.connect();
    
    const q = await client.query(`
      SELECT 
        u.id_usuario, u.nombre, u.email, u.activo,
        u.id_oficina,
        u.cargo,
        u.area,
        u.scope,
        u.puede_verificar_final,
        o.nombre AS nombre_oficina,
        COALESCE(array_remove(array_agg(r.nombre), NULL), '{}') AS roles
      FROM usuarios u
      LEFT JOIN oficinas o ON o.id_oficina = u.id_oficina
      LEFT JOIN usuarios_roles ur ON ur.id_usuario = u.id_usuario
      LEFT JOIN roles r ON r.id_rol = ur.id_rol
      WHERE u.id_usuario = $1
      GROUP BY
        u.id_usuario, u.nombre, u.email, u.activo,
        u.id_oficina, u.cargo, u.area, u.scope,
        u.puede_verificar_final,
        o.nombre
    `, [req.user.id_usuario]);
    
    client.release();
    
    if (q.rowCount === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    const user = q.rows[0];
    if (user.activo !== true) {
      return rejectInactiveUser(res, 401);
    }

    res.json({ 
      ok: true, 
      user: {
        id_usuario: user.id_usuario,
        nombre: user.nombre,
        email: user.email,
        cargo: user.cargo ?? null,
        area: user.area ?? null,
        roles: user.roles || [],
        id_oficina: user.id_oficina ?? null,
        nombre_oficina: user.nombre_oficina || null,
        scope: user.scope,
        puede_verificar_final: user.puede_verificar_final === true
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error en /me', detail: e.message });
  }
};
