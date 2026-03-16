let map;
let layersById = {}; // id_municipio -> layer
let onMunicipioSelected = null;

function setOnMunicipioSelected(fn){
  onMunicipioSelected = fn;
}

function initMap(){
  map = L.map("map", { zoomControl: false }).setView([19.35, -99.5], 8);

  L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    { attribution: '&copy; OpenStreetMap &copy; CARTO', subdomains:'abcd', maxZoom:20 }
  ).addTo(map);

  L.control.zoom({ position: 'bottomleft' }).addTo(map);
}

function drawMunicipios(municipiosConPoligono){
  // limpia capas previas
  Object.values(layersById).forEach(l => {
    try { map.removeLayer(l); } catch(e){}
  });
  layersById = {};

  municipiosConPoligono.forEach(m => {
    if (!m.wkt) return;

    const geo = wellknown.parse(m.wkt);
    if (!geo) return;

    const layer = L.geoJSON(geo, {
      style:{
        color:"#6c757d",
        weight:1,
        fillColor:"#adb5bd",
        fillOpacity:0.30
      },
    onEachFeature: (f, l) => {
      // ✅ INYECTA propiedades para que el highlight funcione
      f.properties = f.properties || {};
      f.properties.nombre = m.nombre;         // <-- clave
      f.properties.id_municipio = m.id_municipio;

      l.bindTooltip(m.nombre, {
        sticky:true,
        direction:"top",
        className:"tooltip-mun"
      });

      l.on("click", () => {
        if (typeof onMunicipioSelected === 'function') {
          onMunicipioSelected(m.id_municipio);
        }
      });
    }
    }).addTo(map);
      // Si ya hay conteos cargados, aplica colores de cobertura
    if (municipioCountById && municipioCountById.size) {
      applyCoverageStyle();
    }
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


function resaltarMunicipioById(id){
  // ✅ primero: restaura cobertura para todos
  applyCoverageStyle();

  // ✅ luego: resalta el seleccionado encima
  const layer = layersById[id];
  if (!layer) return;

  layer.setStyle({ color:"#000000", fillColor:"#d8ee59", fillOpacity:0.55, weight:3 });
  map.fitBounds(layer.getBounds(), { padding:[40,40] });
}

// ============================
// Cobertura por municipio (KPI)
// ============================
let municipioCountById = new Map(); // id_municipio -> total actores
let legendControl = null;

// NUEVOS Umbrales según tu solicitud
function coverageColor(count){
  const n = Number(count || 0);

  // ✅ 0 = SIN REGISTROS (se queda base/neutral)
  if (n === 0) return "#adb5bd";   // o "#e5e7eb" si lo quieres más claro

  // ✅ 1-10 = ya hay cobertura
  if (n <= 10) return "#ef4444";   // rojo vivo

  if (n <= 20) return "#fb923c";   // naranja
  if (n <= 30) return "#facc15";   // amarillo
  if (n <= 40) return "#4ade80";   // verde claro
  return "#16a34a";                // verde fuerte
}

function coverageLabel(count){
  const n = Number(count || 0);
  if (n === 0) return "0";
  if (n <= 10) return "1-10";
  if (n <= 20) return "11-20";
  if (n <= 30) return "21-30";
  if (n <= 40) return "31-40";
  return "41+";
}

function applyCoverageStyle(){
  Object.entries(layersById).forEach(([idStr, group]) => {
    const id = Number(idStr);
    const total = municipioCountById.get(id) ?? 0;
    const fillColor = coverageColor(total);

    const style = {
      color: "#1f2937",
      weight: 1.5,
      fillColor,
      fillOpacity: 0.6
    };

    if (group?.setStyle) {
      group.setStyle(style);
    } else if (group?.getLayers) {
      (group.getLayers() || []).forEach(sl => sl?.setStyle?.(style));
    }
  });
}



function addCoverageLegend(){
  // Si ya existe, la quitamos para no duplicar
  if (legendControl) {
    try { map.removeControl(legendControl); } catch(e){}
    legendControl = null;
  }

  legendControl = L.control({ position: "bottomright" });
  legendControl.onAdd = function(){
    const div = L.DomUtil.create("div", "leaflet-control leaflet-bar");
    div.style.background = "white";
    div.style.padding = "10px 12px";
    div.style.borderRadius = "10px";
    div.style.boxShadow = "0 4px 12px rgba(0,0,0,.12)";
    div.style.fontSize = "12px";
    div.style.lineHeight = "1.2";

    const bins = [
      { label:"0",     color: coverageColor(0) },
      { label:"1-10",  color: coverageColor(1) },
      { label:"11-20", color: coverageColor(15) },
      { label:"21-30", color: coverageColor(25) },
      { label:"31-40", color: coverageColor(35) },
      { label:"41+",   color: coverageColor(50) },
    ];

    div.innerHTML = `
      <div style="font-weight:700; margin-bottom:6px;">Cobertura</div>
      ${bins.map(b => `
        <div style="display:flex; align-items:center; gap:8px; margin:4px 0;">
          <span style="width:14px; height:14px; border-radius:4px; background:${b.color}; display:inline-block; border:1px solid rgba(0,0,0,.15)"></span>
          <span>${b.label}</span>
        </div>
      `).join("")}
    `;
    return div;
  };
  legendControl.addTo(map);
}

/**
 * API pública: dashboard.js llamará esto con un Map o un objeto.
 * - countsMap: Map(id_municipio -> total) o plain object {id: total}
 */
function setMunicipioCoverageCounts(countsMap){
  municipioCountById = new Map();

  if (countsMap instanceof Map) {
    countsMap.forEach((v,k)=> municipioCountById.set(Number(k), Number(v||0)));
  } else {
    Object.entries(countsMap || {}).forEach(([k,v]) => municipioCountById.set(Number(k), Number(v||0)));
  }

  applyCoverageStyle();
  addCoverageLegend();
}
function resetMapCoverageView(){
  // 1) vuelve a aplicar colores por cobertura
  applyCoverageStyle();

  // 2) vuelve a vista inicial del EdoMex
  map.setView([19.35, -99.5], 8);
}

//filtrop por referente :
// ============================
// Filtro por referente (highlight municipios)
// ============================

function norm(s){
  return String(s||"")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // quita tildes
}

function resetMunicipiosHighlight() {
  applyCoverageStyle?.();
}
window.resetMunicipiosHighlight = resetMunicipiosHighlight;

function highlightMunicipiosByIdList(ids, { dimOthers = true } = {}) {
    const set = new Set((ids || []).map(n => Number(n)).filter(Boolean));

    Object.entries(layersById).forEach(([idStr, group]) => {
      const id = Number(idStr);
      const total = municipioCountById.get(id) ?? 0;
      const baseFill = coverageColor(total); // ✅ color original KPI
      const hit = set.has(id);

      if (!group) return;

      if (dimOthers) {
        group.setStyle(
          hit
            ? {
                color: "#1f2937",
                weight: 2.2,
                fillColor: baseFill,   // ✅ restaura color KPI
                fillOpacity: 0.72
              }
            : {
                color: "#9ca3af",
                weight: 1,
                fillColor: baseFill,   // ✅ también aquí
                fillOpacity: 0.10
              }
        );
      } else if (hit) {
        group.setStyle({
          color: "#1f2937",
          weight: 2.2,
          fillColor: baseFill,
          fillOpacity: 0.72
        });
      }
    });
  }
//funcion para poder pintar mapa con filtro de actores, varios municipios de trabajo :
function highlightPersonaMunicipiosDetalle(rows = []) {

  if (!Array.isArray(rows) || !rows.length) {
    resetMunicipiosHighlight();
    return;
  }

  const ids = new Set(rows.map(r => Number(r.id_municipio)).filter(Boolean));

  Object.entries(layersById).forEach(([idStr, group]) => {
    const id = Number(idStr);
    if (!group) return;

    const hit = ids.has(id);
    const item = rows.find(r => Number(r.id_municipio) === id);
    const esPrincipal = !!item?.es_principal;

    if (!hit) {
      group.setStyle({
        weight: 1,
        color: "#9ca3af",
        fillOpacity: 0.06
      });
      return;
    }

    // ✅ estilo especial para detalle persona
    group.setStyle(
      esPrincipal
        ? {
            color: "#1d4ed8",
            weight: 3,
            fillColor: "#2563eb",
            fillOpacity: 0.72
          }
        : {
            color: "#2563eb",
            weight: 2,
            fillColor: "#60a5fa",
            fillOpacity: 0.55
          }
    );
  });

  // zoom al conjunto de municipios
  const selectedLayers = Object.entries(layersById)
    .filter(([idStr]) => ids.has(Number(idStr)))
    .map(([, group]) => group)
    .filter(Boolean);

  if (selectedLayers.length && map) {
    const fg = L.featureGroup(selectedLayers);
    try {
      map.fitBounds(fg.getBounds(), { padding: [30, 30] });
    } catch (e) {
      console.warn("No pude ajustar bounds del detalle:", e);
    }
  }
}

// ============================
// Dashboard: foco territorial por actor
// ============================

let actorFocusIds = new Set();

function clearActorFocusOnMap({ restoreCoverage = true } = {}) {
  actorFocusIds = new Set();

  if (restoreCoverage) {
    applyCoverageStyle?.();
  }
}

function paintActorMunicipiosOnMap(rows = [], opts = {}) {
  const {
    fit = true,
    dimOthers = true,
    principalStyle = {
      color: "#1d4ed8",
      weight: 3,
      fillColor: "#2563eb",
      fillOpacity: 0.72
    },
    secondaryStyle = {
      color: "#2563eb",
      weight: 2,
      fillColor: "#60a5fa",
      fillOpacity: 0.55
    }
  } = opts;

  if (!Array.isArray(rows) || !rows.length) {
    clearActorFocusOnMap({ restoreCoverage: true });
    return { painted: 0, ids: [] };
  }

  const normalized = rows
    .map(r => ({
      id_municipio: Number(r.id_municipio),
      es_principal: !!r.es_principal,
      municipio: r.municipio || ""
    }))
    .filter(r => Number.isFinite(r.id_municipio) && r.id_municipio > 0);

  if (!normalized.length) {
    clearActorFocusOnMap({ restoreCoverage: true });
    return { painted: 0, ids: [] };
  }

  actorFocusIds = new Set(normalized.map(r => r.id_municipio));

  Object.entries(layersById).forEach(([idStr, group]) => {
    const id = Number(idStr);
    if (!group) return;

    const hit = actorFocusIds.has(id);
    const item = normalized.find(r => r.id_municipio === id);
    const esPrincipal = !!item?.es_principal;

    if (!hit) {
      if (dimOthers) {
        const total = municipioCountById.get(id) ?? 0;
        const baseFill = coverageColor(total);

        group.setStyle({
          color: "#9ca3af",
          weight: 1,
          fillColor: baseFill,
          fillOpacity: 0.10
        });
      }
      return;
    }

    group.setStyle(esPrincipal ? principalStyle : secondaryStyle);
  });

  const selectedLayers = Object.entries(layersById)
    .filter(([idStr]) => actorFocusIds.has(Number(idStr)))
    .map(([, group]) => group)
    .filter(Boolean);

  if (fit && selectedLayers.length && map) {
    const fg = L.featureGroup(selectedLayers);
    try {
      map.fitBounds(fg.getBounds(), { padding: [30, 30] });
    } catch (e) {
      console.warn("No pude ajustar bounds del actor:", e);
    }
  }

  return {
    painted: selectedLayers.length,
    ids: [...actorFocusIds]
  };
}


window.setMunicipioCoverageCounts = setMunicipioCoverageCounts;
window.resetMapCoverageView = resetMapCoverageView;
//DASHBOARD, VARIOS MUNICIPIOS

window.highlightMunicipiosByIdList = highlightMunicipiosByIdList;

window.highlightPersonaMunicipiosDetalle = highlightPersonaMunicipiosDetalle;

// expón a window
window.resetMunicipiosHighlight = resetMunicipiosHighlight;
window.setOnMunicipioSelected = setOnMunicipioSelected;
window.resaltarMunicipioById = resaltarMunicipioById;
window.initMap = initMap;
window.drawMunicipios = drawMunicipios;
