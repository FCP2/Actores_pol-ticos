const pool = require('../db');
const jwt = require('jsonwebtoken');

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });
}

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email y password son obligatorios' });
    }

    const q = await pool.query(
      `
      SELECT
        u.id_usuario, u.nombre, u.email, u.activo,
        array_remove(array_agg(r.nombre), NULL) AS roles
      FROM usuarios u
      LEFT JOIN usuarios_roles ur ON ur.id_usuario = u.id_usuario
      LEFT JOIN roles r ON r.id_rol = ur.id_rol
      WHERE u.email = $1
        AND u.activo = true
        AND u.password_hash = crypt($2, u.password_hash)
      GROUP BY u.id_usuario
      `,
      [email.toLowerCase().trim(), password]
    );

    if (q.rowCount === 0) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const user = q.rows[0];
    const token = signToken({
      id_usuario: user.id_usuario,
      email: user.email,
      roles: user.roles || []
    });

    return res.json({
      ok: true,
      token,
      user: {
        id_usuario: user.id_usuario,
        nombre: user.nombre,
        email: user.email,
        roles: user.roles || []
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error en login', detail: e.message });
  }
};

exports.me = async (req, res) => {
  // requireAuth ya puso req.user
  res.json({ ok: true, user: req.user });
};