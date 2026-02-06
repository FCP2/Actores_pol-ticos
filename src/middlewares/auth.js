const jwt = require('jsonwebtoken');

function isSuperadmin(req) {
  return (req.user?.roles || []).includes("superadmin");
}

function requireOffice(req, res, next) {
  if (isSuperadmin(req)) return next();
  if (!req.user?.id_oficina) return res.status(403).json({ error: "Usuario sin oficina asignada" });
  next();
}

function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;

    if (!token) return res.status(401).json({ error: 'No autorizado' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.user = {
      id_usuario: decoded.id_usuario,
      email: decoded.email,
      roles: decoded.roles || [],
      id_oficina: decoded.id_oficina ?? null
    };

    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido' });
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
