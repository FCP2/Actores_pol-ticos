const jwt = require('jsonwebtoken');

exports.requireAuth = (req, res, next) => {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    //console.log('[AUTH] header:', h ? 'present' : 'missing');
    if (!token) return res.status(401).json({ error: 'No autorizado' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    //console.log('[AUTH] decoded:', decoded);

    req.user = {
      id_usuario: decoded.id_usuario,
      email: decoded.email,
      roles: decoded.roles || []
    };

    next();
  } catch (e) {
    //console.log('[AUTH] error:', e.message);
    return res.status(401).json({ error: 'Token inválido' });
  }
};

exports.requireRole = (...allowed) => {
  return (req, res, next) => {
    //console.log('[ROLE] allowed:', allowed, 'user.roles:', req.user?.roles);
    const roles = req.user?.roles || [];
    const ok = allowed.some(r => roles.includes(r));
    if (!ok) return res.status(403).json({ error: 'Prohibido' });
    next();
  };
};