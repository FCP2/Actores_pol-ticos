const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,  // Ya incluye ?client_encoding=UTF8
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

// Opcional: Fuerza en conexiones para pools compartidos como Render
pool.on('connect', (client) => {
  client.query("SET NAMES 'UTF8'");
});
module.exports = pool;