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
      onEachFeature: (f,l) => {
        l.bindTooltip(m.nombre, {
          sticky:true,
          direction:"top",
          className:"tooltip-mun"
        });

        l.on("click", () => {
          if (typeof onMunicipioSelected === 'function') {
            onMunicipioSelected(m.id_municipio); // ✅ aquí ya mandamos ID
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
}

function resaltarMunicipioById(id){
  // ✅ primero: restaura cobertura para todos
  applyCoverageStyle();

  // ✅ luego: resalta el seleccionado encima
  const layer = layersById[id];
  if (!layer) return;

  layer.setStyle({ color:"#831E30", fillColor:"#831E30", fillOpacity:0.55, weight:3 });
  map.fitBounds(layer.getBounds(), { padding:[40,40] });
}

//map vs kpi

// ============================
// Cobertura por municipio (KPI)
// ============================
let municipioCountById = new Map(); // id_municipio -> total actores
let legendControl = null;

// Umbrales (fácil de entender para jefe)
function coverageColor(count){
  const n = Number(count || 0);
  if (n === 0) return "#dc2626";      // rojo (0)
  if (n <= 2) return "#f97316";       // naranja (1-2)
  if (n <= 5) return "#facc15";       // amarillo (3-5)
  if (n <= 10) return "#86efac";      // verde claro (6-10)
  return "#16a34a";                   // verde fuerte (11+)
}

function coverageLabel(count){
  const n = Number(count || 0);
  if (n === 0) return "0";
  if (n <= 2) return "1–2";
  if (n <= 5) return "3–5";
  if (n <= 10) return "6–10";
  return "11+";
}

function applyCoverageStyle(){
  Object.entries(layersById).forEach(([idStr, layer]) => {
    const id = Number(idStr);
    const total = municipioCountById.get(id) ?? 0;

    // OJO: layer es L.geoJSON (tiene setStyle)
    layer.setStyle({
      color: "#6c757d",
      weight: 1,
      fillColor: coverageColor(total),
      fillOpacity: 0.45
    });

    // Popup informativo
    // (si ya tienes tooltip con nombre, esto complementa con datos)
    try {
      layer.bindPopup(`
        <div style="min-width:200px">
          <div style="font-weight:700; margin-bottom:4px;">${nombreById?.get?.(id) || "Municipio"}</div>
          <div><b>Actores:</b> ${total}</div>
          <div class="text-muted" style="font-size:12px">Cobertura: ${coverageLabel(total)}</div>
        </div>
      `, { closeButton: true });
    } catch(e){}
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
      { label:"1–2",   color: coverageColor(2) },
      { label:"3–5",   color: coverageColor(5) },
      { label:"6–10",  color: coverageColor(10) },
      { label:"11+",   color: coverageColor(11) }
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
