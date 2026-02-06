require('dotenv').config();
const app = require('./app');

const PORT = process.env.PORT || 10000;  // Usa 10000 como fallback para Render

app.listen(PORT, '0.0.0.0', () => {  // Agrega '0.0.0.0' como host
  console.log(`Servidor escuchando en puerto ${PORT}`);  // Quita 'localhost' del log
});
