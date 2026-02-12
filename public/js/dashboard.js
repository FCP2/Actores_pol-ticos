let municipiosDb = [];            // [{id_municipio,nombre}]
let perfilModalInstance = null;
let personasCache = [];
let municipiosJson = [];          // [{municipio, poligono}]
let municipioIdByNorm = new Map();// norm(nombreBD) -> id
let jsonWktByNorm = new Map();    // norm(nombreJSON) -> wkt
let nombreById = new Map();       // id -> nombre
//reporte por usuarios
let personasGrid = null;
let usuariosFiltroCache = [];
let gridState = {
  creado_por: '',      // id_usuario
  municipio_trabajo: '',// opcional
  q: '',
  pageSize: 25
};
let currentMunicipioTrabajoId = null;
//kpi compeltitud
let chartCompleto = null;
let chartUsuarios = null;

//kpi municipios con o sin actores municipio_trabajo_politico
let chartMunTop = null;
let editPersonaModalInstance = null;
//Modal edit 

function showEditAlert(type, msg){
  const el = document.getElementById("editPersonaAlert");
  if (!el) return;
  el.className = `alert alert-${type}`;
  el.textContent = msg || "";
  el.classList.toggle("d-none", !msg);
}
//helpers
async function refreshCards(){
  if (!currentMunicipioTrabajoId) {
    // si no hay municipio seleccionado, al menos repinta lo que haya
    applySearch();
    return;
  }
  await loadPersonasByMunicipioId(currentMunicipioTrabajoId);
}
//debounce (para búsqueda)
function debounce(fn, wait = 300) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function normalizeName(s) {
  return (s || '')
    .toString()
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s.-]/g, '');
}
function setHtmlIfExists(id, html){
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = html;
}

