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

    layersById[m.id_municipio] = layer;
  });
}

function resaltarMunicipioById(id){
  Object.values(layersById).forEach(l=>{
    l.setStyle({ color:"#6c757d", fillColor:"#adb5bd", fillOpacity:0.30, weight:1 });
  });

  const layer = layersById[id];
  if (!layer) return;

  layer.setStyle({ color:"#831E30", fillColor:"#831E30", fillOpacity:0.55, weight:3 });
  map.fitBounds(layer.getBounds(), { padding:[40,40] });
}