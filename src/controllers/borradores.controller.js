const pool = require('../db');

exports.listMine = async (req, res) => {
  const id_usuario = req.user.id_usuario;
  const q = await pool.query(
    `SELECT id_borrador, titulo, estatus, created_at, updated_at
     FROM borradores_persona
     WHERE id_usuario = $1
     ORDER BY updated_at DESC`,
    [id_usuario]
  );
  res.json(q.rows);
};

exports.getOneMine = async (req, res) => {
  const id_usuario = req.user.id_usuario;
  const id = Number(req.params.id);

  const q = await pool.query(
    `SELECT id_borrador, titulo, estatus, payload, created_at, updated_at
     FROM borradores_persona
     WHERE id_borrador = $1 AND id_usuario = $2`,
    [id, id_usuario]
  );

  if (q.rowCount === 0) return res.status(404).json({ error: 'No encontrado' });
  res.json(q.rows[0]);
};

exports.create = async (req, res) => {
  const id_usuario = req.user.id_usuario;
  const { titulo = null, payload } = req.body || {};
  if (!payload) return res.status(400).json({ error: 'payload es obligatorio' });

  const q = await pool.query(
    `INSERT INTO borradores_persona (id_usuario, titulo, payload)
     VALUES ($1,$2,$3)
     RETURNING id_borrador`,
    [id_usuario, titulo, payload]
  );
  res.status(201).json({ ok: true, id_borrador: q.rows[0].id_borrador });
};

exports.updateMine = async (req, res) => {
  const id_usuario = req.user.id_usuario;
  const id = Number(req.params.id);
  const { titulo = null, payload, estatus } = req.body || {};

  const q = await pool.query(
    `UPDATE borradores_persona
     SET titulo = COALESCE($1, titulo),
         payload = COALESCE($2, payload),
         estatus = COALESCE($3, estatus)
     WHERE id_borrador = $4 AND id_usuario = $5
     RETURNING id_borrador`,
    [titulo, payload || null, estatus || null, id, id_usuario]
  );

  if (q.rowCount === 0) return res.status(404).json({ error: 'No encontrado' });
  res.json({ ok: true, id_borrador: q.rows[0].id_borrador });
};

exports.deleteMine = async (req, res) => {
  const id_usuario = req.user.id_usuario;
  const id = Number(req.params.id);

  const q = await pool.query(
    `DELETE FROM borradores_persona
     WHERE id_borrador = $1 AND id_usuario = $2
     RETURNING id_borrador`,
    [id, id_usuario]
  );

  if (q.rowCount === 0) return res.status(404).json({ error: 'No encontrado' });
  res.json({ ok: true });
};