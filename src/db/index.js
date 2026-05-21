const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 8,
  idleTimeoutMillis: 10000,       // Cierra idle mucho antes de que Render las mate (~30s)
  connectionTimeoutMillis: 8000,  // Más margen para conectar a DB remota
  allowExitOnIdle: false,
  keepAlive: true,                // TCP keepalive — previene que el OS mate la conexión
  keepAliveInitialDelayMillis: 5000
});

// Captura errores en clientes idle del pool (Render mata conexiones inactivas)
pool.on('error', (err) => {
  console.error('🔴 Pool error:', err.message);
});

pool.on('connect', (client) => {
  client.query("SET NAMES 'UTF8'");
});

module.exports = pool;