function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
  }[c]));
}
function escAttr(s){
  // para atributos HTML como src=""
  return esc(s).replace(/"/g, "&quot;");
}

function fillSelectById(selectEl, rows){
  selectEl.innerHTML = `<option value="" selected disabled>Selecciona un municipio...</option>`;
  rows.forEach(r=>{
    const opt = document.createElement('option');
    opt.value = r.id_municipio;      // ✅ value = ID
    opt.textContent = r.nombre;      // ✅ texto = nombre oficial BD
    selectEl.appendChild(opt);
  });
  selectEl.disabled = false;
}

function debugMissingMatches(){
  const missingDb = [];
  municipiosDb.forEach(m=>{
    const key = normalizeName(m.nombre);
    if (!jsonWktByNorm.has(key)) missingDb.push(m.nombre);
  });

  const missingJson = [];
  municipiosJson.forEach(m=>{
    const key = normalizeName(m.municipio);
    if (!municipioIdByNorm.has(key)) missingJson.push(m.municipio);
  });

  if (missingDb.length) console.warn('BD sin polígono (no match en JSON):', missingDb);
  if (missingJson.length) console.warn('JSON sin municipio en BD (no match BD):', missingJson);
  if (!missingDb.length && !missingJson.length) console.log('✅ Match BD <-> JSON perfecto');
}

function norm(s){
  return (s || '').toString().trim().toLowerCase();
}

function badge(text, cls){
  if (!text) return '';
  return `<span class="badge ${cls} me-1 mb-1">${text}</span>`;
}

function labelEscalaInfluencia(v) {
  if (!v) return '—';

  const mape = {
    municipal: 'Municipal',
    regional: 'Regional',
    distrital: 'Distrital',
    estatal: 'Estatal',
    nacional: 'Nacional'
  };

  return mape[String(v).toLowerCase()] || v;
}

function renderCards(list){
  const cont = document.getElementById('cardsContainer');
  cont.innerHTML = '';

  if (!list.length){
    cont.innerHTML = `<div class="alert alert-light border mb-0">No hay personas registradas para este municipio.</div>`;
    return;
  }

  cont.innerHTML = list.map(p => {
    const badges = [
      badge(p.oficina_nombre, 'text-bg-light'),
      badge(`Capturista: ${p.creado_por_nombre || '—'}`, 'text-bg-secondary'),
      (p.modificado_por_nombre ? badge(`Mod: ${p.modificado_por_nombre}`, 'text-bg-light') : '')
    ].filter(Boolean).join('');

    return `
      <div class="card mb-2 shadow-sm">
        <div class="card-body py-2">
          <div class="d-flex justify-content-between align-items-start gap-2">

            <div class="d-flex gap-2 min-w-0">
              <img
                src="${escAttr(p.foto_url || '/img/user.png')}"
                alt="foto"
                class="rounded"
                style="width:44px;height:44px;object-fit:cover"
              />

              <div class="min-w-0">
                <div class="fw-semibold text-truncate">${esc(p.nombre_completo || '—')}</div>
                <div class="small text-muted text-truncate">
                  ${esc(p.municipio_trabajo_politico || '—')}
                </div>
                <div class="mt-2 d-flex flex-wrap gap-1">${badges}</div>
              </div>
            </div>

            <div class="flex-shrink-0 d-flex gap-2">
              <button class="btn btn-outline-secondary btn-sm"
                      data-action="pdf"
                      data-id="${p.id_persona}">
                PDF
              </button>

              <button class="btn btn-outline-primary btn-sm"
                      data-action="ver"
                      data-id="${p.id_persona}">
                Ver
              </button>
              <button class="btn btn-outline-warning btn-sm" data-action="edit" data-id="${p.id_persona}">
                <i class="bi bi-pencil"></i>
              </button>
            </div>

          </div>
        </div>
      </div>
    `;
  }).join('');

    cont.querySelectorAll('button[data-action][data-id]').forEach(btn=>{
      btn.addEventListener('click', async (e)=>{
        e.preventDefault();

        const id = Number(btn.getAttribute('data-id'));
        const action = btn.getAttribute('data-action');

        if (!Number.isFinite(id) || id <= 0) {
          console.warn("Botón sin id válido:", action, btn.outerHTML);
          return;
        }

        if (action === 'ver') {
          await openPerfilModal(id);
          return;
        }

        if (action === 'pdf') {
          await generarPDFPersona(id);
          return;
        }

        if (action === 'edit') {
          await openEditPersonaModal(id);
          return;
        }

        if (action === 'del') {
          await confirmDeletePersona(id); // te dejo abajo esta función
          return;
        }
      });
    });
}
//GENERAR PDF
async function generarPDFPersona(idPersona){
  const token = localStorage.getItem("token");
  const res = await fetch(`/api/personas/${idPersona}/pdf`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  

  const blob = await res.blob();


  // lee los primeros bytes para ver si empieza con %PDF
  const ab = await blob.slice(0, 20).arrayBuffer();
  const head = new TextDecoder().decode(ab);


  if (res.status === 401) { localStorage.clear(); location.href='/'; return; }
  if (res.status === 403) { alert("No tienes permisos."); return; }
  if (!res.ok) { alert("No se pudo generar el PDF"); return; }

  const url = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener,noreferrer");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}


function applySearch(){
  const q = norm(document.getElementById('searchInput').value);
  const filtered = !q ? personasCache : personasCache.filter(p => norm(p.nombre).includes(q));
  document.getElementById('countBadge').textContent = filtered.length;
  renderCards(filtered);
}

async function loadPersonasByMunicipioId(idMunicipio){
  currentMunicipioTrabajoId = Number(idMunicipio) || null;  // ✅ guarda estado

  document.getElementById('countBadge').textContent = '...';

  const resp = await apiGet(`/personas/admin/cards?municipio_trabajo=${idMunicipio}&page=1&size=500`);
  personasCache = resp.data || [];
  document.getElementById('countBadge').textContent = String(resp?.total ?? personasCache.length);
  applySearch(); // mantiene tu filtro por texto
}

  (function guardDashboard() {
    const token = localStorage.getItem('token');
    const u = JSON.parse(localStorage.getItem('user') || '{}');
    const roles = u.roles || (u.rol ? [u.rol] : []);

if (!token || !(roles.includes('superadmin') || roles.includes('analista'))) {
  window.location.href = '/';
}
  })();

async function initDashboard(){
  // 1) cargar municipios de BD (nombres oficiales)
  municipiosDb = await apiGet('/municipios'); // /api/municipios
  municipiosDb.sort((a,b)=> a.nombre.localeCompare(b.nombre,'es',{sensitivity:'base'}));

  municipioIdByNorm = new Map();
  nombreById = new Map();
  municipiosDb.forEach(m=>{
    const key = normalizeName(m.nombre);
    municipioIdByNorm.set(key, m.id_municipio);
    nombreById.set(m.id_municipio, m.nombre);
  });

  // 2) cargar JSON de polígonos (WKT)
  const r = await fetch('/data/municipios.json'); // porque ya lo sirves desde public
  municipiosJson = await r.json();

  jsonWktByNorm = new Map();
  municipiosJson.forEach(m=>{
    const key = normalizeName(m.municipio);
    if (m.poligono) jsonWktByNorm.set(key, m.poligono);
  });

  // 3) construir lista unificada: BD + WKT
  const municipiosConPoligono = [];
  municipiosDb.forEach(m=>{
    const key = normalizeName(m.nombre);
    const wkt = jsonWktByNorm.get(key);
    if (wkt){
      municipiosConPoligono.push({
        id_municipio: m.id_municipio,
        nombre: m.nombre,
        wkt
      });
    }
  });

  debugMissingMatches();

  // 4) init map y dibujar
  initMap();
  drawMunicipios(municipiosConPoligono);
  await loadAndPaintMunicipioCoverage();

  // 5) llenar select desde BD
  const sel = document.getElementById('selMunicipio');
  fillSelectById(sel, municipiosDb);

  fillSelectMunicipios(document.getElementById('gridMunicipio'), municipiosDb);

  // 6) hook mapa -> select (por id)
  setOnMunicipioSelected((id_municipio)=>{
    sel.value = String(id_municipio);
    sel.dispatchEvent(new Event('change'));
  });

  // 7) select -> resaltar + (aquí luego cargas personas)
  sel.addEventListener('change', async ()=>{
    const id = Number(sel.value || 0);
    if (!id) return;

    document.getElementById('munTitle').textContent = nombreById.get(id) || 'Municipio';
    resaltarMunicipioById(id);
    await loadPersonasByMunicipioId(id);
    // aquí ya puedes cargar personas con tu endpoint:
    // const rows = await apiGet(`/personas?municipio_trabajo=${id}`);
    // ...
  });
    document.getElementById("btnResetMap")?.addEventListener("click", () => {
      // reset select
      const sel = document.getElementById("selMunicipio");
      if (sel) sel.value = "";

      // reset titulo
      const title = document.getElementById("munTitle");
      if (title) title.textContent = "Estado de México";

      // opcional: limpiar tarjetas
      const cont = document.getElementById("cardsContainer");
      if (cont) cont.innerHTML = `<div class="alert alert-light border mb-0">Selecciona un municipio para ver registros.</div>`;

      // reset mapa con cobertura
      resetMapCoverageView();
    });
  //buscador
  document.getElementById('searchInput').addEventListener('input', applySearch);
}

//modal perfil helpers
function esc(s){
  return (s ?? '').toString()
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#039;");
}

function badgeHtml(text, cls){
  if (!text) return '';
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}

function badgeResultadoEleccion(resultado){
  if (resultado === 'ganada') return `<span class="badge text-bg-success">Ganó</span>`;
  if (resultado === 'no_ganada') return `<span class="badge text-bg-secondary">No ganó</span>`;
  return `<span class="badge text-bg-light text-muted border">Sin dato</span>`;
}

function fmtNum(n){
  if (n === null || n === undefined || n === '') return '—';
  const x = Number(n);
  return Number.isFinite(x) ? x.toLocaleString('es-MX') : String(n);
}

function fmtPct(n){
  if (n === null || n === undefined || n === '') return '—';
  const x = Number(n);
  return Number.isFinite(x) ? `${x.toFixed(2)}%` : `${n}%`;
}

function fmtDate(d){
  if (!d) return '—';
  // si viene ISO: "2026-01-12T..." o "2026-01-12"
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return esc(d);
  return dt.toLocaleDateString('es-MX');
}

function listOrEmpty(arr){
  return Array.isArray(arr) ? arr : [];
}

function showPerfilState({loading=false, error=null}){
  const loader = document.getElementById('perfilLoader');
  const content = document.getElementById('perfilContent');
  const errBox = document.getElementById('perfilError');

  loader.classList.toggle('d-none', !loading);
  content.classList.toggle('d-none', loading || !!error);

  if (error){
    errBox.classList.remove('d-none');
    errBox.textContent = error;
  } else {
    errBox.classList.add('d-none');
    errBox.textContent = '';
  }
}

function renderSimpleList(items, renderRow){
  if (!items.length) return `<div class="text-muted small">—</div>`;
  return `<div class="vstack gap-2">${items.map(renderRow).join('')}</div>`;
}

async function openPerfilModal(idPersona){
  const el = document.getElementById('perfilModal');
  if (!perfilModalInstance) perfilModalInstance = new bootstrap.Modal(el);
  perfilModalInstance.show();

  // estado inicial
  document.getElementById('perfilModalTitle').textContent = 'Perfil';
  document.getElementById('perfilModalSubtitle').textContent = '';
  document.getElementById('perfilBadges').innerHTML = '';
  showPerfilState({loading:true, error:null});

  try {
      const p = await apiGet(`/personas/${idPersona}/perfil`);
      
    // Nombre completo
    const nombreCompleto = [p.nombre, p.apellido_paterno, p.apellido_materno].filter(Boolean).join(' ');
    document.getElementById('perfilModalTitle').textContent = nombreCompleto || 'Perfil';

    // Municipio subtitle (prioridad: trabajo > real > legal)
    const mun = p.municipio_trabajo_politico || p.municipio_residencia_real || p.municipio_residencia_legal || '—';
    document.getElementById('perfilModalSubtitle').textContent = `• ${mun}`;

    // Badges principales
    const partido = p.partido_actual_siglas || p.partido_actual || null;

    const badgesPerfil = [
      badgeHtml(p.grupo_postulacion, 'text-bg-info'),
      badgeHtml(partido, 'text-bg-dark'),
      badgeHtml(p.ideologia_politica, 'text-bg-secondary'),
      badgeHtml(p.tema_interes_central, 'text-bg-warning'),
      (p.sin_controversias_publicas === true ? badgeHtml('Sin controversias', 'text-bg-success') : '')
    ].filter(Boolean).join(' ');

    // Badges meta (captura/modificación)


    // Render final
    document.getElementById('perfilBadges').innerHTML = `
      <div class="d-flex flex-wrap gap-1">
        ${badgesPerfil || `<span class="text-muted small">—</span>`}
      </div>
    `;

    function fmtDateMX(dt) {
      if (!dt) return '—';
      const d = new Date(dt);
      if (Number.isNaN(d.getTime())) return '—';
      return new Intl.DateTimeFormat('es-MX', {
        dateStyle: 'medium',
        timeStyle: 'short'
      }).format(d);
    }

    const metaParts = [
      `Oficina: <b>${esc(p.oficina_nombre || '—')}</b>`,
      `Capturó: <b>${esc(p.creado_por_nombre || '—')}</b>`,
      `Creado: <b>${fmtDateMX(p.created_at)}</b>`,
      (p.modificado_por_nombre ? `Modificó: <b>${esc(p.modificado_por_nombre)}</b>` : null),
      `Actualizado: <b>${fmtDateMX(p.updated_at)}</b>`
    ].filter(Boolean);

    document.getElementById('perfilMeta').innerHTML = metaParts.join(' &nbsp;•&nbsp; ');

    // Tab controversias: disable si aplica (con guard)
    const tabCont = document.getElementById('tab-controversias');
    if (tabCont) {
      if (p.sin_controversias_publicas === true) {
        tabCont.classList.add('disabled');
        tabCont.setAttribute('tabindex', '-1');
        tabCont.setAttribute('aria-disabled', 'true');
      } else {
        tabCont.classList.remove('disabled');
        tabCont.removeAttribute('tabindex');
        tabCont.removeAttribute('aria-disabled');
      }
    }

    // General
    setText('v_curp',  p.curp);
    setText('v_rfc',   p.rfc);
    setText('v_clave', p.clave_elector);
    setText('v_ecivil', p.estado_civil);

    setText('v_mun_legal', p.municipio_residencia_legal);
    setText('v_mun_real',  p.municipio_residencia_real);
    setText('v_mun_trab',  p.municipio_trabajo_politico);

    // Flags
    const flags = [];
    if (p.sin_servicio_publico === true) flags.push(badgeHtml('Sin servicio público', 'text-bg-secondary'));
    if (p.ha_contendido_eleccion === true) flags.push(badgeHtml('Ha contendió elección', 'text-bg-primary'));
    if (p.sin_controversias_publicas === true) flags.push(badgeHtml('Sin controversias públicas', 'text-bg-success'));
    document.getElementById('v_flags').innerHTML = flags.join(' ') || `<span class="text-muted small">—</span>`;

    // INE
    setText('v_ine_seccion', p?.datos_ine?.seccion_electoral);
    setText('v_ine_df',      p?.datos_ine?.distrito_federal);
    setText('v_ine_dl',      p?.datos_ine?.distrito_local);

    // Teléfonos
    const tels = listOrEmpty(p.telefonos);
    document.getElementById('v_telefonos').innerHTML = renderSimpleList(tels, (t) => {
      const tipo = t.tipo ? `<span class="text-muted small">(${esc(t.tipo)})</span>` : '';
      const pri = t.principal ? `<span class="badge text-bg-success ms-2">Principal</span>` : '';
      return `
        <div class="border rounded p-2">
          <div class="d-flex align-items-center justify-content-between gap-2">
            <div class="fw-semibold">${esc(t.telefono || '—')} ${tipo}</div>
            <div>${pri}</div>
          </div>
        </div>
      `;
    });

    // Formación
    const fa = listOrEmpty(p.formacion_academica);
    document.getElementById('v_formacion').innerHTML = renderSimpleList(fa, (x) => {
      const line1 = [x.nivel, x.grado_obtenido || x.grado].filter(Boolean).join(' • ');
      const inst = x.institucion ? `<div class="text-muted small">${esc(x.institucion)}</div>` : '';
      const years = (x.anio_inicio || x.anio_fin) ? `<div class="text-muted small">${esc(x.anio_inicio || '—')} - ${esc(x.anio_fin || '—')}</div>` : '';
      const tit = (x.titulado === true) ? `<span class="badge text-bg-success mt-1">Titulado</span>` : '';
      return `
        <div class="border rounded p-2">
          <div class="fw-semibold">${esc(line1 || '—')}</div>
          ${inst}
          ${years}
          ${tit}
        </div>
      `;
    });

    // Redes
    const redes = listOrEmpty(p.redes_sociales);
    document.getElementById('v_redes').innerHTML = renderSimpleList(redes, (r) => {
      const url = r.url ? `<a href="${escAttr(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a>` : '—';
      return `
        <div class="border rounded p-2">
          <div class="fw-semibold">${esc(r.red || '—')}</div>
          <div class="small">${url}</div>
        </div>
      `;
    });

    // Temas de interés
    const temas = listOrEmpty(p.temas_interes);
    setHtmlIfExists('v_temas_interes', renderSimpleList(temas, (t) => {
      const head = t.tema ? esc(t.tema) : (t.id_tema ? `Tema #${esc(t.id_tema)}` : 'Tema');
      const otro = t.otro_texto ? `<div class="text-muted small">${esc(t.otro_texto)}</div>` : '';
      return `
        <div class="border rounded p-2">
          <div class="fw-semibold">${head}</div>
          ${otro}
        </div>
      `;
    }) || `<span class="text-muted small">—</span>`);
    // Cargos elección popular
    const cargosEP = listOrEmpty(p.cargos_eleccion_popular);
    setHtmlIfExists('v_cargos_ep', renderSimpleList(cargosEP, (c) => {
      const head = esc(c.cargo || '—');
      const meta = [c.periodo, c.modalidad, c.partido_postulante].filter(Boolean).map(esc).join(' • ');
      return `
        <div class="border rounded p-2">
          <div class="fw-semibold">${head}</div>
          ${meta ? `<div class="text-muted small">${meta}</div>` : ''}
        </div>
      `;
    }) || `<span class="text-muted small">—</span>`);

    // Eventos movilización (lista)
    const eventos = listOrEmpty(p.capacidad_movilizacion_eventos);
    setHtmlIfExists('v_eventos_movilizacion', renderSimpleList(eventos, (e) => {
      const head = esc(e.nombre_evento || '—');
      const meta = [e.fecha_evento, e.asistencia != null ? `Asistencia: ${e.asistencia}` : null]
        .filter(Boolean).map(esc).join(' • ');
      return `
        <div class="border rounded p-2">
          <div class="fw-semibold">${head}</div>
          ${meta ? `<div class="text-muted small">${meta}</div>` : ''}
        </div>
      `;
    }) || `<span class="text-muted small">—</span>`);

    // Experiencia laboral
    const exp = listOrEmpty(p.experiencia_laboral);
    setHtmlIfExists('v_experiencia', renderSimpleList(exp, (x) => {
      const head = esc(x.cargo || '—');
      const org  = x.organizacion ? `<div class="text-muted small">${esc(x.organizacion)}</div>` : '';
      const per  = x.periodo ? `<div class="text-muted small">${esc(x.periodo)}</div>` : '';
      return `
        <div class="border rounded p-2">
          <div class="fw-semibold">${head}</div>
          ${org}
          ${per}
        </div>
      `;
    }) || `<span class="text-muted small">—</span>`);

    // Participación
    const po = listOrEmpty(p.participacion_organizaciones);
    document.getElementById('v_participacion').innerHTML = renderSimpleList(po, (o) => {
      const top = `${o.tipo ? esc(o.tipo) + ': ' : ''}${esc(o.nombre || '—')}`;
      const meta = [o.rol, o.periodo].filter(Boolean).map(esc).join(' • ');
      const notas = o.notas ? `<div class="text-muted small">${esc(o.notas)}</div>` : '';
      return `
        <div class="border rounded p-2">
          <div class="fw-semibold">${top}</div>
          ${meta ? `<div class="text-muted small">${meta}</div>` : ''}
          ${notas}
        </div>
      `;
    });

    // Controversias
    if (p.sin_controversias_publicas === true) {
      document.getElementById('v_controversias').innerHTML =
        `<div class="alert alert-success mb-0 py-2">Marcado como <strong>Sin controversias públicas</strong>.</div>`;
    } else {
      const conv = listOrEmpty(p.controversias);
      document.getElementById('v_controversias').innerHTML = renderSimpleList(conv, (c) => {
        const head = c.tipo ? esc(c.tipo) : `Tipo #${esc(c.id_tipo || '—')}`;
        const meta = [c.estatus, c.fecha_registro].filter(Boolean).map(esc).join(' • ');
        const fuente = c.fuente ? `<div class="small"><span class="text-muted">Fuente:</span> ${esc(c.fuente)}</div>` : '';
        const desc = c.descripcion ? `<div class="small">${esc(c.descripcion)}</div>` : '';
        return `
          <div class="border rounded p-2">
            <div class="fw-semibold">${head}</div>
            ${meta ? `<div class="text-muted small">${meta}</div>` : ''}
            ${fuente}
            ${desc}
          </div>
        `;
      });
    }

    // Parejas + Hijos (usa periodo)
    const parejas = listOrEmpty(p.parejas);
    document.getElementById('v_parejas').innerHTML = renderSimpleList(parejas, (pa) => {
      const head = [pa.nombre_pareja, pa.tipo_relacion].filter(Boolean).map(esc).join(' • ') || '—';
      const periodo = pa.periodo ? `<div class="text-muted small">${esc(pa.periodo)}</div>` : '';

      const hijos = listOrEmpty(pa.hijos);
      const hijosHtml = hijos.length
        ? `<div class="mt-2">
            <div class="small text-muted mb-1">Hijos</div>
            ${hijos.map(h => `
              <div class="border rounded p-2 mb-2">
                <div class="d-flex gap-2 flex-wrap align-items-center">
                  <span class="fw-semibold">${esc(h.sexo || '—')}</span>
                  <span class="text-muted small">Año: ${esc(h.anio_nacimiento || '—')}</span>
                </div>
              </div>
            `).join('')}
          </div>`
        : `<div class="small text-muted mt-2">Sin hijos registrados</div>`;

      return `
        <div class="border rounded p-2">
          <div class="fw-semibold">${head}</div>
          ${periodo}
          ${hijosHtml}
        </div>
      `;
    });

    // Servicio público
    const sp = listOrEmpty(p.servicio_publico);
    document.getElementById('v_servicio_publico').innerHTML = renderSimpleList(sp, (s) => {
      const head = esc(s.cargo || '—');
      const dep  = s.dependencia ? `<div class="text-muted small">${esc(s.dependencia)}</div>` : '';
      const per  = s.periodo ? `<div class="text-muted small">${esc(s.periodo)}</div>` : '';
      return `
        <div class="border rounded p-2">
          <div class="fw-semibold">${head}</div>
          ${dep}
          ${per}
        </div>
      `;
    });

    // Elecciones
    const elx = listOrEmpty(p.elecciones);
    document.getElementById('v_elecciones').innerHTML = renderSimpleList(elx, (e) => {
      const head = [e.anio_eleccion, e.candidatura].filter(Boolean).map(esc).join(' • ') || '—';
      const partidoP = e.partido_postulacion ? `<span class="text-muted small">${esc(e.partido_postulacion)}</span>` : '';
      const badge = badgeResultadoEleccion(e.resultado);

      const diff = (e.diferencia_votos || e.diferencia_porcentaje)
        ? `<div class="text-muted small">Diferencia: ${fmtNum(e.diferencia_votos)} votos • ${fmtPct(e.diferencia_porcentaje)}</div>`
        : '';

      return `
        <div class="border rounded p-2">
          <div class="d-flex justify-content-between align-items-start gap-2">
            <div>
              <div class="fw-semibold">${head}</div>
              ${partidoP ? `<div>${partidoP}</div>` : ''}
              ${diff}
            </div>
            <div>${badge}</div>
          </div>
        </div>
      `;
    });

    // Capacidad movilización


    // Equipos
    const equipos = listOrEmpty(p.equipos);
    document.getElementById('v_equipos').innerHTML = renderSimpleList(equipos, (eq) => {
      const activo = (eq.activo === true)
        ? `<span class="badge text-bg-success ms-2">Activo</span>`
        : `<span class="badge text-bg-secondary ms-2">Inactivo</span>`;
      return `
        <div class="border rounded p-2 d-flex align-items-center justify-content-between">
          <div class="fw-semibold">${esc(eq.nombre_equipo || '—')}</div>
          <div>${activo}</div>
        </div>
      `;
    });

    // Referentes (CORREGIDO)
    const refs = listOrEmpty(p.referentes);
    document.getElementById('v_referentes').innerHTML = renderSimpleList(refs, (r) => {
      const nombreRef = [r.nombres, r.apellido_paterno, r.apellido_materno].filter(Boolean).map(esc).join(' ') || '—';
      const lvl  = r.nivel ? `<span class="badge text-bg-info ms-2">${esc(r.nivel)}</span>` : '';
      return `
        <div class="border rounded p-2">
          <div class="d-flex align-items-center flex-wrap gap-2">
            <div class="fw-semibold">${nombreRef}</div>
            ${lvl}
          </div>
        </div>
      `;
    });

    // Familiares
    const fam = listOrEmpty(p.familiares);
    document.getElementById('v_familiares').innerHTML = renderSimpleList(fam, (f) => {
      const head = [f.nombre, f.parentesco].filter(Boolean).map(esc).join(' • ') || '—';
      const meta = [f.cargo, f.institucion].filter(Boolean).map(esc).join(' • ');
      return `
        <div class="border rounded p-2">
          <div class="fw-semibold">${head}</div>
          ${meta ? `<div class="text-muted small">${meta}</div>` : ''}
        </div>
      `;
    });

    showPerfilState({loading:false, error:null});
  } catch (err) {
    console.error(err);
    showPerfilState({loading:false, error:'No pude cargar el perfil. ' + (err.message || '')});
  }
}

// helper para setText con fallback
function setText(id, value){
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = (value === undefined || value === null || value === '') ? '—' : String(value);
}


//Inicializar Tabulator (modo remoto)
function initPersonasGrid() {
  const el = document.getElementById('gridPersonas');
  if (!el) return;

  // Si el grid está dentro de un tab/pane oculto, NO inicialices aún
  const pane = document.getElementById('pane-grid'); // ajusta si tu id es otro
  const isHidden = pane && pane.offsetParent === null;

  if (isHidden) {
    document.getElementById('tab-grid')?.addEventListener(
      'shown.bs.tab',
      () => {
        initPersonasGrid();
        if (window.personasGrid) {
          window.personasGrid.redraw(true);
          window.personasGrid.setData();
        }
      },
      { once: true }
    );
    return;
  }

  if (window.personasGrid) {
    window.personasGrid.destroy();
    window.personasGrid = null;
  }

  window.personasGrid = new Tabulator(el, {
    layout: "fitColumns",
    height: "70vh",
    responsiveLayout: "collapse",
    placeholder: "Sin registros",
    responsiveLayoutCollapseStartOpen: false,

    responsiveLayoutCollapseFormatter: (data) => {
      const wrap = document.createElement("div");
      wrap.className = "p-2";

      const safe = (v) => {
        if (v === null || v === undefined) return "—";
        if (typeof v === "string") return v;
        if (typeof v === "number" || typeof v === "boolean") return String(v);
        try { return JSON.stringify(v); } catch { return String(v); }
      };

      const labelMap = {
        oficina_nombre: "Oficina",
        creado_por_nombre: "Capturó",
        creado_por_email: "Correo",
        modificado_por_nombre: "Modificó",
        municipio_trabajo_nombre: "Municipio",
        telefono_principal: "Teléfono",
        created_at: "Creado",
        updated_at: "Actualizado",
        curp: "CURP",
        rfc: "RFC",
        clave_elector: "Clave elector",
      };

      Object.entries(data).forEach(([k, v]) => {
        let val = v;
        if ((k === "created_at" || k === "updated_at") && typeof fmtDate === "function") val = fmtDate(v);

        const row = document.createElement("div");
        row.className = "small mb-1";

        const label = document.createElement("strong");
        label.textContent = (labelMap[k] || k) + ": ";

        const value = document.createElement("span");
        value.textContent = safe(val);

        row.appendChild(label);
        row.appendChild(value);
        wrap.appendChild(row);
      });

      return wrap;
    },

    pagination: true,
    paginationMode: "remote",
    paginationSize: gridState.pageSize,
    paginationSizeSelector: [10, 25, 50, 100],

    ajaxURL: "/api/personas/admin/grid",
    ajaxConfig: { method: "GET" },

    ajaxRequestFunc: async (url, config, params) => {
      const page = params.page || 1;
      const size = params.size || gridState.pageSize;

      // sorters de Tabulator
      let sortField = "updated_at";
      let sortDir = "desc";
      if (Array.isArray(params.sorters) && params.sorters.length) {
        sortField = params.sorters[0].field || sortField;
        sortDir = params.sorters[0].dir || sortDir;
      }

      const qs = new URLSearchParams();
      qs.set("page", String(page));
      qs.set("size", String(size));
      qs.set("sortField", sortField);
      qs.set("sortDir", sortDir);

      // 🔎 filtros UI (ajusta si tu gridState usa otros nombres)
      if (gridState.oficinaId) qs.set("oficinaId", String(gridState.oficinaId));
      if (gridState.capturistaId) qs.set("capturistaId", String(gridState.capturistaId));
      if (gridState.municipio_trabajo) qs.set("municipio_trabajo", String(gridState.municipio_trabajo));
      if (gridState.q) qs.set("q", gridState.q);

      return apiGet(`/personas/admin/grid?${qs.toString()}`);
    },

    ajaxResponse: (url, params, resp) => {
      // backend: { data, total, page, size, last_page }
      return {
        data: resp.data || [],
        last_page: resp.last_page || 1,
        total_records: resp.total || 0,
      };
    },

    columns: [
      {
        title: "Nombre",
        field: "nombre_completo",
        minWidth: 260,
        responsive: 0,
        headerSort: true,
        formatter: (cell) => {
          const r = cell.getRow().getData();
          const muni = r.municipio_trabajo_nombre || "—";
          const tel = r.telefono_principal || "—";
          return `
            <div class="min-w-0">
              <div class="fw-semibold text-truncate">${esc(r.nombre_completo || "—")}</div>
              <div class="small text-muted text-truncate">${esc(muni)} • Tel: ${esc(tel)}</div>
            </div>
          `;
        }
      },
      {
        title: "Oficina",
        field: "oficina_nombre",
        width: 220,
        minWidth: 180,
        responsive: 2,
        headerSort: false,
        formatter: (cell) => esc(cell.getValue() || "—")
      },
      {
        title: "Capturó",
        field: "creado_por_nombre",
        width: 220,
        minWidth: 180,
        responsive: 1,
        headerSort: false,
        formatter: (cell) => {
          const r = cell.getRow().getData();
          const name = r.creado_por_nombre || "—";
          const email = r.creado_por_email || "";
          return `
            <div class="min-w-0">
              <div class="text-truncate">${esc(name)}</div>
              <div class="small text-muted text-truncate">${email ? esc(email) : "—"}</div>
            </div>
          `;
        }
      },
      {
        title: "Actualizado",
        field: "updated_at",
        width: 150,
        minWidth: 140,
        responsive: 4,
        headerSort: true,
        formatter: (cell) => fmtDate(cell.getValue())
      },
      {
        title: "",
        field: "_actions",
        width: 110,
        minWidth: 110,
        frozen: true,
        headerSort: false,
        hozAlign: "right",
        responsive: 0,
        formatter: () => `<button type="button" class="btn btn-outline-primary btn-sm">Ver</button>`,
        cellClick: (e, cell) => {
          const r = cell.getRow().getData();
          const id = Number(r.id_persona);
          if (Number.isFinite(id)) openPerfilModal(id);
          if (act === "edit") return openEditPersonaModal(id);
        }
      }
    ],
  });

  requestAnimationFrame(() => {
    if (window.personasGrid) window.personasGrid.setData();
  });

  document.getElementById('tab-grid')?.addEventListener('shown.bs.tab', () => {
    if (window.personasGrid) window.personasGrid.redraw(true);
  });
}


//Wire-up de filtros (usuario + búsqueda + pageSize)

function refreshGridSafe() {
  // Si aún no existe el grid, no hagas nada (ya se cargará al abrir tab)
  if (!window.personasGrid) return;

  // Si existe, refresca remoto
  window.personasGrid.setData();
}

function initGridFilters() {
  const selOficina    = document.getElementById('filtroOficina');
  const selCapturista = document.getElementById('filtroCapturista');

  const inpSearch   = document.getElementById('gridSearch');
  const selPageSize = document.getElementById('gridPageSize');
  const selGridMun  = document.getElementById('gridMunicipio');

  if (selGridMun) {
    selGridMun.addEventListener('change', () => {
      gridState.municipio_trabajo = selGridMun.value || '';
      refreshGridSafe();
    });
  }

  // ✅ Oficina → recarga capturistas
  if (selOficina) {
    selOficina.addEventListener('change', async () => {
      const oficinaId = selOficina.value || '';
      gridState.oficinaId = oficinaId;

      // reset capturista al cambiar oficina
      gridState.capturistaId = '';
      if (selCapturista) selCapturista.value = '';

      await loadCapturistasByOficinaFiltro(oficinaId);
      refreshGridSafe();
    });
  }

  // ✅ Capturista
  if (selCapturista) {
    selCapturista.addEventListener('change', () => {
      gridState.capturistaId = selCapturista.value || '';
      refreshGridSafe();
    });
  }

  // ✅ Page size
  if (selPageSize) {
    selPageSize.addEventListener('change', () => {
      const n = Number(selPageSize.value);
      gridState.pageSize = Number.isFinite(n) ? n : 25;

      if (window.personasGrid) {
        window.personasGrid.setPageSize(gridState.pageSize);
        window.personasGrid.setData();
      }
    });
  }

  // ✅ Search debounce
  if (inpSearch) {
    const onSearch = debounce(() => {
      gridState.q = (inpSearch.value || '').trim();
      refreshGridSafe();
    }, 300);
    inpSearch.addEventListener('input', onSearch);
  }

  // ✅ Al abrir tab grid: init + redraw + cargar
  document.getElementById('tab-grid')?.addEventListener('shown.bs.tab', () => {
    const sel = document.getElementById('gridMunicipio');
    gridState.municipio_trabajo = sel ? (sel.value || '') : '';

    if (!window.personasGrid) initPersonasGrid();

    if (window.personasGrid) {
      requestAnimationFrame(() => {
        window.personasGrid.redraw(true);
        window.personasGrid.setData();
      });
    }
  });
}




async function initAdminDatagrid() {
  // 1) Oficinas
  await loadOficinasFiltro();

  // 2) Capturistas inicial (según oficina seleccionada)
  const selOfi = document.getElementById('filtroOficina');
  const oficinaIdInit = selOfi ? (selOfi.value || '') : '';
  await loadCapturistasByOficinaFiltro(oficinaIdInit);

  // 3) listeners
  initGridFilters();

  // 4) si el tab grid ya está activo
  const paneGrid = document.getElementById('pane-grid');
  if (paneGrid?.classList.contains('active') || paneGrid?.classList.contains('show')) {
    initPersonasGrid();
    requestAnimationFrame(() => window.personasGrid?.setData());
  }
}


function fillSelectMunicipios(selectEl, municipios) {
  if (!selectEl) return;
  const current = selectEl.value || '';
  selectEl.innerHTML = `<option value="">Todos</option>` +
    municipios.map(m => `<option value="${m.id_municipio}">${esc(m.nombre)}</option>`).join('');
  if (current) selectEl.value = current;
}

//oficina filtro

async function loadOficinasFiltro() {
  const sel = document.getElementById('filtroOficina');
  if (!sel) return;

  sel.innerHTML = `<option value="">Todas</option>`;

  const oficinas = await apiGet('/personas/admin/oficinas'); // [{id_oficina,nombre},...]
  (oficinas || []).forEach(o => {
    const opt = document.createElement('option');
    opt.value = String(o.id_oficina);
    opt.textContent = o.nombre;
    sel.appendChild(opt);
  });
}

async function loadCapturistasByOficinaFiltro(oficinaId) {
  const sel = document.getElementById('filtroCapturista');
  if (!sel) return;

  sel.innerHTML = `<option value="">Todos</option>`;

  const qs = new URLSearchParams();
  if (oficinaId) qs.set('oficinaId', String(oficinaId));

  const capturistas = await apiGet(`/personas/admin/capturistas?${qs.toString()}`);
  (capturistas || []).forEach(u => {
    const opt = document.createElement('option');
    opt.value = String(u.id_usuario);
    opt.textContent = `${u.nombre} — ${u.email || ''}`.trim();
    sel.appendChild(opt);
  });
}
//kpi completitud

function fmtPct(n) {
  if (n == null || isNaN(n)) return "—";
  return `${Number(n).toFixed(2)}%`;
}
function fmtNum(n) {
  if (n == null || isNaN(n)) return "—";
  return String(n);
}

async function loadKpisCompletitud() {
  // Endpoint nuevo
  const data = await apiGet("/personas/admin/kpis/completitud");
  const g = data?.global || {};
  const users = data?.por_usuario || [];

  // KPIs
  document.getElementById("kpiTotal").textContent = fmtNum(g.total_personas);
  document.getElementById("kpiAvg").textContent = (g.score_promedio != null ? Number(g.score_promedio).toFixed(2) : "—");
  document.getElementById("kpiPct80").textContent = fmtPct(g.pct_completos_80);
  document.getElementById("kpiCompletos80").textContent = fmtNum(g.completos_80);
  document.getElementById("kpiCrit").textContent = fmtNum(g.criticos_lt50);

  // Label detalle dona
  const incompletos = (g.total_personas || 0) - (g.completos_80 || 0);
  document.getElementById("lblCompletoDetail").textContent =
    `Completos: ${fmtNum(g.completos_80)} | Incompletos: ${fmtNum(incompletos)} | Total: ${fmtNum(g.total_personas)}`;

  // Chart: dona completitud global
  const ctx1 = document.getElementById("chartCompleto");
  if (chartCompleto) chartCompleto.destroy();

  chartCompleto = new Chart(ctx1, {
    type: "doughnut",
    data: {
      labels: ["Completos (≥80)", "Incompletos"],
      datasets: [{
        data: [g.completos_80 || 0, incompletos || 0]
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: "bottom" },
        tooltip: { enabled: true }
      }
    }
  });

  // Chart: barras % completos por usuario (Top 10)
  const top = [...users].slice(0, 10);
  const labels = top.map(u => u.nombre || u.email || `Usuario ${u.id_usuario}`);
  const pct = top.map(u => Number(u.pct_completos_80 || 0));

  const ctx2 = document.getElementById("chartUsuarios");
  if (chartUsuarios) chartUsuarios.destroy();

  chartUsuarios = new Chart(ctx2, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "% completos ≥80",
        data: pct
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { beginAtZero: true, max: 100 }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => `${Number(c.raw).toFixed(2)}%`
          }
        }
      }
    }
  });

  // Tabla detalle
  const tbody = document.getElementById("tblUsuariosKpi");
  if (!users.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-muted">Sin datos</td></tr>`;
    return;
  }

  tbody.innerHTML = users.map(u => {
    const nombre = (u.nombre || u.email || `Usuario ${u.id_usuario}`);
    const score = (u.score_promedio != null ? Number(u.score_promedio).toFixed(2) : "—");
    const pct80 = (u.pct_completos_80 != null ? `${Number(u.pct_completos_80).toFixed(2)}%` : "—");
    return `
      <tr>
        <td class="text-truncate" style="max-width: 420px;">
          <div class="fw-semibold">${nombre}</div>
          <div class="text-muted small">${u.email || ""}</div>
        </td>
        <td class="text-end">${u.total ?? "—"}</td>
        <td class="text-end">${score}</td>
        <td class="text-end">${pct80}</td>
        <td class="text-end">${u.completos_80 ?? "—"}</td>
      </tr>
    `;
  }).join("");
}

