let map;
let layersById        = {};
let nombreMunicipioById = {};
let _selectedLayerId  = null;
let onMunicipioSelected = null;

// Datos de todas las capas: id_municipio -> { total, verificados, confiabilidad_alta, partido_dominante }
let _capasData   = new Map();
let _currentLayer = "cobertura";

let municipioCountById = new Map(); // para tooltip
let _legendControl = null; // Leaflet control (evita el clip de overflow:hidden)

// ── Init ──────────────────────────────────────────────────────────────────────

function setOnMunicipioSelected(fn) { onMunicipioSelected = fn; }

function initMap() {
  map = L.map("map", { zoomControl: false }).setView([19.35, -99.5], 8);

  L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    { attribution: "&copy; OpenStreetMap &copy; CARTO", subdomains: "abcd", maxZoom: 20 }
  ).addTo(map);

  L.control.zoom({ position: "bottomleft" }).addTo(map);
}

// ── Draw polygons ─────────────────────────────────────────────────────────────

function drawMunicipios(municipiosConPoligono) {
  Object.values(layersById).forEach(l => { try { map.removeLayer(l); } catch(e){} });
  layersById        = {};
  nombreMunicipioById = {};
  _selectedLayerId  = null;

  municipiosConPoligono.forEach(m => {
    if (!m.wkt) return;
    const geo = wellknown.parse(m.wkt);
    if (!geo) return;

    const layer = L.geoJSON(geo, {
      style: { color: "#0f172a", weight: 1.5, fillColor: "#374151", fillOpacity: 0.6 },
      onEachFeature: (f, l) => {
        f.properties = f.properties || {};
        f.properties.nombre      = m.nombre;
        f.properties.id_municipio = m.id_municipio;

        l.bindTooltip(m.nombre, { sticky: true, direction: "top", className: "tooltip-mun" });

        l.on("click", () => {
          if (typeof onMunicipioSelected === "function") onMunicipioSelected(m.id_municipio);
        });
      }
    }).addTo(map);

    nombreMunicipioById[m.id_municipio] = m.nombre;
    layersById[m.id_municipio] = layer;
  });

  window.mapReady = true;

  if (window._pendingHighlightMunicipiosById?.length) {
    window.highlightMunicipiosByIdList?.(window._pendingHighlightMunicipiosById, { dimOthers: true });
    window._pendingHighlightMunicipiosById = null;
  }
  if (window._pendingPersonaMunicipiosDetalle?.length) {
    window.highlightPersonaMunicipiosDetalle?.(window._pendingPersonaMunicipiosDetalle);
    window._pendingPersonaMunicipiosDetalle = null;
  }
}

// ── Layer data ────────────────────────────────────────────────────────────────

function setCapasMapa(dataArray) {
  _capasData       = new Map();
  municipioCountById = new Map();

  (dataArray || []).forEach(row => {
    const id = Number(row.id_municipio);
    if (!id) return;
    _capasData.set(id, row);
    municipioCountById.set(id, Number(row.total || 0));
  });

  paintCurrentLayer();
  updateLayerLegend();
}

// Compatibilidad con analista.js que llama setMunicipioCoverageCounts
function setMunicipioCoverageCounts(countsMap) {
  const arr = [];
  if (countsMap instanceof Map) {
    countsMap.forEach((v, k) => arr.push({ id_municipio: k, total: v }));
  } else {
    Object.entries(countsMap || {}).forEach(([k, v]) => arr.push({ id_municipio: k, total: v }));
  }
  setCapasMapa(arr);
}

function switchMapLayer(layerName) {
  _currentLayer = layerName;
  // Cierra bubble de selección si hay una activa
  if (_selectedLayerId != null && layersById[_selectedLayerId]) {
    const prev = layersById[_selectedLayerId];
    prev.unbindTooltip();
    prev.bindTooltip(nombreMunicipioById[_selectedLayerId] || "", {
      sticky: true, direction: "top", className: "tooltip-mun"
    });
    _selectedLayerId = null;
  }
  paintCurrentLayer();
  updateLayerLegend();
}

// ── Pintar polígonos según capa activa ────────────────────────────────────────

