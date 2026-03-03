/* persona.shared.js
   Reutiliza el formulario de persona en cualquier "root" (ej. modal del dashboard).
   Uso:
     const shared = PersonaShared.init({
       root: document.getElementById('editPersonaModal'),
       catalogs: { municipios, redes, controversias, temas, partidos, ideologias, grupos }
     });
     shared.applyPayloadToForm(payload);
     const payloadOut = shared.buildPayload();
*/

(function () {
  function $in(root, sel) { return root.querySelector(sel); }
  function $$in(root, sel) { return Array.from(root.querySelectorAll(sel)); }

  const toIntOrNull  = (v) => (v === '' || v == null) ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
  const toBoolOrNull = (v) => (v === 'true') ? true : (v === 'false') ? false : null;

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

  function cleanText(v) { return (v || "").toString().trim().replace(/\s+/g, " "); }

  // ============ FACTORY ============
  function init({ root, catalogs = {} } = {}) {
    if (!root) throw new Error("PersonaShared.init: falta root");

    // catálogos (inyectados desde dashboard)
    let municipiosCache = catalogs.municipios || [];
    let redesCatalog = catalogs.redes || [];
    let controversiasCatalog = catalogs.controversias || [];
    let temasCatalog = catalogs.temas || [];
    let partidosCatalog = catalogs.partidos || [];
    let ideologiasCatalog = catalogs.ideologias || [];
    let gruposCatalog = catalogs.grupos || [];

    let fotoUrlActual = null;
    let parejaCounter = 0;
    let cargoEleccionCounter = 0;

    // ======== Helpers Parejas/Hijos ========
    function getParejasForSelect() {
      const items = [];
      $$in(root, '#parejasContainer .list-item').forEach(p => {
        const tempId = p.dataset.tempId;
        const nombre = (p.querySelector('input[name="nombre_pareja"]')?.value || '').trim();
        const tipo = (p.querySelector('select[name="tipo_relacion"]')?.value || '').trim();
        if (!tempId) return;
        const label = `${nombre || 'Pareja'}${tipo ? ' (' + tipo + ')' : ''}`;
        items.push({ tempId, label });
      });
      return items;
    }

    function fillHijoParejaSelect(sel) {
      if (!sel) return;
      const current = sel.value;
      const parejas = getParejasForSelect();
      sel.innerHTML = `<option value="">(Sin especificar)</option>`;
      parejas.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.tempId;
        opt.textContent = `${p.label}`;
        sel.appendChild(opt);
      });
      if (parejas.some(p => p.tempId === current)) sel.value = current;
    }

    function refreshHijosParejasSelects() {
      $$in(root, '#hijosContainer select[name="pareja_temp_id"]').forEach(sel => fillHijoParejaSelect(sel));
    }

    // ============ Blocks ============
    function movEventoBlock() {
      const div = document.createElement('div');
      div.className = 'list-item mb-2';
      div.innerHTML = `
        <div class="row g-2 align-items-end">
          <div class="col-12 col-md-6">
            <label class="form-label">Nombre del evento</label>
            <input class="form-control" name="mov_nombre_evento" placeholder="Ej. Asamblea regional">
          </div>
          <div class="col-12 col-md-3">
            <label class="form-label">Fecha</label>
            <input type="date" class="form-control" name="mov_fecha_evento">
          </div>
          <div class="col-12 col-md-2">
            <label class="form-label">Asistencia</label>
            <input type="number" min="0" class="form-control" name="mov_asistencia_evento" inputmode="numeric" placeholder="Ej. 220">
          </div>
          <div class="col-12 col-md-1 text-md-end">
            <button type="button" class="btn btn-outline-danger btn-sm w-100 btnRemove">X</button>
          </div>
        </div>
      `;
      div.querySelector('.btnRemove')?.addEventListener('click', () => div.remove());
      return div;
    }

    function telefonoBlock() {
      const div = document.createElement('div');
      div.className = 'list-item';
      div.innerHTML = `
        <div class="row g-2 align-items-end">
          <div class="col-md-5">
            <label class="form-label">Teléfono</label>
            <input class="form-control" name="telefono" placeholder="Ej. 7221234567">
          </div>
          <div class="col-md-4">
            <label class="form-label">Tipo</label>
            <select class="form-select" name="tipo">
              <option value="">Seleccione</option>
              <option value="personal">Personal</option>
              <option value="trabajo">Trabajo</option>
            </select>
          </div>
          <div class="col-md-2">
            <div class="form-check">
              <input class="form-check-input" type="checkbox" name="principal">
              <label class="form-check-label">Principal</label>
            </div>
          </div>
          <div class="col-md-1 text-end">
            <button type="button" class="btn btn-outline-danger btn-sm btnRemove">X</button>
          </div>
        </div>
      `;
      div.querySelector('.btnRemove')?.addEventListener('click', () => div.remove());
      div.querySelector('input[name="principal"]')?.addEventListener('change', (e) => {
        if (e.target.checked) {
          $$in(root, '#telefonosContainer input[name="principal"]').forEach(ch => {
            if (ch !== e.target) ch.checked = false;
          });
        }
      });
      return div;
    }

    function participacionBlock() {
      const div = document.createElement('div');
      div.className = 'list-item';
      div.innerHTML = `
        <div class="row g-2">
          <div class="col-12 col-md-3">
            <label class="form-label">Tipo</label>
            <select class="form-select" name="po_tipo">
              <option value="">Seleccione</option>
              <option value="partido">Partido</option>
              <option value="organizacion_social">Organización social</option>
              <option value="organizacion_politica">Organización política</option>
              <option value="otro">Otro</option>
            </select>
          </div>
          <div class="col-12 col-md-5">
            <label class="form-label">Nombre</label>
            <input class="form-control" name="po_nombre" placeholder="Nombre del partido/organización">
          </div>
          <div class="col-12 col-md-4">
            <label class="form-label">Rol</label>
            <input class="form-control" name="po_rol" placeholder="Ej. integrante, dirigente, enlace">
          </div>
          <div class="col-12 col-md-4">
            <label class="form-label">Periodo</label>
            <input class="form-control" name="po_periodo" placeholder="Ej. 2021-2023">
          </div>
          <div class="col-12 col-md-8">
            <label class="form-label">Notas</label>
            <input class="form-control" name="po_notas" placeholder="Opcional">
          </div>
          <div class="col-12 text-end">
            <button type="button" class="btn btn-outline-danger btn-sm btnRemove">Eliminar</button>
          </div>
        </div>
      `;
      div.querySelector('.btnRemove')?.addEventListener('click', () => div.remove());
      return div;
    }

    function expLabBlock() {
      const div = document.createElement('div');
      div.className = 'list-item';
      div.innerHTML = `
        <div class="row g-2 align-items-end">
          <div class="col-md-3">
            <label class="form-label">Periodo</label>
            <input class="form-control" name="periodo" placeholder="2018-2021" maxlength="9">
          </div>
          <div class="col-md-4">
            <label class="form-label">Cargo</label>
            <input class="form-control" name="cargo" maxlength="120">
          </div>
          <div class="col-md-4">
            <label class="form-label">Organización o empresa</label>
            <input class="form-control" name="organizacion" maxlength="150">
          </div>
          <div class="col-md-1 text-end">
            <button type="button" class="btn btn-outline-danger btn-sm btnRemove">X</button>
          </div>
        </div>
      `;
      div.querySelector('.btnRemove')?.addEventListener('click', () => div.remove());
      return div;
    }

    function parejaBlock() {
      parejaCounter += 1;
      const tempId = `p_${parejaCounter}`;
      const div = document.createElement('div');
      div.className = 'list-item';
      div.dataset.tempId = tempId;

      div.innerHTML = `
        <div class="row g-2 align-items-end">
          <div class="col-md-5">
            <label class="form-label">Nombre pareja</label>
            <input class="form-control" name="nombre_pareja" maxlength="150" autocomplete="off">
          </div>
          <div class="col-md-3">
            <label class="form-label">Tipo relación</label>
            <select class="form-select" name="tipo_relacion">
              <option value="">Seleccione</option>
              <option value="actual">Actual</option>
              <option value="anterior">Anterior</option>
            </select>
          </div>
          <div class="col-md-2">
            <label class="form-label">Año o periodo</label>
            <input class="form-control" name="periodo" placeholder="2025 o 2015-2025" inputmode="numeric" autocomplete="off" maxlength="9">
            <div class="form-text">Formato: AAAA o AAAA-AAAA</div>
            <div class="invalid-feedback">Usa 2025 o 2015-2025.</div>
          </div>
          <div class="col-12 text-end mt-2">
            <button type="button" class="btn btn-outline-danger btn-sm btnRemove">Eliminar</button>
          </div>
        </div>
      `;
      div.querySelector('.btnRemove')?.addEventListener('click', () => {
        div.remove();
        refreshHijosParejasSelects();
      });
      div.addEventListener('input', () => {
        const inp = div.querySelector('input[name="periodo"]');
        if (inp) inp.value = inp.value.replace(/[^\d\- ]/g, '');
        refreshHijosParejasSelects();
      });
      div.addEventListener('change', refreshHijosParejasSelects);
      return div;
    }

    function hijoBlock() {
      const div = document.createElement('div');
      div.className = 'list-item';
      div.innerHTML = `
        <div class="row g-2 align-items-end">
          <div class="col-md-4">
            <label class="form-label">Con quién</label>
            <select class="form-select" name="pareja_temp_id">
              <option value="">(Sin especificar)</option>
            </select>
          </div>
          <div class="col-md-4">
            <label class="form-label">Año nacimiento</label>
            <input type="number" class="form-control" name="anio_nacimiento" min="1900" max="2100">
          </div>
          <div class="col-md-3">
            <label class="form-label">Género</label>
            <select class="form-select" name="sexo">
              <option value="">Seleccione</option>
              <option value="F">F</option>
              <option value="M">M</option>
            </select>
          </div>
          <div class="col-md-1 text-end">
            <button type="button" class="btn btn-outline-danger btn-sm btnRemove">X</button>
          </div>
        </div>
      `;
      div.querySelector('.btnRemove')?.addEventListener('click', () => div.remove());
      fillHijoParejaSelect(div.querySelector('select[name="pareja_temp_id"]'));
      return div;
    }

    function redBlock() {
      const div = document.createElement('div');
      div.className = 'list-item';
      div.innerHTML = `
        <div class="row g-2 align-items-end">
          <div class="col-md-4">
            <label class="form-label">Red</label>
            <select class="form-select" name="id_red"></select>
          </div>
          <div class="col-md-7">
            <label class="form-label">URL</label>
            <input class="form-control" name="url" placeholder="https://...">
          </div>
          <div class="col-md-1 text-end">
            <button type="button" class="btn btn-outline-danger btn-sm btnRemove">X</button>
          </div>
        </div>
      `;
      fillSelect(div.querySelector('select[name="id_red"]'), redesCatalog, 'id_red', 'nombre');
      div.querySelector('.btnRemove')?.addEventListener('click', () => div.remove());
      return div;
    }

    function servicioBlock() {
      const div = document.createElement('div');
      div.className = 'list-item';
      div.innerHTML = `
        <div class="row g-2 align-items-end">
          <div class="col-md-3">
            <label class="form-label">Periodo</label>
            <input class="form-control" name="periodo" placeholder="2018-2021">
          </div>
          <div class="col-md-4">
            <label class="form-label">Cargo</label>
            <input class="form-control" name="cargo">
          </div>
          <div class="col-md-4">
            <label class="form-label">Dependencia</label>
            <input class="form-control" name="dependencia">
          </div>
          <div class="col-md-1 text-end">
            <button type="button" class="btn btn-outline-danger btn-sm btnRemove">X</button>
          </div>
        </div>
      `;
      div.querySelector('.btnRemove')?.addEventListener('click', () => div.remove());
      return div;
    }

    function eleccionBlock() {
      const div = document.createElement('div');
      div.className = 'list-item border rounded-3 p-3 mb-2';
      div.innerHTML = `
        <div class="row g-2">
          <div class="col-6 col-lg-2">
            <label class="form-label">Año</label>
            <input type="number" class="form-control" name="anio_eleccion" min="1900" max="2100" inputmode="numeric">
          </div>
          <div class="col-6 col-lg-2">
            <label class="form-label">Resultado</label>
            <select class="form-select" name="resultado">
              <option value="">Seleccione</option>
              <option value="ganada">Ganada</option>
              <option value="no_ganada">No ganada</option>
            </select>
          </div>
          <div class="col-12 col-lg-4">
            <label class="form-label">Candidatura</label>
            <input class="form-control" name="candidatura" placeholder="Ej. Presidencia municipal">
          </div>
          <div class="col-12 col-lg-2">
            <label class="form-label">Partido</label>
            <input class="form-control" name="partido_postulacion" placeholder="Ej. PAN / PRI / MORENA">
          </div>
          <div class="col-6 col-lg-1">
            <label class="form-label">Votos</label>
            <input type="number" class="form-control" name="diferencia_votos" min="0" inputmode="numeric">
          </div>
          <div class="col-6 col-lg-1">
            <label class="form-label">% Dif.</label>
            <input type="number" step="0.01" class="form-control" name="diferencia_porcentaje" min="0" max="100" inputmode="decimal">
          </div>
          <div class="col-12 d-flex justify-content-end">
            <button type="button" class="btn btn-outline-danger btn-sm btnRemove">Eliminar</button>
          </div>
        </div>
      `;
      div.querySelector('.btnRemove')?.addEventListener('click', () => div.remove());
      return div;
    }

    function equipoBlock() {
      const div = document.createElement('div');
      div.className = 'list-item';
      div.innerHTML = `
        <div class="row g-2 align-items-end">
          <div class="col-md-8">
            <label class="form-label">Nombre del equipo</label>
            <input class="form-control" name="nombre_equipo">
          </div>
          <div class="col-md-3">
            <label class="form-label">Activo</label>
            <select class="form-select" name="activo">
              <option value="true">Si</option>
              <option value="false">No</option>
            </select>
          </div>
          <div class="col-md-1 text-end">
            <button type="button" class="btn btn-outline-danger btn-sm btnRemove">X</button>
          </div>
        </div>
      `;
      div.querySelector('.btnRemove')?.addEventListener('click', () => div.remove());
      return div;
    }

    function referenteBlock() {
      const div = document.createElement('div');
      div.className = 'list-item';
      div.innerHTML = `
        <div class="row g-2 align-items-end">
          <div class="col-md-2">
            <label class="form-label">Nivel</label>
            <select class="form-select" name="nivel">
              <option value="">Seleccione</option>
              <option value="municipal">Municipal</option>
              <option value="regional">Regional</option>
              <option value="distrital">Distrital</option>
              <option value="estatal">Estatal</option>
              <option value="nacional">Nacional</option>
            </select>
          </div>
          <div class="col-md-3">
            <label class="form-label">Nombre(s)</label>
            <input class="form-control" name="nombres" autocomplete="off">
          </div>
          <div class="col-md-3">
            <label class="form-label">Apellido paterno</label>
            <input class="form-control" name="apellido_paterno" autocomplete="off">
          </div>
          <div class="col-md-3">
            <label class="form-label">Apellido materno</label>
            <input class="form-control" name="apellido_materno" autocomplete="off">
          </div>
          <div class="col-md-1 text-end">
            <button type="button" class="btn btn-outline-danger btn-sm btnRemove">X</button>
          </div>
        </div>
      `;
      div.querySelector('.btnRemove')?.addEventListener('click', () => div.remove());
      return div;
    }

    function controversiaBlock() {
      const div = document.createElement('div');
      div.className = 'list-item';
      div.innerHTML = `
        <div class="row g-2">
          <div class="col-md-4">
            <label class="form-label">Tipo</label>
            <select class="form-select" name="id_tipo"></select>
          </div>
          <div class="col-md-4">
            <label class="form-label">Periodo</label>
            <input type="date" class="form-control" name="fecha_registro">
          </div>
          <div class="col-md-8">
            <label class="form-label">Descripción</label>
            <textarea class="form-control" name="descripcion" rows="2"></textarea>
          </div>
          <div class="col-md-4">
            <label class="form-label">Fuente</label>
            <input class="form-control" name="fuente" placeholder="Medio / enlace / nota / Núm. de expte.">
          </div>
          <div class="col-12 text-end">
            <button type="button" class="btn btn-outline-danger btn-sm btnRemove">Eliminar</button>
          </div>
        </div>
      `;
      fillSelect(div.querySelector('select[name="id_tipo"]'), controversiasCatalog, 'id_tipo', 'tipo');
      div.querySelector('.btnRemove')?.addEventListener('click', () => div.remove());
      return div;
    }

    function familiarBlock() {
      const div = document.createElement('div');
      div.className = 'list-item';
      div.innerHTML = `
        <div class="row g-2 align-items-end">
          <div class="col-md-4">
            <label class="form-label">Nombre</label>
            <input class="form-control" name="nombre">
          </div>
          <div class="col-md-2">
            <label class="form-label">Parentesco</label>
            <input class="form-control" name="parentesco" placeholder="Hermano / Padre / etc">
          </div>
          <div class="col-md-3">
            <label class="form-label">Cargo</label>
            <input class="form-control" name="cargo">
          </div>
          <div class="col-md-2">
            <label class="form-label">Institución</label>
            <input class="form-control" name="institucion">
          </div>
          <div class="col-md-1 text-end">
            <button type="button" class="btn btn-outline-danger btn-sm btnRemove">X</button>
          </div>
        </div>
      `;
      div.querySelector('.btnRemove')?.addEventListener('click', () => div.remove());
      return div;
    }

    function cargoEleccionBlock() {
      cargoEleccionCounter += 1;
      const div = document.createElement("div");
      div.className = "list-item";
      div.innerHTML = `
        <div class="row g-2 align-items-end">
          <div class="col-md-3">
            <label class="form-label">Periodo</label>
            <input class="form-control" name="periodo" placeholder="2021 o 2018-2021" maxlength="9">
            <div class="invalid-feedback">Usa AAAA o AAAA-AAAA.</div>
          </div>
          <div class="col-md-4">
            <label class="form-label">Cargo</label>
            <input class="form-control" name="cargo" maxlength="120">
            <div class="invalid-feedback">Indica el cargo.</div>
          </div>
          <div class="col-md-3">
            <label class="form-label">Partido postulante</label>
            <input class="form-control" name="partido_postulante" maxlength="120">
          </div>
          <div class="col-md-1">
            <label class="form-label">MR/RP</label>
            <select class="form-select" name="modalidad">
              <option value="">—</option>
              <option value="mr">MR</option>
              <option value="rp">RP</option>
            </select>
          </div>
          <div class="col-md-1 text-end">
            <button type="button" class="btn btn-outline-danger btn-sm btnRemove">X</button>
          </div>
        </div>
      `;
      div.querySelector(".btnRemove")?.addEventListener("click", () => div.remove());
      return div;
    }

    // ============ Toggles ============
    function getSelectedTemasIds() {
      const ids = [];
      $$in(root, '.tema-interes-chk:checked').forEach(chk => {
        const raw = chk.getAttribute('data-id');
        const n = parseInt(raw, 10);
        if (!Number.isNaN(n)) ids.push(n);
      });
      return ids;
    }

    function toggleTemaOtroUI() {
      const wrap = $in(root, '#temaOtroWrap');
      const inp  = $in(root, '#temaOtroTexto');
      if (!wrap || !inp) return;

      const selectedIds = getSelectedTemasIds();
      const requiereOtro = (temasCatalog || []).some(t =>
        selectedIds.includes(Number(t.id_tema)) && !!t.requiere_otro_texto
      );

      wrap.classList.toggle('d-none', !requiereOtro);
      inp.required = requiereOtro;

      if (!requiereOtro) {
        inp.value = '';
        inp.classList.remove('is-invalid');
      }
    }

    function toggleFormacionAcademicaUI() {
      const nivel = ($in(root, '#fa_nivel')?.value || '').trim();
      const requiere = (nivel === 'Educación Superior' || nivel === 'Posgrado');

      const wrapGrado = $in(root, '#fa_grado_wrap');
      const wrapInst  = $in(root, '#fa_inst_wrap');
      const wrapTitulado = $in(root, '#faTituladoWrap');
      const inpGrado  = $in(root, '#fa_grado_obtenido');
      const inpInst   = $in(root, '#fa_institucion');
      const selTit    = $in(root, '#fa_titulado');

      wrapTitulado?.classList.toggle('d-none', !requiere);
      if (!requiere && selTit) selTit.value = '';

      if (wrapGrado) wrapGrado.style.display = requiere ? '' : 'none';
      if (wrapInst)  wrapInst.style.display  = requiere ? '' : 'none';

      if (inpGrado) inpGrado.required = requiere;
      if (inpInst)  inpInst.required  = requiere;

      if (!requiere) {
        if (inpGrado) { inpGrado.value = ''; inpGrado.classList.remove('is-invalid'); }
        if (inpInst)  { inpInst.value = '';  inpInst.classList.remove('is-invalid'); }
      }
    }

    // ============ clearAll básico ============
    function clearAll() {
      const ensureOne = (containerSel, blockFn) => {
        const c = $in(root, containerSel);
        if (!c) return;
        c.innerHTML = '';
        c.appendChild(blockFn());
      };

      ensureOne('#telefonosContainer', telefonoBlock);
      ensureOne('#parejasContainer', parejaBlock);
      ensureOne('#hijosContainer', hijoBlock);
      ensureOne('#redesContainer', redBlock);
      ensureOne('#servicioContainer', servicioBlock);
      ensureOne('#eleccionesContainer', eleccionBlock);
      ensureOne('#equiposContainer', equipoBlock);
      ensureOne('#referentesContainer', referenteBlock);
      ensureOne('#controversiasContainer', controversiaBlock);
      ensureOne('#familiaresContainer', familiarBlock);
      ensureOne('#cargosEleccionContainer', cargoEleccionBlock);
      ensureOne('#movEventosContainer', movEventoBlock);
      ensureOne('#expLabContainer', expLabBlock);
      ensureOne('#participacionContainer', participacionBlock);

      refreshHijosParejasSelects();
    }

    // ============ applyPayloadToForm ============
    function applyPayloadToForm(payload) {
      clearAll();

      const p = payload.persona || {};
      const setVal = (name, value) => {
        const el = $in(root, `[name="${name}"]`);
        if (!el) return;
        el.value = (value ?? '') === null ? '' : String(value ?? '');
      };

      setVal('nombre', p.nombre);
      setVal('apellido_paterno', p.apellido_paterno);
      setVal('apellido_materno', p.apellido_materno);
      setVal('curp', p.curp);
      setVal('rfc', p.rfc);
      setVal('clave_elector', p.clave_elector);
      setVal('estado_civil', p.estado_civil);
      setVal('escala_influencia', p.escala_influencia);

      const chkSP = $in(root, '#sin_sp');
      if (chkSP) chkSP.checked = !!p.sin_servicio_publico;

      setVal('municipio_residencia_legal', p.municipio_residencia_legal);
      setVal('municipio_residencia_real', p.municipio_residencia_real);
      setVal('municipio_trabajo_politico', p.municipio_trabajo_politico);

      // datos INE
      const ine = payload.datos_ine || {};
      setVal('ine_seccion', ine.seccion_electoral);
      setVal('ine_df', ine.distrito_federal);
      setVal('ine_dl', ine.distrito_local);

      // sin controversias
      const chkSinCont = $in(root, '#chkSinControversias');
      if (chkSinCont) chkSinCont.checked = (payload?.persona?.sin_controversias_publicas === true);

      // rebuild helper
      const rebuildList = (containerSel, items, createBlock, fillFn) => {
        const c = $in(root, containerSel);
        if (!c) return;
        c.innerHTML = '';
        (items || []).forEach(it => {
          const b = createBlock();
          c.appendChild(b);
          fillFn(b, it);
        });
        if ((items || []).length === 0) c.appendChild(createBlock());
      };

      // parejas
      rebuildList('#parejasContainer', payload.parejas || [], parejaBlock, (b, it) => {
        if (it.temp_id) b.dataset.tempId = it.temp_id;
        b.querySelector('input[name="nombre_pareja"]').value = it.nombre_pareja || '';
        b.querySelector('select[name="tipo_relacion"]').value = it.tipo_relacion || '';
        const inpPeriodo = b.querySelector('input[name="periodo"]');
        if (inpPeriodo) inpPeriodo.value = it.periodo || '';
      });
      refreshHijosParejasSelects();

      // hijos
      rebuildList('#hijosContainer', payload.hijos || [], hijoBlock, (b, it) => {
        b.querySelector('input[name="anio_nacimiento"]').value = it.anio_nacimiento || '';
        b.querySelector('select[name="sexo"]').value = it.sexo || '';
        const sel = b.querySelector('select[name="pareja_temp_id"]');
        fillHijoParejaSelect(sel);
        sel.value = it.pareja_temp_id || '';
      });

      // telefonos
      rebuildList('#telefonosContainer', payload.telefonos || [], telefonoBlock, (b, it) => {
        b.querySelector('input[name="telefono"]').value = it.telefono || '';
        b.querySelector('select[name="tipo"]').value = it.tipo || '';
        b.querySelector('input[name="principal"]').checked = !!it.principal;
      });

      // redes
      rebuildList('#redesContainer', payload.redes || [], redBlock, (b, it) => {
        b.querySelector('select[name="id_red"]').value = it.id_red || '';
        b.querySelector('input[name="url"]').value = it.url || '';
      });

      // servicio_publico
      rebuildList('#servicioContainer', payload.servicio_publico || [], servicioBlock, (b, it) => {
        b.querySelector('input[name="periodo"]').value = it.periodo || '';
        b.querySelector('input[name="cargo"]').value = it.cargo || '';
        b.querySelector('input[name="dependencia"]').value = it.dependencia || '';
      });

      // elecciones
      const selHa = $in(root, '#selHaContendido');
      if (selHa) {
        selHa.value = (p.ha_contendido_eleccion == null) ? '' : String(!!p.ha_contendido_eleccion);
        if ((payload.elecciones || []).length > 0 && !selHa.value) selHa.value = 'true';
      }
      if (selHa && selHa.value === 'true') {
        rebuildList('#eleccionesContainer', payload.elecciones || [], eleccionBlock, (b, it) => {
          b.querySelector('input[name="anio_eleccion"]').value = it.anio_eleccion || '';
          b.querySelector('input[name="candidatura"]').value = it.candidatura || '';
          b.querySelector('input[name="partido_postulacion"]').value = it.partido_postulacion || '';
          b.querySelector('select[name="resultado"]').value = it.resultado || '';
          b.querySelector('input[name="diferencia_votos"]').value = it.diferencia_votos || '';
          b.querySelector('input[name="diferencia_porcentaje"]').value = it.diferencia_porcentaje || '';
        });
      }

      // equipos
      rebuildList('#equiposContainer', payload.equipos || [], equipoBlock, (b, it) => {
        b.querySelector('input[name="nombre_equipo"]').value = it.nombre_equipo || '';
        b.querySelector('select[name="activo"]').value = String(it.activo ?? true);
      });

      // referentes
      rebuildList('#referentesContainer', payload.referentes || [], referenteBlock, (b, it) => {
        b.querySelector('select[name="nivel"]').value = it.nivel || '';
        b.querySelector('input[name="nombres"]').value = it.nombres || '';
        b.querySelector('input[name="apellido_paterno"]').value = it.apellido_paterno || '';
        b.querySelector('input[name="apellido_materno"]').value = it.apellido_materno || '';
      });

      // controversias
      if (!(chkSinCont?.checked)) {
        rebuildList('#controversiasContainer', payload.controversias || [], controversiaBlock, (b, it) => {
          b.querySelector('select[name="id_tipo"]').value = it.id_tipo || '';
          b.querySelector('input[name="fecha_registro"]').value = it.fecha_registro ? String(it.fecha_registro).slice(0,10) : '';
          b.querySelector('textarea[name="descripcion"]').value = it.descripcion || '';
          b.querySelector('input[name="fuente"]').value = it.fuente || '';
        });
      }

      // familiares
      rebuildList('#familiaresContainer', payload.familiares || [], familiarBlock, (b, it) => {
        b.querySelector('input[name="nombre"]').value = it.nombre || '';
        b.querySelector('input[name="parentesco"]').value = it.parentesco || '';
        b.querySelector('input[name="cargo"]').value = it.cargo || '';
        b.querySelector('input[name="institucion"]').value = it.institucion || '';
      });

      // cargos elección popular
      const chkSinCargos = $in(root, '#chkSinCargosEleccion');
      if (chkSinCargos) chkSinCargos.checked = !!p.sin_cargos_eleccion_popular;

      rebuildList('#cargosEleccionContainer', payload.cargos_eleccion_popular || [], cargoEleccionBlock, (b, it) => {
        b.querySelector('input[name="periodo"]').value = it.periodo || '';
        b.querySelector('input[name="cargo"]').value = it.cargo || '';
        b.querySelector('input[name="partido_postulante"]').value = it.partido_postulante || '';
        b.querySelector('select[name="modalidad"]').value = it.modalidad || '';
      });

      // formación académica (single array)
      const fa = (payload.formacion_academica || [])[0] || {};
      const selNivel = $in(root, '#fa_nivel');
      const inpGrado = $in(root, '#fa_grado_obtenido');
      const inpInst  = $in(root, '#fa_institucion');
      const selTit   = $in(root, '#fa_titulado');
      if (selNivel) selNivel.value = fa.nivel || '';
      if (inpGrado) inpGrado.value = fa.grado_obtenido || '';
      if (inpInst)  inpInst.value  = fa.institucion || '';
      if (selTit)   selTit.value   = (fa.titulado == null) ? '' : String(!!fa.titulado);
      toggleFormacionAcademicaUI();

      // movilización
      rebuildList('#movEventosContainer', payload.capacidad_movilizacion_eventos || [], movEventoBlock, (b, it) => {
        b.querySelector('input[name="mov_nombre_evento"]').value = it.nombre_evento || '';
        const inpFecha = b.querySelector('input[name="mov_fecha_evento"]');
        if (inpFecha) inpFecha.value = it.fecha_evento ? String(it.fecha_evento).slice(0,10) : '';
        b.querySelector('input[name="mov_asistencia_evento"]').value = (it.asistencia ?? '');
      });

      // experiencia laboral
      rebuildList('#expLabContainer', payload.experiencia_laboral || [], expLabBlock, (b, it) => {
        b.querySelector('input[name="periodo"]').value = it.periodo || '';
        b.querySelector('input[name="cargo"]').value = it.cargo || '';
        b.querySelector('input[name="organizacion"]').value = it.organizacion || '';
      });
      
      // participación en otros partidos u organizaciones
      rebuildList(
        '#participacionContainer',
        payload.participacion_organizaciones || [],
        participacionBlock,
        (b, it) => {
          b.querySelector('select[name="po_tipo"]').value = it.tipo || '';
          b.querySelector('input[name="po_nombre"]').value = it.nombre || '';
          b.querySelector('input[name="po_rol"]').value = it.rol || '';
          b.querySelector('input[name="po_periodo"]').value = it.periodo || '';
          b.querySelector('input[name="po_notas"]').value = it.notas || '';
        }
      );

      // partido/ideologia/grupo
      const selPartido = $in(root, '#selPartidoActual');
      if (selPartido) selPartido.value = payload?.persona?.id_partido_actual ?? '';
      const selGrupo = $in(root, '#selGrupoPostulacion');
      if (selGrupo) selGrupo.value = payload?.persona?.id_grupo_postulacion ?? '';
      const selIdeo = $in(root, '#selIdeologia');
      if (selIdeo) selIdeo.value = payload?.persona?.id_ideologia_politica ?? '';

      // temas interés (checks)
      $$in(root, '.tema-interes-chk').forEach(chk => chk.checked = false);
      (payload.temas_interes || []).forEach(t => {
        const chk = $in(root, `.tema-interes-chk[data-id="${Number(t.id_tema)}"]`);
        if (chk) chk.checked = true;
      });
      const otro = (payload.temas_interes || []).find(t => t.otro_texto);
      const inpOtro = $in(root, '#temaOtroTexto');
      if (inpOtro) inpOtro.value = otro?.otro_texto || '';
      toggleTemaOtroUI();

      // foto
      fotoUrlActual = p.foto_url || null;
      const hidFoto = $in(root, '#foto_url');
      if (hidFoto) hidFoto.value = fotoUrlActual || '';
      const img = $in(root, '#previewFoto');
      if (img) {
        img.src = fotoUrlActual || '';
        img.classList.toggle('d-none', !fotoUrlActual);
      }
    }

    // ============ buildPayload ============
    function buildPayload() {
      const form = $in(root, '#personaForm') || $in(root, 'form');
      const fd = new FormData(form);

      const munLegal   = toIntOrNull(fd.get('municipio_residencia_legal'));
      const munRealSel = toIntOrNull(fd.get('municipio_residencia_real'));
      const munTrabSel = toIntOrNull(fd.get('municipio_trabajo_politico'));

      const chkMunRealIgual    = $in(root, '#chkMunRealIgual')?.checked || false;
      const chkMunTrabajoIgual = $in(root, '#chkMunTrabajoIgual')?.checked || false;

      const selectedTemaIds = getSelectedTemasIds();
      const temas_interes = selectedTemaIds.map(id => ({ id_tema: id }));

      const fa_nivel = (fd.get('fa_nivel') || '').toString().trim();
      const fa_grado_obtenido = (fd.get('fa_grado_obtenido') || '').toString().trim();
      const fa_institucion = (fd.get('fa_institucion') || '').toString().trim();

      const persona = {
        nombre: (fd.get('nombre') || '').toString().trim(),
        apellido_paterno: (fd.get('apellido_paterno') || '').toString().trim() || null,
        apellido_materno: (fd.get('apellido_materno') || '').toString().trim() || null,
        curp: (fd.get('curp') || '').toString().trim() || null,
        rfc: (fd.get('rfc') || '').toString().trim() || null,
        clave_elector: (fd.get('clave_elector') || '').toString().trim() || null,
        estado_civil: (fd.get('estado_civil') || '').toString().trim() || null,
        escala_influencia: (fd.get('escala_influencia') || '').toString().trim() || null,

        sin_servicio_publico: $in(root, '#sin_sp')?.checked || false,
        ha_contendido_eleccion: toBoolOrNull(fd.get('ha_contendido_eleccion')),
        partido_otro_texto: (fd.get('partido_otro_texto') || '').toString().trim() || null,

        foto_url: ($in(root, "#foto_url")?.value || "").trim() || null,

        municipio_residencia_legal: munLegal,
        municipio_residencia_real: chkMunRealIgual ? munLegal : munRealSel,
        municipio_trabajo_politico: chkMunTrabajoIgual ? munLegal : munTrabSel,

        sin_controversias_publicas: $in(root, '#chkSinControversias')?.checked ?? false,
        id_partido_actual: toIntOrNull(fd.get('id_partido_actual')),
        id_grupo_postulacion: toIntOrNull(fd.get('id_grupo_postulacion')),
        id_ideologia_politica: toIntOrNull(fd.get('id_ideologia_politica')),
      };

      // formación académica
      const formacion_academica = [];
      if (fa_nivel) {
        const requiere = (fa_nivel === 'Educación Superior' || fa_nivel === 'Posgrado');
        const fa_titulado_raw = fd.get('fa_titulado');
        const fa_titulado = fa_titulado_raw === '' ? null : (fa_titulado_raw === 'true');

        if (requiere) {
          $in(root,'#fa_grado_obtenido')?.classList.toggle('is-invalid', !fa_grado_obtenido);
          $in(root,'#fa_institucion')?.classList.toggle('is-invalid', !fa_institucion);
        }

        formacion_academica.push({
          nivel: fa_nivel,
          grado_obtenido: requiere ? (fa_grado_obtenido || null) : null,
          institucion: requiere ? (fa_institucion || null) : null,
          titulado: requiere ? fa_titulado : null
        });
      }

      // telefonos
      const telefonos = [];
      $$in(root, '#telefonosContainer .list-item').forEach(item => {
        const telefono = item.querySelector('input[name="telefono"]')?.value.trim();
        const tipo = item.querySelector('select[name="tipo"]')?.value.trim();
        const principal = item.querySelector('input[name="principal"]')?.checked || false;
        if (telefono) telefonos.push({ telefono, tipo: tipo || null, principal });
      });

      // parejas
      const normalizePeriodo = (str) => (str||"").toString().replace(/\s+/g,"").trim();
      const isPeriodoValido = (p) => {
        if (!p) return true;
        if (!/^(\d{4}|\d{4}-\d{4})$/.test(p)) return false;
        const m = p.match(/^(\d{4})-(\d{4})$/);
        return !m || Number(m[2]) >= Number(m[1]);
      };

      const parejas = [];
      $$in(root, '#parejasContainer .list-item').forEach(item => {
        const nombre_pareja = item.querySelector('input[name="nombre_pareja"]')?.value.trim();
        const tipo_relacion = item.querySelector('select[name="tipo_relacion"]')?.value.trim();
        const periodoInput = item.querySelector('input[name="periodo"]');
        const periodo = normalizePeriodo(periodoInput?.value);

        if ((nombre_pareja || tipo_relacion || periodo) && !isPeriodoValido(periodo)) periodoInput?.classList.add("is-invalid");
        else periodoInput?.classList.remove("is-invalid");

        if (nombre_pareja || tipo_relacion || periodo) {
          parejas.push({
            temp_id: item.dataset.tempId,
            nombre_pareja: nombre_pareja || null,
            tipo_relacion: tipo_relacion || null,
            periodo: periodo || null
          });
        }
      });

      // hijos
      const hijos = [];
      $$in(root, '#hijosContainer .list-item').forEach(item => {
        const pareja_temp_id = item.querySelector('select[name="pareja_temp_id"]')?.value || null;
        const anio = item.querySelector('input[name="anio_nacimiento"]')?.value;
        const sexo = item.querySelector('select[name="sexo"]')?.value.trim();
        if (anio || sexo) hijos.push({ pareja_temp_id, anio_nacimiento: anio ? Number(anio) : null, sexo: sexo || null });
      });

      // redes
      const redes = [];
      $$in(root, '#redesContainer .list-item').forEach(item => {
        const id_red = item.querySelector('select[name="id_red"]')?.value;
        const url = item.querySelector('input[name="url"]')?.value.trim();
        if (id_red && url) redes.push({ id_red: Number(id_red), url });
      });

      // servicio público
      const servicio_publico = [];
      $$in(root, '#servicioContainer .list-item').forEach(item => {
        const periodo = item.querySelector('input[name="periodo"]')?.value.trim();
        const cargo = item.querySelector('input[name="cargo"]')?.value.trim();
        const dependencia = item.querySelector('input[name="dependencia"]')?.value.trim();
        if (periodo || cargo || dependencia) servicio_publico.push({ periodo: periodo||null, cargo: cargo||null, dependencia: dependencia||null });
      });

      // elecciones
      const haContendido = toBoolOrNull(fd.get('ha_contendido_eleccion'));
      const elecciones = [];
      $$in(root, '#eleccionesContainer .list-item').forEach(item => {
        const anio = item.querySelector('input[name="anio_eleccion"]')?.value;
        const candidatura = item.querySelector('input[name="candidatura"]')?.value.trim();
        const partido_postulacion = item.querySelector('input[name="partido_postulacion"]')?.value.trim();
        const resultado = item.querySelector('select[name="resultado"]')?.value.trim();
        const diferencia_votos = item.querySelector('input[name="diferencia_votos"]')?.value;
        const diferencia_porcentaje = item.querySelector('input[name="diferencia_porcentaje"]')?.value;

        const tieneAlgo = anio || candidatura || partido_postulacion || resultado || diferencia_votos || diferencia_porcentaje;
        if (tieneAlgo) {
          elecciones.push({
            anio_eleccion: anio ? Number(anio) : null,
            candidatura: candidatura || null,
            partido_postulacion: partido_postulacion || null,
            resultado: resultado || null,
            diferencia_votos: diferencia_votos ? Number(diferencia_votos) : null,
            diferencia_porcentaje: diferencia_porcentaje ? Number(diferencia_porcentaje) : null
          });
        }
      });
      if (haContendido === false) elecciones.length = 0;

      // experiencia laboral
      const experiencia_laboral = [];
      $$in(root, '#expLabContainer .list-item').forEach(item => {
        const periodo = item.querySelector('input[name="periodo"]')?.value.trim();
        const cargo = item.querySelector('input[name="cargo"]')?.value.trim();
        const organizacion = item.querySelector('input[name="organizacion"]')?.value.trim();
        if (periodo || cargo || organizacion) experiencia_laboral.push({ periodo: periodo||null, cargo: cargo||null, organizacion: organizacion||null });
      });

      // movilización
      const capacidad_movilizacion_eventos = [];
      $$in(root, '#movEventosContainer .list-item').forEach(item => {
        const nombre_evento = item.querySelector('input[name="mov_nombre_evento"]')?.value.trim();
        const fecha_evento  = item.querySelector('input[name="mov_fecha_evento"]')?.value;
        const asisVal = item.querySelector('input[name="mov_asistencia_evento"]')?.value;
        const asistencia = (asisVal === '' ? null : Number(asisVal));
        const tieneAlgo = nombre_evento || fecha_evento || asistencia != null;

        if (tieneAlgo) {
          capacidad_movilizacion_eventos.push({
            nombre_evento: nombre_evento || null,
            fecha_evento: fecha_evento || null,
            asistencia: (asistencia == null || Number.isNaN(asistencia)) ? null : asistencia
          });
        }
      });

      // tema “Otro”
      const temaOtro = (temasCatalog || []).find(t =>
        selectedTemaIds.includes(Number(t.id_tema)) && !!t.requiere_otro_texto
      );
      if (temaOtro) {
        const txt = ($in(root, '#temaOtroTexto')?.value || '').trim();
        const obj = temas_interes.find(x => x.id_tema === Number(temaOtro.id_tema));
        if (obj) obj.otro_texto = txt || null;
      }

      // equipos
      const equipos = [];
      $$in(root, '#equiposContainer .list-item').forEach(item => {
        const nombre_equipo = item.querySelector('input[name="nombre_equipo"]')?.value.trim();
        const activo = item.querySelector('select[name="activo"]')?.value;
        if (nombre_equipo) equipos.push({ nombre_equipo, activo: activo === 'true' });
      });

      // referentes (requiere nivel + nombres si escribió algo)
      const referentes = [];
      $$in(root, '#referentesContainer .list-item').forEach(item => {
        const nivelEl = item.querySelector('select[name="nivel"]');
        const nombresEl = item.querySelector('input[name="nombres"]');
        const apEl = item.querySelector('input[name="apellido_paterno"]');
        const amEl = item.querySelector('input[name="apellido_materno"]');

        const nivel = cleanText(nivelEl?.value);
        const nombres = cleanText(nombresEl?.value);
        const apellido_paterno = cleanText(apEl?.value);
        const apellido_materno = cleanText(amEl?.value);

        const tieneAlgo = nivel || nombres || apellido_paterno || apellido_materno;
        if (!tieneAlgo) {
          nivelEl?.classList.remove("is-invalid");
          nombresEl?.classList.remove("is-invalid");
          return;
        }
        const okNivel = !!nivel;
        const okNombres = !!nombres;
        nivelEl?.classList.toggle("is-invalid", !okNivel);
        nombresEl?.classList.toggle("is-invalid", !okNombres);
        if (!okNivel || !okNombres) return;

        referentes.push({ nivel, nombres, apellido_paterno: apellido_paterno||null, apellido_materno: apellido_materno||null });
      });

      // controversias
      const controversias = [];
      if (!persona.sin_controversias_publicas) {
        $$in(root, '#controversiasContainer .list-item').forEach(item => {
          const id_tipo = item.querySelector('select[name="id_tipo"]')?.value;
          const fecha_registro = item.querySelector('input[name="fecha_registro"]')?.value;
          const descripcion = item.querySelector('textarea[name="descripcion"]')?.value.trim();
          const fuente = item.querySelector('input[name="fuente"]')?.value.trim();
          const tieneAlgo = id_tipo || fecha_registro || descripcion || fuente;
          if (tieneAlgo) {
            controversias.push({
              id_tipo: id_tipo ? Number(id_tipo) : null,
              fecha_registro: fecha_registro || null,
              descripcion: descripcion || null,
              fuente: fuente || null
            });
          }
        });
      }

      // datos INE
      const datos_ine = {
        seccion_electoral: (fd.get('ine_seccion') || '').toString().trim() || null,
        distrito_federal: (fd.get('ine_df') || '').toString().trim() || null,
        distrito_local: (fd.get('ine_dl') || '').toString().trim() || null
      };
      const datosINEFinal = (datos_ine.seccion_electoral || datos_ine.distrito_federal || datos_ine.distrito_local) ? datos_ine : null;

      // familiares
      const familiares = [];
      $$in(root, '#familiaresContainer .list-item').forEach(item => {
        const nombre = item.querySelector('input[name="nombre"]')?.value.trim();
        const parentesco = item.querySelector('input[name="parentesco"]')?.value.trim();
        const cargo = item.querySelector('input[name="cargo"]')?.value.trim();
        const institucion = item.querySelector('input[name="institucion"]')?.value.trim();
        if (nombre || parentesco || cargo || institucion) familiares.push({ nombre:nombre||null, parentesco:parentesco||null, cargo:cargo||null, institucion:institucion||null });
      });

      // participación
      const participacion_organizaciones = [];
      $$in(root, '#participacionContainer .list-item').forEach(item => {
        const tipo = (item.querySelector('select[name="po_tipo"]')?.value || '').trim();
        const nombre = (item.querySelector('input[name="po_nombre"]')?.value || '').trim();
        const rol = (item.querySelector('input[name="po_rol"]')?.value || '').trim();
        const periodo = (item.querySelector('input[name="po_periodo"]')?.value || '').trim();
        const notas = (item.querySelector('input[name="po_notas"]')?.value || '').trim();
        const tieneAlgo = tipo || nombre || rol || periodo || notas;
        if (!tieneAlgo) return;
        if (!nombre) return;
        participacion_organizaciones.push({ tipo: tipo || 'otro', nombre, rol: rol||null, periodo: periodo||null, notas: notas||null });
      });

      // cargos elección popular
      const sin_cargos_eleccion_popular = $in(root, "#chkSinCargosEleccion")?.checked || false;
      const cargos_eleccion_popular = [];

      $$in(root, "#cargosEleccionContainer .list-item").forEach(item => {
        const periodoEl = item.querySelector('input[name="periodo"]');
        const cargoEl = item.querySelector('input[name="cargo"]');

        const periodo = (periodoEl?.value || "").toString().replace(/\s+/g,"").trim();
        const cargo = (cargoEl?.value || "").trim();
        const partido_postulante = item.querySelector('input[name="partido_postulante"]')?.value.trim();
        const modalidad = item.querySelector('select[name="modalidad"]')?.value.trim();

        const tieneAlgo = periodo || cargo || partido_postulante || modalidad;
        if (!tieneAlgo) return;

        const okPeriodo = !!periodo && (/^(\d{4}|\d{4}-\d{4})$/.test(periodo));
        const okCargo = !!cargo;

        periodoEl?.classList.toggle("is-invalid", !okPeriodo);
        cargoEl?.classList.toggle("is-invalid", !okCargo);

        if (!okPeriodo || !okCargo) return;

        cargos_eleccion_popular.push({
          periodo: periodo || null,
          cargo: cargo || null,
          partido_postulante: partido_postulante || null,
          modalidad: modalidad || null
        });
      });

      persona.sin_cargos_eleccion_popular = sin_cargos_eleccion_popular;
      const cargosEleccionFinal = sin_cargos_eleccion_popular ? [] : cargos_eleccion_popular;

      return {
        persona,
        datos_ine: datosINEFinal,
        telefonos,
        parejas,
        hijos,
        redes,
        servicio_publico,
        elecciones,
        cargos_eleccion_popular: cargosEleccionFinal,
        capacidad_movilizacion_eventos,
        equipos,
        referentes,
        controversias,
        familiares,
        formacion_academica,
        temas_interes,
        experiencia_laboral,
        participacion_organizaciones
      };
    }

    // ============ Bind botones “+ Agregar” del modal ============
    function bindAddButtons() {
      $in(root, '#btnAddTelefono')?.addEventListener('click', () => $in(root,'#telefonosContainer')?.appendChild(telefonoBlock()));
      $in(root, '#btnAddPareja')?.addEventListener('click', () => { $in(root,'#parejasContainer')?.appendChild(parejaBlock()); refreshHijosParejasSelects(); });
      $in(root, '#btnAddHijo')?.addEventListener('click', () => { $in(root,'#hijosContainer')?.appendChild(hijoBlock()); refreshHijosParejasSelects(); });
      $in(root, '#btnAddRed')?.addEventListener('click', () => $in(root,'#redesContainer')?.appendChild(redBlock()));
      $in(root, '#btnAddServicio')?.addEventListener('click', () => $in(root,'#servicioContainer')?.appendChild(servicioBlock()));
      $in(root, '#btnAddEleccion')?.addEventListener('click', () => $in(root,'#eleccionesContainer')?.appendChild(eleccionBlock()));
      $in(root, '#btnAddEquipo')?.addEventListener('click', () => $in(root,'#equiposContainer')?.appendChild(equipoBlock()));
      $in(root, '#btnAddReferente')?.addEventListener('click', () => $in(root,'#referentesContainer')?.appendChild(referenteBlock()));
      $in(root, '#btnAddControversia')?.addEventListener('click', () => $in(root,'#controversiasContainer')?.appendChild(controversiaBlock()));
      $in(root, '#btnAddFamiliar')?.addEventListener('click', () => $in(root,'#familiaresContainer')?.appendChild(familiarBlock()));
      $in(root, '#btnAddCargoEleccion')?.addEventListener('click', () => $in(root,'#cargosEleccionContainer')?.appendChild(cargoEleccionBlock()));
      $in(root, '#btnAddMovEvento')?.addEventListener('click', () => $in(root,'#movEventosContainer')?.appendChild(movEventoBlock()));
      $in(root, '#btnAddExpLab')?.addEventListener('click', () => $in(root,'#expLabContainer')?.appendChild(expLabBlock()));
      $in(root, '#btnAddParticipacion')?.addEventListener('click', () => $in(root,'#participacionContainer')?.appendChild(participacionBlock()));

      // toggles
      $in(root, '#fa_nivel')?.addEventListener('change', toggleFormacionAcademicaUI);
      $$in(root, '.tema-interes-chk')?.forEach(chk => chk.addEventListener('change', toggleTemaOtroUI));
    }

    // inicializa binds del modal (una vez)
    bindAddButtons();

    // API pública del shared
    return {
      setCatalogs(next = {}) {
        municipiosCache = next.municipios || municipiosCache;
        redesCatalog = next.redes || redesCatalog;
        controversiasCatalog = next.controversias || controversiasCatalog;
        temasCatalog = next.temas || temasCatalog;
        partidosCatalog = next.partidos || partidosCatalog;
        ideologiasCatalog = next.ideologias || ideologiasCatalog;
        gruposCatalog = next.grupos || gruposCatalog;
      },
      clearAll,
      applyPayloadToForm,
      buildPayload,
      toggleTemaOtroUI,
      toggleFormacionAcademicaUI,
      refreshHijosParejasSelects,
    };
  }

  window.PersonaShared = { init };
})();