function initKpisUI() {
  document.getElementById("btnRefreshKpis")?.addEventListener("click", () => {
    loadKpisMunicipios().catch(err => {
      console.error(err);
      alert("No se pudieron cargar los KPIs: " + (err.message || err));
    });

    loadKpisCompletitud().catch(err => {
      console.error(err);
      alert("No se pudieron cargar los KPIs: " + (err.message || err));
    });

  });

  // Carga inicial
  loadKpisCompletitud().catch(err => {
    console.error(err);
    alert("No se pudieron cargar los KPIs: " + (err.message || err));
  });
}

//kpi municipios con o sin actores municipio_trabajo_politico

async function loadKpisMunicipios() {
  const data = await apiGet("/personas/admin/kpis/municipios");
  const r = data?.resumen || {};
  const top10 = data?.top10 || [];
  const bottom10 = data?.bottom10 || [];
  const cero = data?.cero || [];

  // Resumen textual
  const lbl = document.getElementById("lblMunResumen");
  if (lbl) {
    lbl.textContent = `Municipios: ${r.total_municipios ?? "—"} | Con registros: ${r.municipios_con_registros ?? "—"} | Sin registros: ${r.municipios_sin_registros ?? "—"} | Total actores: ${r.total_personas ?? "—"}`;
  }

  // Badge de cero
  const badge = document.getElementById("badgeMunCero");
  if (badge) badge.textContent = (r.municipios_sin_registros ?? cero.length ?? "—");

  // Chart Top 10
  const labels = top10.map(x => x.municipio);
  const values = top10.map(x => Number(x.total || 0));

  const c = document.getElementById("chartMunicipiosTop");
  if (c) {
    if (chartMunTop) chartMunTop.destroy();
    chartMunTop = new Chart(c, {
      type: "bar",
      data: {
        labels,
        datasets: [{ label: "Actores", data: values }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true } }
      }
    });
  }

  // Tabla municipios cero
  const tbCero = document.getElementById("tblMunCero");
  if (tbCero) {
    if (!cero.length) {
      tbCero.innerHTML = `<tr><td class="text-muted">Sin municipios en cero 🎉</td></tr>`;
    } else {
      tbCero.innerHTML = cero.map(m => `<tr><td>${m.municipio}</td></tr>`).join("");
    }
  }

  // Tabla bottom 10
  const tbBottom = document.getElementById("tblMunBottom");
  if (tbBottom) {
    if (!bottom10.length) {
      tbBottom.innerHTML = `<tr><td colspan="2" class="text-muted">Sin datos</td></tr>`;
    } else {
      tbBottom.innerHTML = bottom10.map(m => `
        <tr>
          <td>${m.municipio}</td>
          <td class="text-end">${m.total}</td>
        </tr>
      `).join("");
    }
  }
}

