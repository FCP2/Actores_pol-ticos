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
    const partido = p.partido_actual_siglas || p.partido_actual;
    const badges = [
      badge(p.grupo_postulacion, 'text-bg-info'),
      badge(partido, 'text-bg-dark'),
      badge(p.ideologia_politica, 'text-bg-secondary'),
      badge(p.tema_interes_central, 'text-bg-warning'),
      (p.sin_controversias_publicas === true ? badge('Sin controversias', 'text-bg-success') : '')
    ].join('');

    return `
      <div class="card mb-2 shadow-sm">
        <div class="card-body py-2">
          <div class="d-flex justify-content-between align-items-start gap-2">
            <div class="min-w-0">
              <div class="fw-semibold text-truncate">${p.nombre}</div>
              <div class="small text-muted">${labelEscalaInfluencia(p.escala_influencia)}</div>
              <div class="mt-2 d-flex flex-wrap">${badges}</div>
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
            </div>

          </div>
        </div>
      </div>
    `;
  }).join('');

  cont.querySelectorAll('button[data-action][data-id]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = btn.getAttribute('data-id');
      const action = btn.getAttribute('data-action');

      if (action === 'ver') {
        await openPerfilModal(id);
      } else if (action === 'pdf') {
        await generarPDFPersona(id);
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

  if (res.status === 401) { localStorage.clear(); location.href='/'; return; }
  if (!res.ok) { alert("No se pudo generar el PDF"); return; }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `perfil_${idPersona}.pdf`;
  a.click();
  URL.revokeObjectURL(url);
}

function applySearch(){
  const q = norm(document.getElementById('searchInput').value);
  const filtered = !q ? personasCache : personasCache.filter(p => norm(p.nombre).includes(q));
  document.getElementById('countBadge').textContent = filtered.length;
  renderCards(filtered);
}

async function loadPersonasByMunicipioId(idMunicipio){
  document.getElementById('countBadge').textContent = '...';
  const rows = await apiGet(`/personas?municipio_trabajo=${idMunicipio}`);
  personasCache = rows || [];
  document.getElementById('countBadge').textContent = personasCache.length;
  applySearch();
}

  (function guardDashboard() {
    const token = localStorage.getItem('token');
    const u = JSON.parse(localStorage.getItem('user') || '{}');
    const roles = u.roles || (u.rol ? [u.rol] : []);

    if (!token || !roles.includes('superadmin')) {
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
  // abre modal inmediatamente
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

    // Header
    document.getElementById('perfilModalTitle').textContent = p.nombre || 'Perfil';
    document.getElementById('perfilModalSubtitle').textContent =
      `• ${p.municipio_trabajo_politico || '—'}`;

    // Badges principales
    const partido = p.partido_actual_siglas || p.partido_actual;
    const badges = [
      badgeHtml(p.grupo_postulacion, 'text-bg-info'),
      badgeHtml(partido, 'text-bg-dark'),
      badgeHtml(p.ideologia_politica, 'text-bg-secondary'),
      badgeHtml(p.tema_interes_central, 'text-bg-warning'),
      (p.sin_controversias_publicas === true ? badgeHtml('Sin controversias', 'text-bg-success') : '')
    ].filter(Boolean).join(' ');

    //deshabilitar u ocultar el tab cuando sin_controversias_publicas === true.
    const tabCont = document.getElementById('tab-controversias');
    if (p.sin_controversias_publicas === true) {
      tabCont.classList.add('disabled');
      tabCont.setAttribute('tabindex', '-1');
      tabCont.setAttribute('aria-disabled', 'true');
    } else {
      tabCont.classList.remove('disabled');
      tabCont.removeAttribute('tabindex');
      tabCont.removeAttribute('aria-disabled');
    }

    document.getElementById('perfilBadges').innerHTML = badges || `<span class="text-muted small">—</span>`;

    // General
    document.getElementById('v_curp').textContent  = p.curp || '—';
    document.getElementById('v_rfc').textContent   = p.rfc || '—';
    document.getElementById('v_clave').textContent = p.clave_elector || '—';
    document.getElementById('v_ecivil').textContent = p.estado_civil || '—';

    document.getElementById('v_mun_legal').textContent = p.municipio_residencia_legal || '—';
    document.getElementById('v_mun_real').textContent  = p.municipio_residencia_real || '—';
    document.getElementById('v_mun_trab').textContent  = p.municipio_trabajo_politico || '—';

    const flags = [];
    flags.push(p.sin_servicio_publico === true ? badgeHtml('Sin servicio público', 'text-bg-secondary') : '');
    flags.push(p.ha_contendido_eleccion === true ? badgeHtml('Ha contendió elección', 'text-bg-primary') : '');
    flags.push(p.sin_controversias_publicas === true ? badgeHtml('Sin controversias públicas', 'text-bg-success') : '');
    document.getElementById('v_flags').innerHTML = flags.filter(Boolean).join(' ') || `<span class="text-muted small">—</span>`;

    // Contacto: Teléfonos
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

    // Datos INE (ojo: tu query perfil NO agrega json de datos_ine, así que si no existe, queda en —)
    // Si luego lo agregas, aquí ya queda listo.
    document.getElementById('v_ine_seccion').textContent = p?.datos_ine?.seccion_electoral || '—';
    document.getElementById('v_ine_df').textContent      = p?.datos_ine?.distrito_federal || '—';
    document.getElementById('v_ine_dl').textContent      = p?.datos_ine?.distrito_local || '—';

    // Formación
    const fa = listOrEmpty(p.formacion_academica);
    document.getElementById('v_formacion').innerHTML = renderSimpleList(fa, (x) => {
      const line1 = [x.nivel, x.grado_obtenido || x.grado].filter(Boolean).join(' • ');
      const inst = x.institucion ? `<div class="text-muted small">${esc(x.institucion)}</div>` : '';
      const years = (x.anio_inicio || x.anio_fin) ? `<div class="text-muted small">${esc(x.anio_inicio || '—')} - ${esc(x.anio_fin || '—')}</div>` : '';
      return `
        <div class="border rounded p-2">
          <div class="fw-semibold">${esc(line1 || '—')}</div>
          ${inst}
          ${years}
        </div>
      `;
    });

    // Redes
    const redes = listOrEmpty(p.redes_sociales);
    document.getElementById('v_redes').innerHTML = renderSimpleList(redes, (r) => {
      const url = r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a>` : '—';
      return `
        <div class="border rounded p-2">
          <div class="fw-semibold">${esc(r.red || '—')}</div>
          <div class="small">${url}</div>
        </div>
      `;
    });

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
    const conv = listOrEmpty(p.controversias);
    if (p.sin_controversias_publicas === true) {
      document.getElementById('v_controversias').innerHTML =
        `<div class="alert alert-success mb-0 py-2">Marcado como <strong>Sin controversias públicas</strong>.</div>`;
    } else {
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
    // Parejas + hijos (anidado)
    const parejas = listOrEmpty(p.parejas);
    document.getElementById('v_parejas').innerHTML = renderSimpleList(parejas, (pa) => {
      const head = [pa.nombre_pareja, pa.tipo_relacion].filter(Boolean).map(esc).join(' • ') || '—';
      const fechas = (pa.fecha_inicio || pa.fecha_fin)
        ? `<div class="text-muted small">${fmtDate(pa.fecha_inicio)} - ${fmtDate(pa.fecha_fin)}</div>`
        : '';

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
          ${fechas}
          ${hijosHtml}
        </div>
      `;
    });
    //servicio publico
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
    //servicio publico
    const elx = listOrEmpty(p.elecciones);
    document.getElementById('v_elecciones').innerHTML = renderSimpleList(elx, (e) => {
      const head = [e.anio_eleccion, e.candidatura].filter(Boolean).map(esc).join(' • ') || '—';
      const partido = e.partido_postulacion ? `<span class="text-muted small">${esc(e.partido_postulacion)}</span>` : '';
      const badge = badgeResultadoEleccion(e.resultado);

      const diff = (e.diferencia_votos || e.diferencia_porcentaje)
        ? `<div class="text-muted small">Diferencia: ${fmtNum(e.diferencia_votos)} votos • ${fmtPct(e.diferencia_porcentaje)}</div>`
        : '';

      return `
        <div class="border rounded p-2">
          <div class="d-flex justify-content-between align-items-start gap-2">
            <div>
              <div class="fw-semibold">${head}</div>
              ${partido ? `<div>${partido}</div>` : ''}
              ${diff}
            </div>
            <div>${badge}</div>
          </div>
        </div>
      `;
    });
    //capacidad movilizacion
    const cm = p.capacidad_movilizacion || null;
    document.getElementById('v_capacidad').innerHTML = cm
      ? `
        <div class="border rounded p-2">
          <div class="row g-2">
            <div class="col-sm-6">
              <div class="text-muted small">Eventos últimos 3 años</div>
              <div class="fw-semibold">${fmtNum(cm.eventos_ultimos_3_anios)}</div>
            </div>
            <div class="col-sm-6">
              <div class="text-muted small">Asistencia promedio</div>
              <div class="fw-semibold">${fmtNum(cm.asistencia_promedio)}</div>
            </div>
          </div>
        </div>
      `
      : `<span class="text-muted small">—</span>`;
      //equipos

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
      //referentes
      const refs = listOrEmpty(p.referentes);
      document.getElementById('v_referentes').innerHTML = renderSimpleList(refs, (r) => {
        const head = esc(r.nombre_referente || '—');
        const lvl  = r.nivel ? `<span class="badge text-bg-info ms-2">${esc(r.nivel)}</span>` : '';
        return `
          <div class="border rounded p-2">
            <div class="d-flex align-items-center flex-wrap gap-2">
              <div class="fw-semibold">${head}</div>
              ${lvl}
            </div>
          </div>
        `;
      });
     //fa miliares
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

//Cargar usuarios para filtro (superadmin)
async function loadUsuariosFiltro() {
  const sel = document.getElementById('filtroUsuario');
  if (!sel) return;

  sel.innerHTML = `<option value="">Todos</option>`;

  const users = await apiGet('/personas/admin/usuarios'); // [{id_usuario,nombre,email,roles:[]},...]
  usuariosFiltroCache = users || [];

  for (const u of usuariosFiltroCache) {
    const rolesTxt = Array.isArray(u.roles) && u.roles.length ? ` (${u.roles.join(', ')})` : '';
    const opt = document.createElement('option');
    opt.value = String(u.id_usuario);
    opt.textContent = `${u.nombre} — ${u.email}${rolesTxt}`;
    sel.appendChild(opt);
  }
}

//Inicializar Tabulator (modo remoto)
function initPersonasGrid() {
  const el = document.getElementById('gridPersonas');
  if (!el) return;

  // Evita doble init
  if (window.personasGrid) return;

  // Si el grid está dentro de un tab/pane oculto, NO inicialices aún
  const pane = document.getElementById('pane-grid'); // ajusta si tu id es otro
  const isHidden = pane && pane.offsetParent === null; // display:none o no visible

  if (isHidden) {
    // Inicializa cuando se muestre el tab Grid
    document.getElementById('tab-grid')?.addEventListener(
      'shown.bs.tab',
      () => {
        initPersonasGrid(); // reintenta, ahora ya está visible
        // y fuerza redraw + data
        if (window.personasGrid) {
          window.personasGrid.redraw(true);
          window.personasGrid.setData(); // primera carga
        }
      },
      { once: true }
    );
    return;
  }

  // Si por alguna razón ya hay instancia, destrúyela
  if (window.personasGrid) {
    window.personasGrid.destroy();
    window.personasGrid = null;
  }

  window.personasGrid = new Tabulator(el, {
    layout: "fitColumns",
    height: "70vh",
    responsiveLayout: "collapse",
    placeholder: "Sin registros",

    // ✅ Opcional: que NO abra el “+” automáticamente
    responsiveLayoutCollapseStartOpen: false,

    // ✅ Aquí va el formatter del collapse (campos colapsados)
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
      creado_por_nombre: "Capturó",
      creado_por_email: "Correo",
      partido_actual_siglas: "Partido (siglas)",
      partido_actual: "Partido",
      tema_interes_central: "Tema",
      created_at: "Creado",
      municipio_trabajo_politico: "Municipio",
      escala_influencia: "Escala"
    };

    Object.entries(data).forEach(([k, v]) => {
      let val = v;

      if (k === "created_at" && typeof fmtDate === "function") val = fmtDate(v);
      if (k === "escala_influencia" && typeof labelEscalaInfluencia === "function") {
        val = v ? labelEscalaInfluencia(v) : "—";
      }

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

    return wrap; // ✅ Node, no string
  },

    pagination: true,
    paginationMode: "remote",
    paginationSize: gridState.pageSize,
    paginationSizeSelector: [10, 25, 50, 100],

    // OJO: puedes omitir ajaxURL porque ya usas ajaxRequestFunc
    ajaxURL: "/api/personas/admin/grid",
    ajaxConfig: { method: "GET" },

    ajaxRequestFunc: async (url, config, params) => {
      const page = params.page || 1;
      const size = params.size || gridState.pageSize;

      let sort = "created_at";
      let dir = "desc";
      if (Array.isArray(params.sorters) && params.sorters.length) {
        sort = params.sorters[0].field || sort;
        dir = params.sorters[0].dir || dir;
      }

      const qs = new URLSearchParams();
      qs.set("page", String(page));
      qs.set("pageSize", String(size));
      qs.set("sort", sort);
      qs.set("dir", dir);

      if (gridState.creado_por) qs.set("creado_por", gridState.creado_por);
      if (gridState.municipio_trabajo) qs.set("municipio_trabajo", gridState.municipio_trabajo);
      if (gridState.q) qs.set("q", gridState.q);

      return apiGet(`/personas/admin/grid?${qs.toString()}`);
    },

    ajaxResponse: (url, params, resp) => {
      const total = resp.total || 0;
      const pageSize = resp.pageSize || gridState.pageSize;
      const lastPage = Math.max(1, Math.ceil(total / pageSize));

      return {
        data: resp.rows || [],
        last_page: lastPage,
        total_records: total
      };
    },

    columns: [
      {
        title: "Nombre",
        field: "nombre",
        minWidth: 240,
        responsive: 0, // 🔥 nunca colapsar
        headerSort: true,
        formatter: (cell) => {
          const row = cell.getRow().getData();
          const muni = row.municipio_trabajo_politico || "—";
          const escala = row.escala_influencia ? labelEscalaInfluencia(row.escala_influencia) : "—";
          return `
            <div class="min-w-0">
              <div class="fw-semibold text-truncate">${esc(row.nombre || "—")}</div>
              <div class="small text-muted text-truncate">${esc(muni)} • ${esc(escala)}</div>
            </div>
          `;
        }
      },
      {
        title: "Capturó",
        field: "creado_por_nombre",
        width: 200,
        minWidth: 180,
        responsive: 1, // ✅ colapsa después
        headerSort: true,
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
        title: "Partido",
        field: "partido_actual_siglas",
        width: 110,
        minWidth: 90,
        responsive: 3,
        headerSort: false,
        formatter: (cell) => {
          const r = cell.getRow().getData();
          return esc(r.partido_actual_siglas || r.partido_actual || "—");
        }
      },
      {
        title: "Tema",
        field: "tema_interes_central",
        width: 160,
        minWidth: 140,
        responsive: 4,
        headerSort: false,
        formatter: (cell) => esc(cell.getValue() || "—")
      },
      {
        title: "Creado",
        field: "created_at",
        width: 140,
        minWidth: 120,
        responsive: 5,
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
        responsive: 0, // 🔥 nunca colapsar
        formatter: () => `<button type="button" class="btn btn-outline-primary btn-sm">Ver</button>`,
        cellClick: (e, cell) => {
          const r = cell.getRow().getData();
          const id = Number(r.id_persona);
          if (Number.isFinite(id)) openPerfilModal(id);
        }
      }
    ],
  });

  // IMPORTANTE: no dispares setData “en caliente” si estás en layout raro
  // mejor en el siguiente frame (da tiempo a calcular tamaños)
  requestAnimationFrame(() => {
    if (window.personasGrid) window.personasGrid.setData();
  });

  // Siempre que se abra el tab, redraw (por si cambia tamaño)
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
  const selUsuario  = document.getElementById('filtroUsuario');
  const inpSearch   = document.getElementById('gridSearch');
  const selPageSize = document.getElementById('gridPageSize');
  const selGridMun  = document.getElementById('gridMunicipio');

  if (selGridMun) {
    selGridMun.addEventListener('change', () => {
      gridState.municipio_trabajo = selGridMun.value || '';
      refreshGridSafe();
    });
  }

  if (selUsuario) {
    selUsuario.addEventListener('change', () => {
      gridState.creado_por = selUsuario.value || '';
      refreshGridSafe();
    });
  }

  if (selPageSize) {
    selPageSize.addEventListener('change', () => {
      const n = Number(selPageSize.value);
      gridState.pageSize = Number.isFinite(n) ? n : 25;

      if (window.personasGrid) {
        window.personasGrid.setPageSize(gridState.pageSize);
        window.personasGrid.setData();
      }
      // si no existe aún, no pasa nada: se usará cuando se inicialice
    });
  }

  if (inpSearch) {
    const onSearch = debounce(() => {
      gridState.q = (inpSearch.value || '').trim();
      refreshGridSafe();
    }, 300);

    inpSearch.addEventListener('input', onSearch);
  }

  // ✅ Cuando se abra el tab grid: inicializa (si no existe), redraw y carga
  document.getElementById('tab-grid')?.addEventListener('shown.bs.tab', () => {
    const sel = document.getElementById('gridMunicipio');
    gridState.municipio_trabajo = sel ? (sel.value || '') : '';

    if (!window.personasGrid) initPersonasGrid();

    if (window.personasGrid) {
      // un frame después, ya con medidas reales
      requestAnimationFrame(() => {
        window.personasGrid.redraw(true);
        window.personasGrid.setData();
      });
    }
  });

}


async function initAdminDatagrid() {
  await loadUsuariosFiltro();
  initGridFilters();

  // Si por alguna razón el tab grid ya está activo al cargar:
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

document.addEventListener('DOMContentLoaded', () => {
  
  initAdminDatagrid();
  initDashboard().catch(err=>{
    console.error(err);
    alert('Error cargando dashboard. Revisa consola.');
  });
});

