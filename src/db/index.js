const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 8,                    // 🔑 Límite seguro Render free/low
  idleTimeoutMillis: 30000,  // 🔑 Cierra idle >30s (evita "terminated")
  connectionTimeoutMillis: 5000,
  allowExitOnIdle: false     // 🔑 No exit cuando idle muere
});

// 🔑 Handler errores idle (Render mata conex idle)
pool.on('error', (err, client) => {
  console.error('🔴 Pool idle error:', err.message);
  // No process.exit() - deja que Render maneje
});

pool.on('connect', (client) => {
  client.query("SET NAMES 'UTF8'");
});

module.exports = pool;
