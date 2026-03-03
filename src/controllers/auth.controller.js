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
        u.id_oficina,
        u.cargo,
        u.area,
        u.scope,
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
      area: user.area,
      cargo: user.cargo,
      roles: user.roles || [],
      id_oficina: user.id_oficina ?? null,
      scope: user.scope
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
        scope: user.scope
      }
    });
    
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error en login', detail: e.message });
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
        o.nombre AS nombre_oficina,
        COALESCE(array_remove(array_agg(r.nombre), NULL), '{}') AS roles
      FROM usuarios u
      LEFT JOIN oficinas o ON o.id_oficina = u.id_oficina
      LEFT JOIN usuarios_roles ur ON ur.id_usuario = u.id_usuario
      LEFT JOIN roles r ON r.id_rol = ur.id_rol
      WHERE u.id_usuario = $1
      GROUP BY u.id_usuario, u.nombre, u.email, u.activo, u.id_oficina, u.cargo, u.area, o.nombre
    `, [req.user.id_usuario]);
    
    client.release();
    
    if (q.rowCount === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    const user = q.rows[0];
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
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error en /me', detail: e.message });
  }
};