function paintCurrentLayer() {
  Object.entries(layersById).forEach(([idStr, group]) => {
    const id   = Number(idStr);
    const data = _capasData.get(id) || {};
    const fill = _getLayerColor(_currentLayer, data);
    const style = { color: "#0f172a", weight: 1.5, fillColor: fill, fillOpacity: fill === "#374151" ? 0.45 : 0.82 };

    if (group?.setStyle)    group.setStyle(style);
    else if (group?.getLayers) group.getLayers().forEach(sl => sl?.setStyle?.(style));
  });
}

function _getLayerColor(layer, data) {
  switch (layer) {
    case "cobertura":     return _coberturaColor(Number(data.total || 0));
    case "verificacion":  return _verificacionColor(Number(data.total || 0), Number(data.verificados || 0));
    case "confiabilidad": return _confiabilidadColor(Number(data.total || 0), Number(data.confiabilidad_alta || 0));
    case "partido":       return _partyColor(data.partido_dominante);
    default:              return "#374151";
  }
}

// Escala cobertura
function _coberturaColor(n) {
  if (n === 0)  return "#374151";
  if (n <= 10)  return "#ef4444";
  if (n <= 20)  return "#fb923c";
  if (n <= 30)  return "#facc15";
  if (n <= 40)  return "#4ade80";
  return "#16a34a";
}

// Escala % verificados
function _verificacionColor(total, verificados) {
  if (!total) return "#374151";
  const pct = (verificados / total) * 100;
  if (pct === 0)  return "#ef4444";
  if (pct <= 25)  return "#fb923c";
  if (pct <= 50)  return "#facc15";
  if (pct <= 75)  return "#4ade80";
  return "#16a34a";
}

// Escala % confiabilidad alta
function _confiabilidadColor(total, alta) {
  if (!total) return "#374151";
  const pct = (alta / total) * 100;
  if (pct === 0)  return "#ef4444";
  if (pct <= 25)  return "#fb923c";
  if (pct <= 50)  return "#facc15";
  if (pct <= 75)  return "#4ade80";
  return "#16a34a";
}

// Colores por partido (id_partido_actual de cada registro)
const _PARTY_COLORS = {
  "PRI":    "#16a34a",
  "PAN":    "#3b82f6",
  "PRD":    "#eab308",
  "MORENA": "#dc2626",
  "MC":     "#f97316",
  "PVEM":   "#22c55e",
  "PT":     "#f43f5e",
  "NA":     "#a855f7",
  "PES":    "#8b5cf6",
  "RSP":    "#06b6d4",
  "FXCM":  "#0891b2",
  "INDEPENDIENTE": "#94a3b8",
};

function _partyColor(siglas) {
  if (!siglas) return "#374151";
  return _PARTY_COLORS[String(siglas).toUpperCase().trim()] || "#6366f1";
}

// ── Panel "Cobertura Territorial" (solo capa cobertura) ──────────────────────

function updateLayerLegend() {
  // Elimina control anterior
  if (_legendControl) {
    try { map.removeControl(_legendControl); } catch(e) {}
    _legendControl = null;
  }

  // Solo se muestra en cobertura y partido
  if (_currentLayer !== "cobertura" && _currentLayer !== "partido") return;

  const content = _currentLayer === "cobertura"
    ? _buildPanelContent()
    : _buildPartidoPanel();
  if (!content) return;

  _legendControl = L.control({ position: "bottomright" });
  _legendControl.onAdd = function() {
    const div = L.DomUtil.create("div");
    div.style.cssText = [
      "background:rgba(10,14,26,0.93)",
      "border:1px solid rgba(255,255,255,0.07)",
      "border-radius:14px",
      "padding:13px 15px",
      "box-shadow:0 8px 32px rgba(0,0,0,.65)",
      "font-size:12px", "line-height:1.4",
      "font-family:inherit",
      "min-width:210px", "max-width:240px",
      "pointer-events:none",
      "color:#f1f5f9"
    ].join(";");
    div.innerHTML = content;
    return div;
  };
  _legendControl.addTo(map);
}

