
const express = require('express');
const cors = require('cors');
const path = require('path');

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

// ✅ API
app.use('/api', apiRoutes);

// ✅ status opcional
app.get('/api-status', (req, res) => {
  res.send('API funcionando correctamente 🚀');
});

module.exports = app;