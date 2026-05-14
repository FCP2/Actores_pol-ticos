const pool   = require('../db');
const puppeteer = require('puppeteer');
const https  = require('https');
const http   = require('http');

const HEADER_IMG_URL = "https://lh3.googleusercontent.com/d/18fNmkOjp0_asak96yPafw9ncyaEc7u6N=s550";

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fetchBase64(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith("https") ? https : http;
    lib.get(url, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const mime = res.headers["content-type"] || "image/jpeg";
        resolve(`data:${mime};base64,${buf.toString("base64")}`);
      });
    }).on("error", () => resolve(""));
  });
}

function launchBrowser() {
  return puppeteer.launch({
    headless: "new",
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      (typeof puppeteer.executablePath === "function" ? puppeteer.executablePath() : undefined),
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--single-process"]
  });
}

async function htmlToPdf(html, pdfOpts = {}) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(60000);
    await page.setContent(html, { waitUntil: "load" });
    const raw = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "6mm", right: "8mm", bottom: "12mm", left: "8mm" },
      displayHeaderFooter: true,
      headerTemplate: `<div style="font-size:0;"></div>`,
      footerTemplate: `
        <div style="width:100%;font-size:7.5px;color:#9ca3af;padding:0 8mm;
                    display:flex;justify-content:space-between;align-items:center;">
          <span>Sistema de Actores Políticos — Gobierno del Estado de México</span>
          <span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span>
        </div>`,
      ...pdfOpts
    });
    return Buffer.from(raw);
  } finally {
    await browser.close().catch(() => {});
  }
}

/* =====================================================
   REPORTE: ACTORES POR MUNICIPIO (es_principal = true)
   GET /api/personas/reportes/municipios?municipios=1,2,3
   municipios=all  →  todos
   ===================================================== */
