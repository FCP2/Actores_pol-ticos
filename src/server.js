require('dotenv').config();
const app = require('./app');

const PORT = process.env.PORT || 3000;

// Evita que errores de conexión DB o promesas no atrapadas crasheen el proceso
process.on('unhandledRejection', (reason) => {
  console.error('🔴 unhandledRejection:', reason?.message || reason);
});

process.on('uncaughtException', (err) => {
  console.error('🔴 uncaughtException:', err.message);
  // Solo reinicia si es un error fatal real, no por timeouts de red
  if (!['ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(err.code)) {
    process.exit(1);
  }
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
