const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const router = express.Router();

const DISK_MOUNT = process.env.DISK_MOUNT_PATH || "/var/data";
const UPLOAD_DIR = path.join(DISK_MOUNT, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const safeExt = [".jpg", ".jpeg", ".png", ".webp"].includes(ext) ? ext : ".jpg";
    cb(null, `persona_${Date.now()}_${Math.random().toString(16).slice(2)}${safeExt}`);
  }
});

function fileFilter(req, file, cb) {
  const ok = ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype);
  cb(ok ? null : new Error("Tipo de archivo no permitido"), ok);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 3 * 1024 * 1024 } // 3MB
});

router.post("/foto", upload.single("foto"), async (req, res) => {
  // aquí ya tienes req.file
  if (!req.file) return res.status(400).json({ error: "No se recibió archivo" });

  const publicUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;
  return res.status(201).json({ ok: true, foto_url: publicUrl, filename: req.file.filename });
});

module.exports = router;