function _buildPanelContent() {
  const ROW = (color, label, stat) =>
    `<div style="display:flex;align-items:center;gap:9px;margin:5px 0">
      <span style="width:11px;height:11px;border-radius:3px;background:${color};
                   display:inline-block;flex-shrink:0;
                   box-shadow:0 0 0 1px rgba(255,255,255,.12)"></span>
      <span style="color:#cbd5e1;font-weight:500;flex:1">${label}</span>
      <span style="color:#94a3b8;font-size:11px;white-space:nowrap">${stat}</span>
    </div>`;

  const HEADER =
    `<div style="display:flex;align-items:center;gap:6px;font-weight:700;font-size:10px;
                 text-transform:uppercase;letter-spacing:.08em;color:#64748b;margin-bottom:10px">
      <i class="bi bi-bar-chart-fill" style="font-size:11px;color:#8b2136"></i>
      Cobertura Territorial
    </div>`;

  const DIVIDER = `<div style="border-top:1px solid rgba(255,255,255,.06);margin:8px 0"></div>`;

  // ── Sin datos: muestra solo la escala de colores ──────────────────────────
  if (!_capasData.size) {
    const staticBins = [
      ["#374151", "Sin registros", ""],
      ["#ef4444", "1 – 10",        ""],
      ["#fb923c", "11 – 20",       ""],
      ["#facc15", "21 – 30",       ""],
      ["#4ade80", "31 – 40",       ""],
      ["#16a34a", "41+",           ""],
    ];
    return HEADER + staticBins.map(([c, l, s]) => ROW(c, l, s)).join("");
  }

  // ── Con datos: muestra conteos reales ─────────────────────────────────────
  const stats = _computeLayerStats();
  if (!stats) return null;

  const rows = stats.bins.map(b => ROW(b.color, b.label, b.stat)).join("");
  const footer = stats.footer
    ? `<div style="color:#475569;font-size:11px;text-align:right">${stats.footer}</div>`
    : "";

  return HEADER + rows + (footer ? DIVIDER + footer : "");
}

function _buildPartidoPanel() {
  if (!_capasData.size) return null;

  const all = [..._capasData.values()];

  // Agrupa municipios por partido dominante
  const freq = new Map();
  all.forEach(d => {
    const k = d.partido_dominante
      ? String(d.partido_dominante).toUpperCase().trim()
      : "__SIN__";
    freq.set(k, (freq.get(k) || 0) + 1);
  });

  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  const conPartido = all.filter(d => d.partido_dominante).length;
  const totalMun   = all.length;

  const ROW = (color, label, count, pct) =>
    `<div style="display:flex;align-items:center;gap:8px;margin:5px 0">
      <span style="width:11px;height:11px;border-radius:3px;background:${color};
                   display:inline-block;flex-shrink:0;
                   box-shadow:0 0 0 1px rgba(255,255,255,.12)"></span>
      <span style="color:#cbd5e1;font-weight:600;flex:1;font-size:12px">${label}</span>
      <span style="color:#e2e8f0;font-weight:700;font-size:13px;min-width:22px;text-align:right">${count}</span>
      <span style="color:#475569;font-size:10px;min-width:32px;text-align:right">${pct}%</span>
    </div>`;

  const rows = sorted.map(([siglas, count]) => {
    const label = siglas === "__SIN__" ? "Sin partido" : siglas;
    const color = siglas === "__SIN__" ? "#374151" : _partyColor(siglas);
    const pct   = totalMun ? Math.round(count / totalMun * 100) : 0;
    return ROW(color, label, count, pct);
  }).join("");

  return `
    <div style="display:flex;align-items:center;gap:6px;font-weight:700;font-size:10px;
                text-transform:uppercase;letter-spacing:.08em;color:#64748b;margin-bottom:10px">
      <i class="bi bi-flag-fill" style="font-size:11px;color:#8b2136"></i>
      Partido Dominante
    </div>
    ${rows}
    <div style="border-top:1px solid rgba(255,255,255,.06);margin:8px 0"></div>
    <div style="color:#475569;font-size:11px;text-align:right">
      ${conPartido} de ${totalMun} municipios con partido
    </div>
  `;
}

