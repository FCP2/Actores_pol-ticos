const router  = require("express").Router();
const { spawn } = require("child_process");
const path    = require("path");

const UPLOADS_DIR = process.env.DISK_MOUNT_PATH
  ? path.join(process.env.DISK_MOUNT_PATH, "uploads")   // Render: /var/data/uploads
  : process.env.UPLOAD_DIR
    ? path.resolve(process.env.UPLOAD_DIR)
    : path.join(__dirname, "../../uploads");

const BACKUP_SECRET = process.env.BACKUP_SECRET || "";

// Middleware simple: verifica el secreto sin tocar la lógica de usuarios
function requireBackupSecret(req, res, next) {
  if (!BACKUP_SECRET) {
    return res.status(500).json({ error: "BACKUP_SECRET no configurado en .env" });
  }
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  if (token !== BACKUP_SECRET) {
    return res.status(401).json({ error: "Secreto de backup inválido" });
  }
  next();
}

// GET /api/backup/fotos
router.get("/fotos", requireBackupSecret, (req, res) => {
  const fecha    = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const fileName = `backup_fotos_${fecha}.tar.gz`;

  res.setHeader("Content-Type", "application/gzip");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);

  const parentDir  = path.dirname(UPLOADS_DIR);
  const folderName = path.basename(UPLOADS_DIR);

  const tar = spawn("tar", ["-czf", "-", folderName], { cwd: parentDir });

  tar.stdout.pipe(res);
  tar.stderr.on("data", d => console.warn("[backup-fotos]", d.toString().trim()));
  tar.on("error", err => {
    console.error("[backup-fotos] Error:", err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });
  tar.on("close", code => {
    if (code !== 0) console.warn("[backup-fotos] tar código", code);
  });
  req.on("close", () => tar.kill());
});

module.exports = router;