//map vs kpi
async function loadAndPaintMunicipioCoverage(){
  // endpoint KPI (debe traer conteo completo o al menos top/bottom/cero)
  const data = await apiGet("/personas/admin/kpis/municipios");

  // Ideal: que el endpoint regrese "conteo" con TODOS.
  // Si aún no lo tienes, te digo cómo ajustarlo.
  const conteo = data?.conteo || [];

  // Si no hay conteo completo, no podemos pintar todos.
  if (!conteo.length) {
    console.warn("KPI municipios: no viene 'conteo' completo. Ajusta endpoint para incluirlo.");
    return;
  }

  // Construye Map id->total
  const countsMap = new Map(conteo.map(x => [Number(x.id_municipio), Number(x.total || 0)]));

  // Esta función está en map.js
  setMunicipioCoverageCounts(countsMap);
}

//edicion abri modal 
let currentEditId = null;

// helpers
function fillSelect(el, rows, valueKey, textKey, placeholder = 'Seleccione') {
  if (!el) return;
  el.innerHTML = `<option value="">${placeholder}</option>`;
  (rows || []).forEach(r => {
    const opt = document.createElement('option');
    opt.value = r[valueKey];
    opt.textContent = r[textKey];
    el.appendChild(opt);
  });
}

function setFormDisabled(form, disabled){
  if (!form) return;
  [...form.elements].forEach(el => el.disabled = disabled);
}