exports.reporteMunicipios = async (req, res) => {
  const client = await pool.connect();
  try {
    const rawIds = (req.query.municipios || "all").trim();
    const params = [];
    let whereExtra = "";

    if (rawIds !== "all") {
      const ids = rawIds
        .split(",")
        .map(s => Number(s.trim()))
        .filter(n => Number.isFinite(n) && n > 0);

      if (ids.length) {
        params.push(ids);
        whereExtra = `WHERE m.id_municipio = ANY($1::int[])`;
      }
    }

    const { rows } = await client.query(`
      SELECT
        m.nombre                                                          AS municipio,
        COUNT(DISTINCT CASE WHEN pmt.es_principal = true
                            THEN pmt.id_persona END)::int                AS total
      FROM municipios m
      LEFT JOIN personas_municipios_trabajo pmt ON pmt.id_municipio = m.id_municipio
      ${whereExtra}
      GROUP BY m.id_municipio, m.nombre
      ORDER BY total DESC, m.nombre ASC
    `, params);

    // ── Metadatos ─────────────────────────────────────────
    const fechaStr = new Date().toLocaleDateString("es-MX", {
      timeZone: "America/Mexico_City",
      year: "numeric", month: "long", day: "2-digit"
    });
    const totalGeneral = rows.reduce((s, r) => s + r.total, 0);
    const alcanceLabel = rawIds === "all"
      ? "Todos los municipios"
      : `${rows.length} municipio(s) seleccionado(s)`;

    // ── Encabezado institucional (base64 para no depender de red en Puppeteer) ─
    const headerImg = await fetchBase64(HEADER_IMG_URL);

    // ── Distribución en 3 columnas ────────────────────────
    const NCOLS = rows.length > 0 ? 3 : 1;
    const perCol = Math.ceil(rows.length / NCOLS);

    const columnasHtml = Array.from({ length: NCOLS }, (_, ci) => {
      const slice = rows.slice(ci * perCol, (ci + 1) * perCol);
      if (!slice.length) return `<div class="col"></div>`;

      const filas = slice.map((r, li) => {
        const rk = ci * perCol + li + 1;
        const even = rk % 2 === 0;
        const zero = r.total === 0 ? "zero" : "";
        return `
          <div class="mun-row ${even ? "even" : "odd"} ${zero}">
            <span class="rk">${rk}</span>
            <span class="nm">${esc(r.municipio)}</span>
            <span class="ct">${r.total === 0 ? "—" : r.total.toLocaleString("es-MX")}</span>
          </div>`;
      }).join("");

      return `
        <div class="col">
          <div class="col-head">
            <span class="ch-mun">Municipio</span>
            <span class="ch-ct">Reg.</span>
          </div>
          ${filas}
        </div>`;
    }).join("");

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<style>
  :root {
    --guinda: #8b2136;
    --guinda-dk: #6b1828;
    --dorado: #b89056;
    --dorado-lt: #f5ead6;
    --gray: #4b5563;
    --gray-lt: #f3f4f6;
    --border: #e5e7eb;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Segoe UI", Arial, sans-serif; font-size: 12px;
         color: #111; background: #fff; }

  /* ── Encabezado institucional ── */
  .inst-header { width: 100%; display: block; }
  .inst-header img { width: 100%; max-height: 55px; object-fit: contain; object-position: left center; display: block; }

  /* ── Franja de título ── */
  .title-bar {
    background: var(--guinda);
    color: #fff;
    padding: 7px 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-top: 3px solid var(--dorado);
  }
  .title-bar h1 { font-size: 15px; font-weight: 700; letter-spacing: .3px; }
  .title-bar .meta { font-size: 11px; text-align: right; opacity: .9; line-height: 1.7; }

  /* ── Barra resumen ── */
  .sumbar {
    background: var(--dorado-lt);
    border-bottom: 2px solid var(--dorado);
    padding: 6px 12px;
    display: flex;
    gap: 28px;
    align-items: center;
  }
  .sum-item { display: flex; flex-direction: column; }
  .sum-label { font-size: 10px; color: var(--gray); text-transform: uppercase;
               letter-spacing: .5px; }
  .sum-value { font-size: 16px; font-weight: 700; color: var(--guinda); }
  .sum-divider { width: 1px; background: var(--dorado); align-self: stretch; opacity: .5; }

  /* ── Grid de columnas ── */
  .col-grid {
    display: grid;
    grid-template-columns: repeat(${NCOLS}, 1fr);
    gap: 6px;
    padding: 8px 10px 10px;
  }
  .col { display: flex; flex-direction: column; }

  /* Cabecera de columna */
  .col-head {
    display: flex;
    justify-content: space-between;
    background: var(--guinda);
    color: #fff;
    padding: 5px 8px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: .4px;
    border-bottom: 2px solid var(--dorado);
    border-radius: 2px 2px 0 0;
  }

  /* Fila de municipio */
  .mun-row {
    display: flex;
    align-items: center;
    padding: 4px 6px;
    border-bottom: 1px solid var(--border);
    line-height: 1.4;
  }
  .mun-row.even { background: #fafafa; }
  .mun-row.odd  { background: #fff; }
  .rk {
    min-width: 22px;
    font-size: 10px;
    color: var(--dorado);
    font-weight: 700;
    text-align: right;
    margin-right: 6px;
    flex-shrink: 0;
  }
  .nm { flex: 1; font-size: 12px; color: #1f2937; overflow: hidden; }
  .ct {
    min-width: 32px;
    font-size: 12px;
    font-weight: 700;
    color: var(--guinda);
    text-align: right;
    margin-left: 6px;
    flex-shrink: 0;
  }
  .mun-row.zero .nm { color: #9ca3af; }
  .mun-row.zero .ct { color: #9ca3af; font-weight: 400; }
  .mun-row.zero .rk { color: #d1d5db; }

  /* ── Pie de totales ── */
  .total-bar {
    margin: 0 10px 8px;
    background: var(--guinda);
    color: #fff;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 5px 10px;
    border-radius: 0 0 3px 3px;
    font-size: 9px;
    font-weight: 700;
    border-top: 2px solid var(--dorado);
  }
  .total-bar .lbl { opacity: .85; font-size: 8px; letter-spacing: .3px; text-transform: uppercase; }
</style>
</head>
<body>

  ${headerImg ? `
  <div class="inst-header">
    <img src="${headerImg}" alt="Encabezado institucional"/>
  </div>` : ""}

  <div class="title-bar">
    <h1>Reporte de Actores Políticos por Municipio</h1>
    <div class="meta">
      <div>Fecha: ${esc(fechaStr)}</div>
      <div>Alcance: ${esc(alcanceLabel)}</div>
    </div>
  </div>

  <div class="sumbar">
    <div class="sum-item">
      <span class="sum-label">Municipios en reporte</span>
      <span class="sum-value">${rows.length}</span>
    </div>
    <div class="sum-divider"></div>
    <div class="sum-item">
      <span class="sum-label">Total de registros</span>
      <span class="sum-value">${totalGeneral.toLocaleString("es-MX")}</span>
    </div>
  </div>

  <div class="col-grid">
    ${rows.length ? columnasHtml : `<div style="padding:20px;color:#6b7280;text-align:center;grid-column:1/-1;">Sin registros para los municipios seleccionados.</div>`}
  </div>

  <div class="total-bar">
    <span class="lbl">Total general de registros</span>
    <span>${totalGeneral.toLocaleString("es-MX")}</span>
  </div>

</body>
</html>`;

    const pdf = await htmlToPdf(html);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="reporte-municipios.pdf"');
    res.setHeader("Content-Length", pdf.length);
    return res.end(pdf);

  } catch (e) {
    console.error("reporteMunicipios:", e);
    return res.status(500).json({ error: "Error al generar reporte de municipios", detail: e.message });
  } finally {
    client.release();
  }
};