function _computeLayerStats() {
  if (!_capasData.size) return null;

  const all      = [..._capasData.values()];
  const totalMun = all.length;
  const totalAct = all.reduce((s, d) => s + Number(d.total || 0), 0);

  const tiers = [
    { label: "Sin registros", color: "#374151", test: n => n === 0 },
    { label: "1 – 10",        color: "#ef4444", test: n => n >= 1  && n <= 10 },
    { label: "11 – 20",       color: "#fb923c", test: n => n >= 11 && n <= 20 },
    { label: "21 – 30",       color: "#facc15", test: n => n >= 21 && n <= 30 },
    { label: "31 – 40",       color: "#4ade80", test: n => n >= 31 && n <= 40 },
    { label: "41+",           color: "#16a34a", test: n => n >= 41 },
  ];

  const bins = tiers.map(t => {
    const items  = all.filter(d => t.test(Number(d.total || 0)));
    const act    = items.reduce((s, d) => s + Number(d.total || 0), 0);
    const munTxt = `${items.length} mun.`;
    const actTxt = act > 0 ? ` · ${act} act.` : "";
    return { label: t.label, color: t.color, stat: munTxt + actTxt };
  });

  return {
    bins,
    footer: `${totalMun} municipios · ${totalAct.toLocaleString("es-MX")} actores`
  };
}

// ── applyCoverageStyle (reset + repintar) ─────────────────────────────────────

function applyCoverageStyle() {
  // Cierra bubble de selección si hay una activa
  if (_selectedLayerId != null && layersById[_selectedLayerId]) {
    const prev = layersById[_selectedLayerId];
    prev.unbindTooltip();
    prev.bindTooltip(nombreMunicipioById[_selectedLayerId] || "", {
      sticky: true, direction: "top", className: "tooltip-mun"
    });
  }
  _selectedLayerId = null;
  paintCurrentLayer();
}

function resetMapCoverageView() {
  applyCoverageStyle();
  map.setView([19.35, -99.5], 8);
}

// ── Resaltar municipio seleccionado ───────────────────────────────────────────

function resaltarMunicipioById(id) {
  applyCoverageStyle();

  const layer = layersById[id];
  if (!layer) return;

  _selectedLayerId = id;
  layer.setStyle({ color: "#5a0f22", fillColor: "#8b2136", fillOpacity: 0.75, weight: 3 });

  const total  = municipioCountById.get(Number(id)) ?? 0;
  const nombre = nombreMunicipioById[id] || "";

  layer.unbindTooltip();
  layer.bindTooltip(`
    <div style="text-align:center;padding:2px 4px">
      <div style="font-size:11px;font-weight:700;color:#374151;margin-bottom:4px;white-space:nowrap">${nombre}</div>
      <div style="font-size:28px;font-weight:800;color:#8b2136;line-height:1">${total}</div>
      <div style="font-size:10px;color:#6b7280;margin-top:2px">actores</div>
    </div>
  `, { permanent: true, direction: "center", className: "tooltip-mun" })
  .openTooltip();

  map.fitBounds(layer.getBounds(), { padding: [40, 40] });
}

// ── Highlight helpers ─────────────────────────────────────────────────────────

function resetMunicipiosHighlight() { applyCoverageStyle(); }

function highlightMunicipiosByIdList(ids, { dimOthers = true } = {}) {
  const set = new Set((ids || []).map(n => Number(n)).filter(Boolean));

  Object.entries(layersById).forEach(([idStr, group]) => {
    const id  = Number(idStr);
    const data = _capasData.get(id) || {};
    const base = _getLayerColor(_currentLayer, data);
    const hit  = set.has(id);
    if (!group) return;

    group.setStyle(
      hit
        ? { color: "#0f172a", weight: 2.2, fillColor: base, fillOpacity: 0.82 }
        : dimOthers
          ? { color: "#334155", weight: 0.8, fillColor: base, fillOpacity: 0.12 }
          : { color: "#0f172a", weight: 2.2, fillColor: base, fillOpacity: 0.82 }
    );
  });
}