// ✅ crea los checks dentro del root (modal)
function renderTemasChecks(root, temas){
  const wrap = root.querySelector('#temasInteresChecks');
  if (!wrap) return;

  wrap.innerHTML = '';
  (temas || []).forEach(t => {
    const id = Number(t.id_tema);
    const div = document.createElement('div');
    div.className = 'form-check';

    div.innerHTML = `
      <input class="form-check-input tema-interes-chk" type="checkbox" data-id="${id}" id="tema_${id}">
      <label class="form-check-label" for="tema_${id}">
        ${t.nombre}
      </label>
    `;

    wrap.appendChild(div);
  });
}
// cache global de catálogos (para no pedirlos cada vez)
let _sharedEdit = null;

function ensureShared(){
  if (_sharedEdit) return _sharedEdit;

  const modalEl = document.getElementById("editPersonaModal");
  if (!modalEl) throw new Error("No existe #editPersonaModal");

  // PersonaShared debe venir de /static/js/persona.shared.js
  if (!window.PersonaShared || typeof window.PersonaShared.init !== "function") {
    throw new Error("PersonaShared no está cargado. Revisa <script src='/static/js/persona.shared.js'> y el orden.");
  }

  _sharedEdit = window.PersonaShared.init({
    root: modalEl,
    catalogs: {
      municipios: window.municipiosCache || [],
      redes: window.redesCatalog || [],
      controversias: window.controversiasCatalog || [],
      temas: window.temasCatalog || [],
      partidos: window.partidosCatalog || [],
      ideologias: window.ideologiasCatalog || [],
      grupos: window.gruposCatalog || [],
    }
  });

  return _sharedEdit;
}

