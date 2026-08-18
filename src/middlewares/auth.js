const jwt = require('jsonwebtoken');
const pool = require('../db');

const INACTIVE_USER_ERROR = {
  ok: false,
  code: 'USER_INACTIVE',
  error: 'Usuario dado de baja. Reporte a su dirección.'
};

function isSuperadmin(req) {
  return (req.user?.roles || []).includes("superadmin");
}

/*function requireOffice(req, res, next) {
  if (isSuperadmin(req)) return next();
  if (!req.user?.id_oficina) return res.status(403).json({ error: "Usuario sin oficina asignada" });
  next();
}*/

function requireOffice(req, res, next) {
  const roles = req.user?.roles || [];
  if (roles.includes("superadmin")) return next();

  if (!req.user?.id_oficina) {
    return res.status(403).json({ error: "Usuario sin oficina asignada" });
  }
  next();
}

async function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;

  if (!token) return res.status(401).json({ error: 'No autorizado' });

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  try {
    const userStatus = await pool.query(
      'SELECT activo FROM usuarios WHERE id_usuario = $1',
      [decoded.id_usuario]
    );

    if (userStatus.rowCount === 0 || userStatus.rows[0].activo !== true) {
      return res.status(401).json(INACTIVE_USER_ERROR);
    }

    req.user = {
      id_usuario: decoded.id_usuario,
      email: decoded.email,
      cargo: decoded.cargo || null,        // ✅ decoded.cargo
      area: decoded.area || null,          // ✅ decoded.area   
      roles: decoded.roles || [],
      id_oficina: decoded.id_oficina ?? null,
      scope: decoded.scope || null,
      puede_verificar_final: decoded.puede_verificar_final === true
    };

    next();
  } catch (e) {
    console.error('Error al validar el estado del usuario:', e);
    return res.status(500).json({ error: 'Error al validar la sesión' });
  }
}

function requireRole(...allowed) {
  return (req, res, next) => {
    const roles = req.user?.roles || [];
    const ok = allowed.some(r => roles.includes(r));
    if (!ok) return res.status(403).json({ error: 'Prohibido' });
    next();
  };
}

// ✅ Exporta TODO junto (sin mezclar exports.* con module.exports)
module.exports = {
  requireAuth,
  requireRole,
  requireOffice,
  isSuperadmin
};