function highlightPersonaMunicipiosDetalle(rows = []) {
  if (!Array.isArray(rows) || !rows.length) { resetMunicipiosHighlight(); return; }

  const ids = new Set(rows.map(r => Number(r.id_municipio)).filter(Boolean));

  Object.entries(layersById).forEach(([idStr, group]) => {
    const id = Number(idStr);
    if (!group) return;
    const hit       = ids.has(id);
    const item      = rows.find(r => Number(r.id_municipio) === id);
    const principal = !!item?.es_principal;

    if (!hit) {
      group.setStyle({ weight: 0.8, color: "#334155", fillOpacity: 0.08 });
      return;
    }
    group.setStyle(
      principal
        ? { color: "#1d4ed8", weight: 3, fillColor: "#2563eb", fillOpacity: 0.75 }
        : { color: "#2563eb", weight: 2, fillColor: "#60a5fa", fillOpacity: 0.55 }
    );
  });

  const selected = Object.entries(layersById)
    .filter(([idStr]) => ids.has(Number(idStr)))
    .map(([, g]) => g).filter(Boolean);

  if (selected.length && map) {
    try { map.fitBounds(L.featureGroup(selected).getBounds(), { padding: [30, 30] }); }
    catch(e) {}
  }
}

let actorFocusIds = new Set();

function clearActorFocusOnMap({ restoreCoverage = true } = {}) {
  actorFocusIds = new Set();
  if (restoreCoverage) applyCoverageStyle();
}

function paintActorMunicipiosOnMap(rows = [], opts = {}) {
  const {
    fit = true, dimOthers = true,
    principalStyle = { color: "#1d4ed8", weight: 3, fillColor: "#2563eb", fillOpacity: 0.75 },
    secondaryStyle = { color: "#2563eb", weight: 2, fillColor: "#60a5fa", fillOpacity: 0.55 }
  } = opts;

  if (!Array.isArray(rows) || !rows.length) {
    clearActorFocusOnMap({ restoreCoverage: true });
    return { painted: 0, ids: [] };
  }

  const normalized = rows
    .map(r => ({ id_municipio: Number(r.id_municipio), es_principal: !!r.es_principal }))
    .filter(r => Number.isFinite(r.id_municipio) && r.id_municipio > 0);

  if (!normalized.length) { clearActorFocusOnMap({ restoreCoverage: true }); return { painted: 0, ids: [] }; }

  actorFocusIds = new Set(normalized.map(r => r.id_municipio));

  Object.entries(layersById).forEach(([idStr, group]) => {
    const id  = Number(idStr);
    if (!group) return;
    const hit  = actorFocusIds.has(id);
    const item = normalized.find(r => r.id_municipio === id);

    if (!hit) {
      if (dimOthers) {
        const data = _capasData.get(id) || {};
        group.setStyle({ color: "#334155", weight: 0.8,
          fillColor: _getLayerColor(_currentLayer, data), fillOpacity: 0.10 });
      }
      return;
    }
    group.setStyle(item?.es_principal ? principalStyle : secondaryStyle);
  });

  const selected = Object.entries(layersById)
    .filter(([idStr]) => actorFocusIds.has(Number(idStr)))
    .map(([, g]) => g).filter(Boolean);

  if (fit && selected.length && map) {
    try { map.fitBounds(L.featureGroup(selected).getBounds(), { padding: [30, 30] }); }
    catch(e) {}
  }
  return { painted: selected.length, ids: [...actorFocusIds] };
}

// ── Exports ───────────────────────────────────────────────────────────────────

window.initMap                           = initMap;
window.drawMunicipios                    = drawMunicipios;
window.setOnMunicipioSelected            = setOnMunicipioSelected;
window.setCapasMapa                      = setCapasMapa;
window.setMunicipioCoverageCounts        = setMunicipioCoverageCounts;
window.switchMapLayer                    = switchMapLayer;
window.resaltarMunicipioById             = resaltarMunicipioById;
window.resetMunicipiosHighlight          = resetMunicipiosHighlight;
window.highlightMunicipiosByIdList       = highlightMunicipiosByIdList;
window.highlightPersonaMunicipiosDetalle = highlightPersonaMunicipiosDetalle;
window.paintActorMunicipiosOnMap         = paintActorMunicipiosOnMap;
window.clearActorFocusOnMap              = clearActorFocusOnMap;
window.resetMapCoverageView              = resetMapCoverageView;