let _catsEdit = null;

async function ensureCatalogosEdicion(){
  if (_catsEdit) return _catsEdit;

  // Ajusta estas rutas según TU apiGet (si ya agrega /api o no)
  // Si apiGet ya prefija "/api", entonces aquí NO pongas "/api"
  const [
    redes,
    controversias,
    temas,
    partidos,
    ideologias,
    grupos,
    municipios
  ] = await Promise.all([
    apiGet('/catalogos/redes'),
    apiGet('/catalogos/controversias'),
    apiGet('/catalogos/temas-interes'),
    apiGet('/catalogos/partidos'),
    apiGet('/catalogos/ideologias'),
    apiGet('/catalogos/grupos-postulacion'),
    apiGet('/municipios'), // 👈 tu router municipios es /api/municipios (si apiGet agrega /api)
  ]);

  _catsEdit = { redes, controversias, temas, partidos, ideologias, grupos, municipios };
  return _catsEdit;
}

async function openEditPersonaModal(idPersona){
  const id = Number(idPersona);
  if (!Number.isFinite(id) || id <= 0) return;

  currentEditId = id;

  const modalEl = document.getElementById("editPersonaModal");
  const formEl  = modalEl?.querySelector("#personaForm");
  if (!modalEl || !formEl) return;

  setFormDisabled(formEl, true);

  try{
    const cats = await ensureCatalogosEdicion();

    // --- llena selects ANTES de aplicar payload ---
    fillSelect(modalEl.querySelector('#mun_legal'),   cats.municipios, 'id_municipio', 'nombre', 'Seleccione');
    fillSelect(modalEl.querySelector('#mun_real'),    cats.municipios, 'id_municipio', 'nombre', 'Seleccione');
    fillSelect(modalEl.querySelector('#mun_trabajo'), cats.municipios, 'id_municipio', 'nombre', 'Seleccione');

    fillSelect(modalEl.querySelector('#selPartidoActual'),     cats.partidos,   'id_partido',   'nombre', 'Seleccione');
    fillSelect(modalEl.querySelector('#selIdeologia'),         cats.ideologias, 'id_ideologia', 'nombre', 'Seleccione');
    fillSelect(modalEl.querySelector('#selGrupoPostulacion'),  cats.grupos,     'id_grupo',     'nombre', 'Seleccione');

    window.redesCatalog = cats.redes;
    window.controversiasCatalog = cats.controversias;
    window.temasCatalog = cats.temas;
    renderTemasChecks(modalEl, cats.temas); // tu función

    const payload = await apiGet(`/personas/${id}/payload`); // OJO: aquí depende de tu apiGet si ya agrega /api
    const shared = ensureShared();
    shared.applyPayloadToForm(payload);

    bootstrap.Modal.getOrCreateInstance(modalEl).show();
  }catch(err){
    console.error("openEditPersonaModal error:", err);
  }finally{
    setFormDisabled(formEl, false);
  }
}

