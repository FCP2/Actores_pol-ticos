require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require("fs");

const apiRoutes = require('./routes');
const { requireAuth, requireRole } = require('./middlewares/auth');

const app = express();

app.use(cors());
app.use(express.json());

// ✅ sirve assets desde /static -> /public
app.use('/static', express.static(path.join(__dirname, '..', 'public'), {
  index: false,
  extensions: false,
}));

app.use('/data', express.static(path.join(__dirname, '..', 'public', 'data')));

// ✅ login público
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

app.get('/captura', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

// ✅ Ruta del disco (Render mount path)
app.set("trust proxy", 1);

const DISK_MOUNT = process.env.DISK_MOUNT_PATH || "/var/data";
const UPLOAD_DIR = path.join(DISK_MOUNT, "uploads");

// crea carpeta si no existe
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ✅ servir archivos subidos
app.use("/uploads", express.static(UPLOAD_DIR)); // express.static docs :contentReference[oaicite:2]{index=2}
app.use("/api/upload", require("./routes/upload.routes"));

// ✅ API
app.use('/api', apiRoutes);

// ✅ status opcional
app.get('/api-status', (req, res) => {
  res.send('API funcionando correctamente 🚀');
});

module.exports = app;