// submit (una sola vez)
// ====== FOTO + SUBMIT (1 sola vez) ======
document.addEventListener("DOMContentLoaded", () => {
  const modalEl = document.getElementById("editPersonaModal");
  if (!modalEl) return;

  const formEl = modalEl.querySelector("#personaForm");
  if (!formEl) return;

  const inp = modalEl.querySelector("#inpFoto");
  const img = modalEl.querySelector("#previewFoto");
  const hid = modalEl.querySelector("#foto_url");

  // ---- Foto: preview + upload + set hidden ----
  if (inp && img && hid) {
    inp.addEventListener("change", async () => {
      const file = inp.files?.[0];
      if (!file) return;

      // preview local inmediato
      const localUrl = URL.createObjectURL(file);
      img.src = localUrl;
      img.classList.remove("d-none");

      try {
        inp.disabled = true;

        // SUBE AL BACKEND
        const fotoUrl = await uploadFotoPersona(file); // <- tu función

        // guarda en hidden para que buildPayload lo mande en PUT
        hid.value = fotoUrl;

        // preview desde servidor (evita cache)
        img.src = fotoUrl + (fotoUrl.includes("?") ? "&" : "?") + "t=" + Date.now();
        img.classList.remove("d-none");
      } catch (err) {
        console.error("Error subiendo foto:", err);
      } finally {
        inp.disabled = false;
        URL.revokeObjectURL(localUrl);
      }
    });
  }

  // ---- Submit edición ----
  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();

    const id = Number(currentEditId);
    if (!Number.isFinite(id) || id <= 0) return;

    try {
      const shared = ensureShared();

      // ✅ IMPORTANTE: construir payload ANTES de deshabilitar (FormData ignora disabled)
      const payload = shared.buildPayload();

      // validación rápida en front para evitar roundtrip
      if (!payload?.persona?.nombre) {
        console.warn("Nombre vacío en payload:", payload);
        // showEditAlert("El nombre es obligatorio.", "warning");
        return;
      }

      // ahora sí deshabilita
      setFormDisabled(formEl, true);

      // ✅ tu apiFetch ya agrega "/api", así que NO pongas /api aquí
      await apiPut(`/personas/${id}`, payload);

      bootstrap.Modal.getInstance(modalEl)?.hide();

      // refrescar UI (si existe)
      await loadPersonasByMunicipioId(currentMunicipioTrabajoId);

    } catch (err) {
      console.error("submit edit error:", err);
    } finally {
      setFormDisabled(formEl, false);
    }
  });
});
//helper foto
async function uploadFotoPersona(file) {
  const fd = new FormData();
  fd.append("foto", file);

  // OJO: aquí NO uses apiPost porque apiPost fuerza JSON.
  // Usamos fetch directo pero con token.
  const token = localStorage.getItem("token") || "";
  const res = await fetch("/api/upload/foto", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "No se pudo subir la foto");

  return data.foto_url; // <- tu backend devuelve foto_url
}




//delete modal persona 
document.getElementById("btnDeletePersona")?.addEventListener("click", async () => {
  const id = Number(currentEditId);
  if (!Number.isFinite(id) || id <= 0) return;

  const ok = confirm(`¿Eliminar a la persona #${id}? Esta acción NO se puede deshacer.`);
  if (!ok) return;

  try {
    await apiDelete(`/personas/${id}`); // 👈 SIN /api
    bootstrap.Modal.getInstance(document.getElementById("editPersonaModal"))?.hide();

    // refresca cards + grid
   
    // o si no, recarga las cards del municipio actual:
    await loadPersonasByMunicipioId(currentMunicipioTrabajoId);

  } catch (err) {
    console.error(err);
    // showEditAlert("No pude eliminar: " + (err.message || ""), "danger");
    alert("No pude eliminar: " + (err.message || ""));
  }
});

async function confirmDeletePersona(idPersona){
  const ok = confirm(`¿Eliminar la persona #${idPersona}? Esta acción no se puede deshacer.`);
  if (!ok) return;

  try{
    await apiDelete(`/personas/${idPersona}`); // o apiFetch con method DELETE
    // refresca UI
    if (typeof refreshGridSafe === "function") refreshGridSafe();
    // si estás viendo cards por municipio, vuelve a cargar o re-filtra
    // por ejemplo:
    // applySearch();
    alert("Eliminado ✅");
  }catch(err){
    console.error(err);
    alert("No se pudo eliminar. " + (err.message || ""));
  }
}


// Llama esto cuando tu dashboard ya esté listo
document.addEventListener("DOMContentLoaded", () => {
  let loaded = false;

  document.getElementById("tab-kpis")?.addEventListener("shown.bs.tab", () => {
    if (!loaded) {
      initKpisUI();
      loadKpisMunicipios();      // municipios
      loaded = true;
    }
  });
});

document.addEventListener('DOMContentLoaded', () => {
  initAdminDatagrid();
  initDashboard().catch(err=>{
    console.error(err);
    alert('Error cargando dashboard. Revisa consola.');
  });
});

