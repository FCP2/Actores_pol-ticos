// /public/js/analista.js
(() => {
  let grid = null;
  let selectedData = null;
  let perfilModalInstance = null;
  let personasCache = [];
  let municipiosJson = [];          // [{municipio, poligono}]
  let municipioIdByNorm = new Map();// norm(nombreBD) -> id
  let jsonWktByNorm = new Map();    // norm(nombreJSON) -> wkt
  let nombreById = new Map(); 
  let gridState = {
  page: 1,
  pageSize: 25
};
let currentReferente = "";     // filtro activo
let referFilterActive = false; // modo
    //helpers
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

async function loadSessionUser() {
  const r = await apiGet("/auth/me");
  window.sessionUser = r.user;

  const lblUsuario = document.getElementById("lblUsuario");
  if (lblUsuario) {
    lblUsuario.textContent = r.user.nombre || "";
  }

  const lblRol = document.getElementById("lblRol");
  if (lblRol) {
    lblRol.textContent =
      `${(r.user.roles || []).join(", ")} · ${r.user.scope || ""}`;
  }
}
/*referentes bloqueo 
function setReferenteFilter(nombre) {
  currentReferente = (nombre || "").trim();
  referFilterActive = !!currentReferente;

  // refresca grid
  if (grid) grid.setPage(1);

  // pinta mapa SOLO con municipios de las filas filtradas (SIN disparar carga por municipio)
  // esto lo hacemos desde ajaxResponse (abajo)
}

function clearReferenteFilter() {
  currentReferente = "";
  referFilterActive = false;

  // reset grid + mapa
  if (grid) grid.setPage(1);
  window.resetMunicipiosHighlight?.();
}map*/

  // Si ya tienes estas funciones en otro lado, reutilízalas.
  function showAlert(type, msg) {
    const box = document.getElementById("alertBox");
    box.className = `alert alert-${type}`;
    box.textContent = msg;
    box.classList.remove("d-none");
    setTimeout(() => box.classList.add("d-none"), 3500);
  }

  function fmtDT(dt) {
    if (!dt) return "—";
    try { return new Date(dt).toLocaleString(); } catch { return String(dt); }
  }

  function estadoBadge(p) {
    const ver = !!p?.verificado_at;
    const color = ver ? "success" : "warning";
    const txt = ver ? "Verificado (oficial)" : "Pendiente";
    const dotColor = ver ? "background: #16a34a" : "background: #f59e0b";
    return `
      <span class="badge bg-${color}-subtle text-${color} border border-${color}-subtle badge-dot">
        <span class="dot" style="${dotColor}"></span> ${txt}
      </span>
    `;
  }

function verifItem({ title, at, byName, byId, dotClass }) {
  const ok = !!at;
  // Usamos el granate para lo validado y un dorado tenue para lo pendiente
  const icon = ok 
    ? `<i class="bi bi-patch-check-fill" style="color: var(--inst-maroon)"></i>` 
    : `<i class="bi bi-clock-history" style="color: var(--inst-gold)"></i>`;

  return `
    <div class="timeline-item ${ok ? 'item-validated' : 'item-pending'}">
      <div class="timeline-dot ${ok ? 'bg-inst-maroon' : 'bg-light-gold'}"></div>
      <div class="timeline-content">
        <div class="d-flex justify-content-between align-items-start">
          <div class="d-flex flex-column">
            <span class="fw-bold small mb-0" style="color: ${ok ? '#333' : '#666'}">
              ${icon} ${title}
            </span>
            <span class="status-label ${ok ? 'text-inst-maroon' : 'text-muted'}">
              ${ok ? 'Validación Completada' : 'Pendiente de Revisión'}
            </span>
          </div>
          <small class="fw-bold text-end" style="color: var(--inst-maroon); font-size: 0.7rem;">
            ${ok ? fmtDT(at) : '-- / -- / --'}
          </small>
        </div>
        <div class="mt-1 ps-4" style="border-left: 1px solid #eee; margin-left: 6px;">
             <small class="text-muted" style="font-size: 0.75rem;">
                Responsable: <span class="fw-medium text-dark">${byName ?? byId ?? "—"}</span>
             </small>
        </div>
      </div>
    </div>
  `;
}

function renderTrazabilidad(p) {
  const el = document.getElementById("panelTrazabilidad");
  
  // Iconos con color institucional
  const icons = {
    audit: `<i class="bi bi-shield-shaded" style="color: var(--inst-maroon)"></i>`,
    created: `<i class="bi bi-plus-circle-fill" style="color: var(--inst-gold)"></i>`,
    updated: `<i class="bi bi-pencil-fill" style="color: var(--inst-gold)"></i>`,
    check: `<i class="bi bi-check-circle-fill text-inst-maroon"></i>`
  };

  el.innerHTML = `
    <div class="timeline-container">
      <div class="header-section">
        <div class="d-flex justify-content-between align-items-start flex-wrap gap-2">
          <div>
            <div class="fw-bold" style="font-size: 1rem; color: var(--inst-maroon); line-height: 1.2;">
              ${esc(p.nombre_completo || p.nombre || "Registro sin nombre")}
            </div>
            <div class="text-muted small mt-1">
              Control de historial y validación
            </div>
          </div>

          <span class="badge badge-id px-3 py-2 rounded-1 small">
            ID: ${p.id_persona ?? "—"}
          </span>
        </div>
      </div>

      <div class="mb-4 mt-3">
        <div class="d-flex align-items-center gap-2 mb-3">
          ${icons.audit}
          <span class="fw-bold small text-uppercase text-muted">Historial de Auditoría</span>
        </div>

        <div class="timeline">
          <div class="timeline-item">
            <div class="timeline-dot"></div>
            <div class="timeline-content">
              <div class="d-flex justify-content-between align-items-start">
                <span class="fw-semibold small">${icons.created} Creación</span>
                <small class="fw-bold text-inst-maroon">${fmtDT(p.created_at)}</small>
              </div>
              <div class="text-muted" style="font-size: 0.85rem;">
                Usuario: ${p.creado_por_nombre ?? p.creado_por ?? "Sistema"}
              </div>
            </div>
          </div>

          ${p.updated_at ? `
          <div class="timeline-item">
            <div class="timeline-dot"></div>
            <div class="timeline-content">
              <div class="d-flex justify-content-between align-items-start">
                <span class="fw-semibold small">${icons.updated} Última Modificación</span>
                <small class="fw-bold text-inst-maroon">${fmtDT(p.updated_at)}</small>
              </div>
              <div class="text-muted" style="font-size: 0.85rem;">
                Responsable: ${p.modificado_por_nombre ?? p.modificado_por ?? "—"}
              </div>
            </div>
          </div>` : ''}
        </div>
      </div>

      <div class="mb-0">
        <div class="d-flex align-items-center gap-2 mb-3">
          <i class="bi bi-patch-check-fill text-inst-gold"></i>
          <span class="fw-bold small text-uppercase text-muted">Niveles de Validación</span>
        </div>

        <div class="timeline">
          ${verifItem({
            title: "Dirección",
            at: p.verif_area_at,
            byName: p.verif_area_por_nombre,
            dotClass: "bg-inst-gold"
          })}

          ${verifItem({
            title: "Coordinación",
            at: p.verif_office_at,
            byName: p.verif_office_por_nombre,
            dotClass: "bg-inst-gold"
          })}

          ${verifItem({
            title: "Of. del Subsecretario",
            at: p.verificado_at,
            byName: p.verificado_por_nombre,
            dotClass: "bg-inst-maroon"
          })}
        </div>
      </div>
    </div>
  `;

  if(document.getElementById("badgeEstado")) {
    document.getElementById("badgeEstado").innerHTML = estadoBadge(p);
  }
}


function updateVerifButtons(p) {
  const scope = window.sessionUser?.scope || null;

  const btnV = document.getElementById("btnVerificar");
  const btnD = document.getElementById("btnDesverificar");
  if (!btnV || !btnD) return;

  btnV.disabled = true;
  btnD.disabled = true;

  if (!p?.id_persona) return;

  const hasArea   = !!p.verif_area_at;
  const hasOffice = !!p.verif_office_at;
  const hasAdmin  = !!p.verificado_at;

  if (scope === "AREA") {
    btnV.disabled = hasArea;
    btnD.disabled = !hasArea;
  } else if (scope === "OFFICE") {
    btnV.disabled = !hasArea || hasOffice;
    btnD.disabled = !hasOffice;
  } else if (scope === "ALL") {
    btnV.disabled = !hasOffice || hasAdmin;
    btnD.disabled = !hasAdmin;
  }
}

  function refreshGridSafe() {
    if (!grid) {
      console.log("⏳ Grid no listo");
      return;
    }
    grid.setData();  // ← RECARGA REMOTA AUTOMÁTICA
  }

function setupFilterEvents() {
  const fEstado = document.getElementById("fEstado");
  const fSearch = document.getElementById("fSearch");
  const btnBuscar = document.getElementById("btnBuscar");
  const btnFiltrarRef = document.getElementById("btnFiltrarReferente");

  const sel = document.getElementById("selReferente");
  const txt = document.getElementById("txtReferente");
  const selNivel = document.getElementById("selRefNivel");

  const fMultiMunicipio = document.getElementById("fMultiMunicipio");

  if (selNivel) {
    selNivel.addEventListener("change", async () => {
      // limpia referente seleccionado
      window._referenteMode = "";
      window._referenteCargo = "";
      if (txt) txt.value = "";
      if (sel) sel.value = "";

      await loadReferentesSelect();

      if (grid) grid.setPage(1);
      refreshGridSafe();
    });
  }

  if (sel && txt) {
    sel.addEventListener("change", () => {
      const v = String(sel.value || "").trim();
      const selectedOption = sel.options[sel.selectedIndex];

      txt.value = v;

      // exacto desde select
      window._referenteMode = v ? "exact" : "";
      window._referenteCargo = selectedOption?.dataset?.cargo || "";

      if (grid) grid.setPage(1);
      refreshGridSafe();

      document.getElementById("referenteSuggestions")?.classList.add("d-none");
    });
  }

  if (fEstado) {
    fEstado.addEventListener("change", () => {
      if (grid) grid.setPage(1);
      refreshGridSafe();
    });
  }

  if (fSearch) {
    const onSearch = debounce(() => {
      if (grid) grid.setPage(1);
      refreshGridSafe();
    }, 500);
    fSearch.addEventListener("input", onSearch);
  }

  if (btnBuscar) {
    btnBuscar.addEventListener("click", () => {
      if (grid) grid.setPage(1);
      refreshGridSafe();
    });
  }

  if (btnFiltrarRef) {
    btnFiltrarRef.addEventListener("click", () => {
      // si filtra manualmente desde txt, dejamos fuzzy
      if (!window._referenteMode) window._referenteCargo = "";
      if (grid) grid.setPage(1);
      refreshGridSafe();
    });
  }

  if (fMultiMunicipio) {
    fMultiMunicipio.addEventListener("change", () => {
      if (grid) grid.setPage(1);
      refreshGridSafe();
    });
  }
}
    // ============================
    // AUTOCOMPLETE REFERENTES
    // ============================

  function setupReferenteAutocomplete(){
    const txt = document.getElementById("txtReferente");
    const box = document.getElementById("referenteSuggestions");
    if(!txt || !box) return;

    txt.addEventListener("input", debounce(async () => {
      const q = txt.value.trim();
      if(q.length < 2){
        box.innerHTML = "";
        box.classList.add("d-none");
        return;
      }

      try{
        // usamos el grid endpoint, pero solo pedimos poquitos
        const r = await apiGet(`/personas/admin/grid?size=15&referente=${encodeURIComponent(q)}`);

        const nombres = new Set();

        (r.data || []).forEach(p => {
          const raw = (p.referentes_nombres || "").trim();
          if(!raw) return;

          raw.split("|").map(x => x.trim()).filter(Boolean).forEach(n => {
            // opcional: solo sugerir los que se parezcan a lo que escribe
            nombres.add(n);
          });
        });

        const list = [...nombres].slice(0, 10);

        if(!list.length){
          box.innerHTML = "";
          box.classList.add("d-none");
          return;
        }

        box.innerHTML = list.map(n => `
          <div class="autocomplete-item">${n}</div>
        `).join("");
        box.classList.remove("d-none");

      }catch(e){
        console.error("autocomplete referente:", e);
      }
    }, 300));

    box.addEventListener("click", (e) => {
      const item = e.target.closest(".autocomplete-item");
      if(!item) return;

      const nombre = item.textContent.trim();
      txt.value = nombre;

      // ✅ AQUÍ ESTÁ LA CLAVE:
      window._referenteMode = "exact";

      // opcional: sincroniza el select si existe
      const sel = document.getElementById("selReferente");
      if (sel) sel.value = nombre;

      box.innerHTML = "";
      box.classList.add("d-none");

      if (grid) grid.setPage(1);
      refreshGridSafe();
    });

    document.addEventListener("click", (e) => {
      if (!box.contains(e.target) && e.target !== txt) {
        box.innerHTML = "";
        box.classList.add("d-none");
      }
    });

    txt.addEventListener("input", debounce(() => {
      const v = txt.value.trim();
      if (!v) {
        window._referenteMode = "";
        const sel = document.getElementById("selReferente");
        if (sel) sel.value = "";
        if (grid) grid.setPage(1);
        refreshGridSafe();
        window.resetMunicipiosHighlight?.();
      }
    }, 200));
  }

function escAttr(s){
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function loadReferentesSelect(){
  const sel = document.getElementById("selReferente");
  const selNivel = document.getElementById("selRefNivel");
  if(!sel) return;

  try{
    const qs = new URLSearchParams();
    qs.set("mode", "ref_list");

    const nivel = String(selNivel?.value || "").trim();
    if (nivel) qs.set("refNivel", nivel);

    const r = await apiGet(`/personas/admin/grid?${qs.toString()}`);
    const items = r.data || [];

    sel.innerHTML = `<option value="">— Seleccionar referente —</option>`;

    for (const x of items) {
      const opt = document.createElement("option");
      opt.value = String(x.nombre || "").trim(); // exact name
      opt.textContent = `${x.label} (${x.menciones})`;
      opt.dataset.cargo = String(x.cargo || "").trim();
      opt.dataset.nivel = String(x.nivel || "").trim();
      sel.appendChild(opt);
    }
  } catch(e){
    console.error("Error cargando referentes", e);
  }
}

  // Debounce (si no existe)
  function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  function verifBadge(p){
  // nivel 3 (final)
  if (p.verificado_at) {
    return `<span class="badge bg-success"><i class="bi bi-shield-check me-1"></i>Final</span>`;
  }
  // nivel 2
  if (p.verif_office_at) {
    return `<span class="badge bg-primary"><i class="bi bi-check2-circle me-1"></i>Validado OFFICE</span>`;
  }
  // nivel 1
  if (p.verif_area_at) {
    return `<span class="badge bg-info text-dark"><i class="bi bi-check2-circle me-1"></i>Validado AREA</span>`;
  }
  return `<span class="badge bg-warning text-dark"><i class="bi bi-clock me-1"></i>Pendiente</span>`;
}

  function initGrid() {
    const el = document.getElementById('gridAnalista');
    if (!el) return;

    // Destruye grid anterior si existe
    if (grid) {
      grid.destroy();
      grid = null;
    }

    grid = new Tabulator(el, {
      layout: "fitColumns",
      height: "68vh",
      placeholder: "Sin registros",
      index: "id_persona",

      // ✅ PAGINACIÓN REMOTA (igual que dashboard)
      pagination: true,
      paginationMode: "remote",
      paginationSize: 25,
      paginationSizeSelector: [10, 25, 50, 100, true],

      // ✅ AJAX IGUAL QUE DASHBOARD
      ajaxURL: "/personas/admin/grid",
      ajaxConfig: { method: "GET" },

      // ✅ FUNCIÓN CRUCIAL: ajaxRequestFunc (copia exacta)
      ajaxRequestFunc: async (url, config, params) => {
        const page = params.page || 1;
        const size = params.size || 25;

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

        // ✅ TUS FILTROS ESPECÍFICOS
        const estado = document.getElementById("fEstado")?.value;
        if (estado && estado !== "all") {
          qs.set("verificado", estado);
        }
        const verif = document.getElementById("fltVerificacion")?.value;
        if (verif) {
          qs.set("verifLevel", verif);
        }
        const search = document.getElementById("fSearch")?.value?.trim();
        if (search) {
          qs.set("q", search);
        }
        const capturistaId = document.getElementById("fUsuario")?.value;
        if (capturistaId) qs.set("capturistaId", capturistaId);

        const referente = document.getElementById("txtReferente")?.value?.trim();
        if (referente) {
          qs.set("referente", referente);

          if (window._referenteMode === "exact") {
            qs.set("refMode", "exact");
          }

          if (window._referenteCargo) {
            qs.set("referenteCargo", window._referenteCargo);
          }
        }

        const refNivel = document.getElementById("selRefNivel")?.value?.trim();
        if (refNivel) {
          qs.set("refNivel", refNivel);
        }

        //filtro por municipios de trabajo politico
        const multiplesMunicipios = document.getElementById("fMultiMunicipio")?.value;
        if (multiplesMunicipios !== "") {
          qs.set("multiples_municipios", multiplesMunicipios);
        }

        return apiGet(`/personas/admin/grid?${qs.toString()}`);
      },

      // ✅ RESPUESTA DEL BACKEND (igual que dashboard)
      ajaxResponse: (url, params, resp) => {
        const total = resp.total || 0;
        const data  = resp.data || [];

        // KPIs
        const oficiales  = data.filter(x => x.verificado_at).length;
        const pendientes = total - oficiales;
        updateKPIs(total, oficiales, pendientes);

        // ============================
        // MAPA
        // ============================
        const ref = document.getElementById("txtReferente")?.value?.trim();
        const multiplesMunicipios = document.getElementById("fMultiMunicipio")?.value;

        // ✅ si está activo el filtro de múltiples municipios,
        // usa el endpoint nuevo que pinta principal + adicionales
        if (multiplesMunicipios === "1") {
          loadAndPaintFilteredMunicipios();
        } else {
          // ✅ comportamiento normal actual
          if (!ref) {
            if (window.mapReady) window.resetMunicipiosHighlight?.();
          } else {
            const ids = [...new Set(
              data.map(x => Number(x.municipio_trabajo_politico)).filter(Boolean)
            )];

            if (window.mapReady && window.highlightMunicipiosByIdList) {
              window.highlightMunicipiosByIdList(ids, { dimOthers: true });
            } else {
              window._pendingHighlightMunicipiosById = ids;
            }
          }
        }

        return {
          data,
          last_page: resp.last_page || 1,
          total_records: total,
        };
      },

      columns: [
        {
          title: "Estado",
          field: "_estado_verif",
          hozAlign: "center",
          formatter: (cell) => verifBadge(cell.getRow().getData()),
          width: 170,
        },
        {
          title: "Verif Dir.",
          field: "verif_area_por_nombre",
          formatter: (cell) => {
            const d = cell.getRow().getData();
            if (!d.verif_area_at) return `<span class="text-muted">—</span>`;
            const who = d.verif_area_por_nombre || d.verif_area_por || "—";
            return `<span class="fw-semibold">${who}</span><div class="small text-muted">${fmtDT(d.verif_area_at)}</div>`;
          },
          minWidth: 200
        },
        {
          title: "Verif Coord.",
          field: "verif_office_por_nombre",
          formatter: (cell) => {
            const d = cell.getRow().getData();
            if (!d.verif_office_at) return `<span class="text-muted">—</span>`;
            const who = d.verif_office_por_nombre || d.verif_office_por || "—";
            return `<span class="fw-semibold">${who}</span><div class="small text-muted">${fmtDT(d.verif_office_at)}</div>`;
          },
          minWidth: 200
        },
        {
          title: "Verif Subse",
          field: "verificado_por_nombre",
          formatter: (cell) => {
            const d = cell.getRow().getData();
            if (!d.verificado_at) return `<span class="text-muted">—</span>`;
            const who = d.verificado_por_nombre || d.verificado_por || "—";
            return `<span class="fw-semibold">${who}</span><div class="small text-muted">${fmtDT(d.verificado_at)}</div>`;
          },
          minWidth: 200
        },

        // ✅ COLUMNA ACCIONES CON VER + PDF
        {
          title: "Acciones",
          field: "_actions",
          width: 140, // Aumenté un poco para ambos botones
          hozAlign: "center",
          headerSort: false,
          formatter: (cell) => {
            const id = cell.getRow().getData().id_persona;
            return `
              <div class="btn-group btn-group-sm d-flex justify-content-center" role="group" style="gap: 0.25rem;">
                <button class="btn btn-outline-primary btn-fixed py-1 px-2" 
                        title="Ver perfil"
                        data-action="ver"
                        data-id="${id}">
                  <i class="bi bi-eye"></i>
                </button>
                <button class="btn btn-outline-danger btn-fixed py-1 px-2" 
                        title="Generar PDF"
                        data-action="pdf"
                        data-id="${id}">
                  <i class="bi bi-file-earmark-pdf"></i>
                </button>
              </div>
            `;
          },
          cellClick: async (e, cell) => {
            // Interceptar clicks en botones específicos
            const target = e.target.closest('button');
            if (target) {
              e.stopPropagation();
              const action = target.dataset.action;
              const id = target.dataset.id;
              
              if (action === 'ver' && id) {
                await openPerfilModal(id);
              } else if (action === 'pdf' && id) {
                await generarPDFPersona(id); // Tu función PDF aquí
              }
              return;
            }
            
            // Click fuera de botones (fallback)
            const rowData = cell.getRow().getData();
            if (rowData.id_persona) {
              await openPerfilModal(rowData.id_persona);
            }
          }
        },
        { title: "Nombre", field: "nombre_completo", sorter: "string", minWidth: 220 },
        { title: "Municipio", field: "municipio_trabajo_nombre", sorter: "string", width: 160 },
        {
          title: "Total Mun. trabajo político",
          field: "total_municipios_trabajo",
          hozAlign: "center",
          width: 110,
          formatter: (cell) => {
            const n = Number(cell.getValue() || 0);
            if (n > 1) return `<span class="badge bg-warning text-dark">${n}</span>`;
            if (n === 1) return `<span class="badge bg-secondary">1</span>`;
            return `<span class="text-muted">0</span>`;
          }
        },
        {
          title: "Capturó",
          field: "creado_por_nombre",
          minWidth: 220,
          sorter: "string",
          formatter: (cell) => {
            const row = cell.getRow().getData();
            const nombre = row.creado_por_nombre || "—";
            const cargo = row.creado_por_cargo;
            const area  = row.creado_por_area;

            const extra = [cargo, area].filter(Boolean).join(" • ");

            return `
              <div>
                <div class="fw-semibold">${nombre}</div>
                ${extra ? `<div class="text-muted small">${extra}</div>` : ""}
              </div>
            `;
          }
        },
        { title: "Creado", field: "created_at", sorter: "datetime", width: 160, formatter: (c)=> fmtDT(c.getValue()) },
        { title: "Actualizó", field: "updated_at", sorter: "datetime", width: 160, formatter: (c)=> fmtDT(c.getValue()) },
      ],
    });
    

      // ✅ ESPERA tableBuilt ANTES DE TODO
    grid.on("tableBuilt", () => {

      
      // ✅ AQUÍ SÍ puedes hacer cualquier acción
    grid.on("rowClick", async (e, row) => {
      const data = row.getData();
      selectedRow = row;
      selectedData = data;

      renderTrazabilidad(selectedData);
      updateVerifButtons(selectedData);

      const multi = document.getElementById("fMultiMunicipio")?.value;
      if (multi === "1" && data.id_persona) {
        await loadPersonaMunicipiosTrabajo(data.id_persona);
        return;
      }

      const mun = data.municipio_trabajo_nombre;
      if (window.selectMunicipioByName && mun) {
        window.selectMunicipioByName(mun);
      }
    });
    });
 

  }

  //salir modo filtro
  document.getElementById("btnResetMapaFiltroMulti")?.addEventListener("click", async () => {
    const multi = document.getElementById("fMultiMunicipio")?.value;

    // ✅ primero restaura colores KPI/base
    window.resetMunicipiosHighlight?.();

    // ✅ luego vuelve a la vista general filtrada
    if (multi === "1") {
      await loadAndPaintFilteredMunicipios();
    } else {
      window.resetMunicipiosHighlight?.();
    }

    renderPersonaMunicipiosPanel(null, []);
  });



async function onVerificar() {
  if (!selectedData?.id_persona) return;

  try {
    const id = selectedData.id_persona;
    const res = await apiPost(`/personas/analista/personas/${id}/verificar`, {});
    showAlert("success", "Registro verificado.");

    if (res?.persona) {
      selectedData = { ...selectedData, ...res.persona };

      if (selectedRow) {
        selectedRow.update(selectedData);
      }
    } else {
      const scope = window.sessionUser?.scope;
      const ahora = new Date().toISOString();
      const nombreUsuario = window.sessionUser?.nombre || "Usuario Actual";

      if (scope === "AREA") {
        selectedData.verif_area_at = ahora;
        selectedData.verif_area_por_nombre = nombreUsuario;
      } else if (scope === "OFFICE") {
        selectedData.verif_office_at = ahora;
        selectedData.verif_office_por_nombre = nombreUsuario;
      } else if (scope === "ALL") {
        selectedData.verificado_at = ahora;
        selectedData.verificado_por_nombre = nombreUsuario;
      }

      if (selectedRow) {
        selectedRow.update(selectedData);
      }
    }

    renderTrazabilidad(selectedData);
    updateVerifButtons(selectedData);

    refreshGridSafe();

  } catch (err) {
    console.error(err);
    showAlert("danger", err?.message || "No se pudo verificar.");
  }
}

async function onDesverificar() {
  if (!selectedData?.id_persona) {
    showAlert("warning", "Selecciona un registro primero");
    return;
  }

  if (!confirm("¿Seguro que deseas desverificar este registro?")) return;

  try {
    const id = selectedData.id_persona;
    const res = await apiPost(`/personas/analista/personas/${id}/desverificar`, {});
    showAlert("success", "Registro desverificado.");

    if (res?.persona) {
      selectedData = { ...selectedData, ...res.persona };

      if (selectedRow) {
        selectedRow.update(selectedData);
      }
    }

    renderTrazabilidad(selectedData);
    updateVerifButtons(selectedData);

    refreshGridSafe();

  } catch (err) {
    console.error(err);
    showAlert("danger", err?.message || "No se pudo desverificar.");
  }
}



  async function initUserHeader() {
    try {
      const resp = await apiGet("/auth/me");
      const u = resp.user || {};
      
      document.getElementById("lblUsuario").textContent = u.email || "Usuario";
      document.getElementById("lblOficina").textContent = u.nombre_oficina || `Oficina ${u.id_oficina}` || "Oficina";
      
    } catch (e) {
      console.warn("No se pudo cargar /auth/me", e);
    }
  }


  // ✅ FUNCIÓN INDEPENDIENTE (NO anidada)
  function updateNavbarInferior() {
    const coordinacion = "Coordinación de Políticas Transversales de Gobernabilidad";
    const label = document.getElementById("lblCoordinacion");
    
    if (label) {
      label.textContent = `@ATI 2026 | ${coordinacion}`;
      label.title = coordinacion;
    } else {
      console.warn("❌ #lblCoordinacion no encontrado");
    }
  }

  // ✅ LLAMADA CORRECTA
  document.addEventListener("DOMContentLoaded", () => {
    initUserHeader().then(() => {
      updateNavbarInferior(); // Después de cargar usuario
    });
  });


  // 1. initEvents()
  function initEvents() {
    // 🔥 FILTRO TARJETAS
    document.getElementById("btnIrCaptura")?.addEventListener("click", () => {
      window.location.href = "/captura";
    });
    document.getElementById("searchInput")?.addEventListener("input", applySearch);
    
    document.getElementById("btnVerificar").addEventListener("click", onVerificar);
    document.getElementById("btnDesverificar").addEventListener("click", onDesverificar);
    document.getElementById("btnLogout").addEventListener("click", () => {
      localStorage.removeItem("token");
      location.href = "/";
    });

    document.getElementById("fUsuario")?.addEventListener("change", async () => {
      // si usas Tabulator remoto:
      if (grid) grid.setPage(1);     // fuerza recarga desde página 1 con filtros nuevos
      // si no, entonces: await loadGridData();
    });

        // 👇 ESTE ES EL QUE TE FALTA
    document.getElementById("txtReferente")?.addEventListener(
      "input",
      debounce(() => {

        // si el usuario escribe manualmente → modo fuzzy
        window._referenteMode = "";

        if (grid) grid.setPage(1);
        refreshGridSafe();

      }, 350)
    );

    
      // 🔥 RESET MAPA
    document.getElementById("btnResetMap")?.addEventListener("click", () => {
      // 1. Reset select
      const sel = document.getElementById("selMunicipio");
      if (sel) sel.value = "";
      
      // 2. Reset título
      document.getElementById('munTitle').textContent = "Estado de México";
      
      // 3. 🔥 RESET COMPLETO CARDS + CONTADOR
      const cont = document.getElementById("cardsContainer");
      const countBadge = document.getElementById("countBadge");
      
      if (cont) {
        cont.innerHTML = `<div class="alert alert-light border mb-0 p-3">
          Selecciona un municipio para ver registros.
        </div>`;
      }
      
      if (countBadge) {
        countBadge.textContent = "0"; // 🔥 RESET CONTADOR
      }
      
      // 4. Limpiar cache
      personasCache = []; // 🔥 VACÍA EL CACHE
      
      // 5. Reset mapa
      if (typeof window.resetMapCoverageView === 'function') {
        window.resetMapCoverageView();
      }

    });

    document.getElementById("fltVerificacion")?.addEventListener("change", () => {
      if (grid) grid.setPage(1);
      refreshGridSafe();
    });
        
  }

  //kpi grid remoto:
  function updateKPIs(total, oficiales, pendientes) {

    
    // Números principales
    document.getElementById("lblConteo").textContent = total.toLocaleString();
    document.getElementById("lblOficiales").textContent = oficiales.toLocaleString();
    document.getElementById("lblPendientes").textContent = pendientes.toLocaleString();
    
    // Porcentajes
    const pctOficiales = total > 0 ? Math.round((oficiales / total) * 100) : 0;
    const pctPendientes = total > 0 ? Math.round((pendientes / total) * 100) : 0;
    
    document.getElementById("pctOficiales").textContent = `${pctOficiales}%`;
    document.getElementById("pctPendientes").textContent = `${pctPendientes}%`;
    
    // Barras de progreso
    document.getElementById("barOficiales").style.width = `${pctOficiales}%`;
    document.getElementById("barPendientes").style.width = `${pctPendientes}%`;
    
    // Animación suave
    document.querySelectorAll('.kpi-card').forEach((card, i) => {
      setTimeout(() => card.classList.add('animate__animated', 'animate__fadeInUp'), i * 100);
    });
  }



  //map vs kpi
  async function loadAndPaintMunicipioCoverage(){
    const resp = await apiGet('/analista/municipios/cobertura');
    const conteo = resp.data || []; // <- aquí viene directo

      if (!conteo.length) {
        console.warn("Sin cobertura para esta oficina (no hay registros con municipio).");
        // Si quieres: limpiar colores
        setMunicipioCoverageCounts(new Map());
        return;
      }

      // Map id_municipio -> {total, verificados, pendientes}
      const covMap = new Map(
        conteo.map(x => [
          Number(x.id_municipio),
          {
            total: Number(x.total || 0),
            verificados: Number(x.verificados || 0),
            pendientes: Number(x.pendientes || 0),
          }
        ])
      );

      // Ideal: map.js soporte stats (no solo total)
      // Si tu map.js solo acepta total, te dejo fallback abajo.
      if (window.setMunicipioCoverageStats) {
        window.setMunicipioCoverageStats(covMap);
      } else {
        // fallback: pinta por total solamente
        const countsMap = new Map(
          conteo.map(x => [Number(x.id_municipio), Number(x.total || 0)])
        );
        window.setMunicipioCoverageCounts?.(countsMap);
      }
  }
//funcion para filtrar y pintar mapa muchos municipios
  async function loadAndPaintFilteredMunicipios() {
    try {
      const qs = new URLSearchParams();

      // filtros iguales al grid
      const estado = document.getElementById("fEstado")?.value;
      if (estado && estado !== "all") {
        qs.set("verificado", estado);
      }

      const search = document.getElementById("fSearch")?.value?.trim();
      if (search) {
        qs.set("q", search);
      }

      const capturistaId = document.getElementById("fUsuario")?.value;
      if (capturistaId) {
        qs.set("capturistaId", capturistaId);
      }

      const referente = document.getElementById("txtReferente")?.value?.trim();
      if (referente) {
        qs.set("referente", referente);

        if (window._referenteMode === "exact") {
          qs.set("refMode", "exact");
        }

        if (window._referenteCargo) {
          qs.set("referenteCargo", window._referenteCargo);
        }
      }

      const refNivel = document.getElementById("selRefNivel")?.value?.trim();
      if (refNivel) {
        qs.set("refNivel", refNivel);
      }

      const multiplesMunicipios = document.getElementById("fMultiMunicipio")?.value;
      if (multiplesMunicipios !== "") {
        qs.set("multiples_municipios", multiplesMunicipios);
      }

      const resp = await apiGet(`/personas/admin/grid/mapa-municipios?${qs.toString()}`);
      const rows = resp.data || [];

      const ids = rows.map(x => Number(x.id_municipio)).filter(Boolean);

      if (!ids.length) {
        window.resetMunicipiosHighlight?.();
        return;
      }

      if (window.mapReady && window.highlightMunicipiosByIdList) {
        window.highlightMunicipiosByIdList(ids, { dimOthers: true });
      } else {
        window._pendingHighlightMunicipiosById = ids;
      }

    } catch (e) {
      console.error("Error cargando municipios filtrados para mapa:", e);
    }
  }

  async function loadPersonaMunicipiosTrabajo(idPersona) {
    try {
      const resp = await apiGet(`/personas/${idPersona}/municipios-trabajo`);
      const rows = resp.data || [];
        // ✅ pinta mapa solo con esos municipios
      if (rows.length) {
        if (window.mapReady && window.highlightPersonaMunicipiosDetalle) {
          window.highlightPersonaMunicipiosDetalle(rows);
        } else {
          window._pendingPersonaMunicipiosDetalle = rows;
        }
      } else {
        window.resetMunicipiosHighlight?.();
      }

      renderPersonaMunicipiosPanel(resp.persona, rows);

    } catch (e) {
      console.error("Error cargando municipios de persona:", e);
      renderPersonaMunicipiosPanel(null, []);
    }
  }

  //render panel pequeño que muestra los municipios
  function renderPersonaMunicipiosPanel(persona, rows) {
    const el = document.getElementById("panelMunicipiosPersona");
    const btn = document.getElementById("btnResetMapaFiltroMulti");
    if (!el) return;

    if (!persona || !Array.isArray(rows) || !rows.length) {
      el.innerHTML = `
        <div class="text-muted">
          Selecciona una persona en la tabla para ver su distribución territorial.
        </div>
      `;
      if (btn) btn.classList.add("d-none");
      return;
    }

    const total = rows.length;
    const principales = rows.filter(r => !!r.es_principal).length;
    const secundarios = total - principales;

    el.innerHTML = `

      <div class="panel-persona-header mb-3">
        <div class="persona-nombre">${persona.nombre_completo || "—"}</div>
        <div class="persona-sub">Distribución territorial del registro seleccionado</div>

        <div class="panel-kpis">
          <span class="badge bg-primary">${principales} principal</span>
          <span class="badge bg-info text-dark">${secundarios} secundarios</span>
          <span class="badge bg-dark">${total} municipios</span>
        </div>
      </div>

      <div class="panel-mini-chart mb-3">
        <div class="panel-mini-chart-title">Distribución territorial</div>
        <div class="panel-mini-chart-body">
          ${rows.map(r => {
            const width = r.es_principal ? 100 : 70;
            const cls = r.es_principal ? "principal" : "secundario";
            return `
              <div class="territorial-bar-row">
                <div class="territorial-label">${r.municipio || "—"}</div>
                <div class="territorial-bar-track">
                  <div class="territorial-bar-fill ${cls}" style="width:${width}%"></div>
                </div>
                <div class="territorial-bar-value">${r.es_principal ? "Principal" : "Sec."}</div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;

    if (btn) btn.classList.remove("d-none");
  }

  async function init() {
    try { await initUserHeader(); } catch (e) { console.warn(e); }
    // 1) GRID Y EVENTOS PRIMERO
    initGrid();
    initEvents();
    setupFilterEvents();
    await loadCapturistasFiltro();
    await loadKpiCompletitud();
    await loadSessionUser();
    setupReferenteAutocomplete();
    loadReferentesSelect();

    // 2) CARGAR MUNICIPIOS PRIMERO

    municipiosDb = await apiGet('/municipios');
    municipiosDb.sort((a,b)=> a.nombre.localeCompare(b.nombre,'es',{sensitivity:'base'}));

    // ✅ FIXED: POPULAR SELECT
    const sel = document.getElementById("selMunicipio");
    if (sel) {
      sel.disabled = false; // ACTIVAR
      sel.innerHTML = '<option value="">Selecciona municipio...</option>';
      municipiosDb.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id_municipio;
        opt.textContent = m.nombre;
        sel.appendChild(opt);
      });

    }

    // Mapas auxiliares
    municipioIdByNorm = new Map();
    nombreById = new Map();
    municipiosDb.forEach(m=>{
      const key = normalizeName(m.nombre);
      municipioIdByNorm.set(key, m.id_municipio);
      nombreById.set(m.id_municipio, m.nombre);
    });

    // 3) JSON POLÍGONOS
    try {
      const r = await fetch('/data/municipios.json');
      if (r.ok) {
        municipiosJson = await r.json();
        jsonWktByNorm = new Map();
        municipiosJson.forEach(m=>{
          const key = normalizeName(m.municipio);
          if (m.poligono) jsonWktByNorm.set(key, m.poligono);
        });

        const municipiosConPoligono = [];
        municipiosDb.forEach(m=>{
          const key = normalizeName(m.nombre);
          const wkt = jsonWktByNorm.get(key);
          if (wkt){
            municipiosConPoligono.push({ id_municipio: m.id_municipio, nombre: m.nombre, wkt });
          }
        });


        // MAPA DESPUÉS DE TENER DATOS
        initMap();
        drawMunicipios(municipiosConPoligono);
        await loadAndPaintMunicipioCoverage();
      }
    } catch(e) {
      console.warn("Sin polígonos:", e);
      initMap(); // mapa sin polígonos igual funciona
    }

    // 4) EVENTOS SELECT - REEMPLAZA TODO ESTE BLOQUE:


    // ✅ 1. REGISTRAR CALLBACK CON MAP.JS (IMPORTANTE: PRIMERO)
    if (typeof window.setOnMunicipioSelected === 'function') {
      window.setOnMunicipioSelected(async (id_municipio) => {
        console.log("🗺️ Click mapa →", id_municipio);

        const sel = document.getElementById("selMunicipio");
        if (sel) {
          sel.value = String(id_municipio);
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }

        window.resaltarMunicipioById?.(id_municipio);

        // ✅ SI HAY FILTRO POR REFERENTE, NO CARGUES “TODO EL MUNICIPIO”
        if (window.referFilterActive) return;

        await loadPersonasByMunicipioId(id_municipio);
      });

    }

    // ✅ 2. HACER nombreById GLOBAL (para popups)
    window.nombreById = nombreById;

    if (sel) {
      sel.addEventListener('change', async ()=>{
        const id = Number(sel.value || 0);
        if (!id) return;
        
        console.log("🔄 Select →", id);
        document.getElementById('munTitle').textContent = nombreById.get(id) || 'Municipio';
        
        if (typeof window.resaltarMunicipioById === 'function') {
          window.resaltarMunicipioById(id);
        }
        
        await loadPersonasByMunicipioId(id);
      });
    }


    // 5) GRID FINAL
    //await loadGridData();
  }
    // FIXED: Funciones de escape
  function escAttr(str) {
    return String(str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

function renderCards(list){
  const cont = document.getElementById('cardsContainer');
  cont.innerHTML = '';

  if (!list.length){
    cont.innerHTML = `
      <div class="p-4 text-center">
        <div class="border rounded-3 bg-light p-4">
          <div class="display-6 mb-1"><i class="bi bi-people"></i></div>
          <div class="fw-semibold">Sin registros</div>
          <div class="text-muted small">No hay personas registradas para este municipio.</div>
        </div>
      </div>`;
    return;
  }

  cont.innerHTML = list.map(p => {
    // Chips (reutiliza tu badge())
    const chips = [
      badge(p.oficina_nombre || '—', 'text-bg-light'),
      badge(`Capturista: ${p.creado_por_nombre || '—'}`, 'text-bg-secondary'),
      (p.modificado_por_nombre ? badge(`Mod: ${p.modificado_por_nombre}`, 'text-bg-light') : '')
    ].filter(Boolean).join('');

    // Estado (no rompe si no existe p.verificado)
    const isVer = (p.verificado === 1 || p.verificado === true);
    const estadoBadge = (p.verificado === 0 || p.verificado === 1 || typeof p.verificado === 'boolean')
      ? (isVer
          ? `<span class="badge rounded-pill text-bg-success"><i class="bi bi-check-circle me-1"></i>Verificado</span>`
          : `<span class="badge rounded-pill text-bg-warning"><i class="bi bi-clock me-1"></i>Pendiente</span>`)
      : '';

    // Meta “bonita”
    const mun = esc(p.municipio_trabajo_politico || '—');

    const creado = esc(p.creado_por_nombre || '—');
    const mod = esc(p.modificado_por_nombre || '');

    return `
      <div class="card mb-2 shadow-sm border-0">
        <div class="card-body py-2">
          <div class="d-flex align-items-center gap-3">

            <!-- Avatar -->
            <div class="flex-shrink-0">
              <img
                src="${escAttr(p.foto_url || '/img/user.png')}"
                alt="foto"
                class="rounded-circle border"
                style="width:46px;height:46px;object-fit:cover"
                onerror="this.onerror=null;this.src='/img/user.png';"
              />
            </div>

            <!-- Info -->
            <div class="min-w-0 flex-grow-1">
              <div class="d-flex align-items-start justify-content-between gap-2">
                <div class="min-w-0">
                  <div class="d-flex align-items-center gap-2 min-w-0">
                    <div class="fw-semibold text-truncate">${esc(p.nombre_completo || '—')}</div>
                    ${estadoBadge}
                  </div>

                  <div class="small text-muted text-truncate mt-1">
                    <i class="bi bi-geo-alt me-1"></i>${mun}
                  </div>

                  <div class="small text-muted mt-1 d-flex flex-wrap gap-3">
                    <span class="text-truncate">
                      <i class="bi bi-person-badge me-1"></i>${creado}
                    </span>
                    ${mod ? `
                      <span class="text-truncate">
                        <i class="bi bi-pencil-square me-1"></i>${mod}
                      </span>` : ``}
                  </div>

                  <div class="mt-2 d-flex flex-wrap gap-1">${chips}</div>
                </div>

                  <!-- Actions -->
                  <div class="btn-group btn-group-sm" role="group">
                    <button class="btn btn-outline-primary btn-fixed"
                            title="Ver perfil"
                            data-action="ver"
                            data-id="${p.id_persona}">
                      <i class="bi bi-eye"></i>
                      <span class="d-none d-md-inline ms-1">Ver</span>
                    </button>
                    <button class="btn btn-outline-secondary btn-fixed"
                            title="Generar PDF"
                            data-action="pdf"
                            data-id="${p.id_persona}">
                      <i class="bi bi-file-earmark-pdf me-1"></i>
                      PDF
                    </button>
                  </div>
                </div>
              </div>
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

    });
  });
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

// 1) Diccionario -> etiqueta bonita
const LID_TIPO_LABELS = {
  territorial: "Territorial",
  politico_institucional: "Político",
  social_comunitario: "Social",
  empresarial: "Empresarial",
  mediatico: "Mediático",
  tecnico_especializado: "Técnico",
  otro: "Otro",
};

// 2) Convierte array/string crudo a array limpio de etiquetas
function prettyLiderazgoTipos(tipos, otroTexto) {
  let arr = [];

  if (Array.isArray(tipos)) arr = tipos;
  else if (typeof tipos === "string") arr = tipos.split(","); // por si llega "a,b,c"
  else arr = [];

  const clean = arr
    .map(x => String(x || "").trim())
    .filter(Boolean);

  return clean.map(t => {
    const key = t.toLowerCase();
    if (key === "otro" && otroTexto) return `Otro: ${otroTexto}`;
    return LID_TIPO_LABELS[key] || t; // fallback
  });
}
//baner nivel de confiabilidad
function renderConfiabilidadBanner(nivel) {
  if (!nivel) return "";

  const key = String(nivel).trim().toLowerCase();

  const map = {
    alto:  { label: "Alto",  cls: "alert-success", icon: "bi-shield-check" },
    media: { label: "Medio", cls: "alert-warning", icon: "bi-shield-exclamation" }, // por si llega "media"
    medio: { label: "Medio", cls: "alert-warning", icon: "bi-shield-exclamation" },
    bajo:  { label: "Bajo",  cls: "alert-danger",  icon: "bi-shield-x" }
  };

  const c = map[key] || { label: nivel, cls: "alert-secondary", icon: "bi-info-circle" };

  // puntito tipo semáforo
  const dot =
    c.cls.includes("success") ? "background:#16a34a" :
    c.cls.includes("warning") ? "background:#f59e0b" :
    c.cls.includes("danger")  ? "background:#dc2626" :
    "background:#6b7280";

  return `
    <div class="alert ${c.cls} d-flex align-items-center justify-content-between mb-0 py-2 px-3">
      <div class="d-flex align-items-center gap-2">
        <span style="width:10px;height:10px;border-radius:999px;${dot};display:inline-block"></span>
        <i class="bi ${c.icon} fs-5"></i>
        <div class="fw-semibold">Confiabilidad: ${c.label}</div>
      </div>
      <span class="badge text-bg-light border">Semáforo</span>
    </div>
  `;
}
// helper para setText con fallback
function setText(id, value){
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = (value === undefined || value === null || value === '') ? '—' : String(value);
}
function setHtmlIfExists(id, html){
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = html;
}

//mapeo participacion 
function labelParticipacionTipo(tipoRaw) {
  const t = (tipoRaw || "").toString().trim().toLowerCase();

  const map = {
    partido: "Partido",
    organizacion_politica: "Organización política",
    organizacion_social: "Organización social",
    organizacion_civil: "Organización civil",
    sindicato: "Sindicato",
    camara_empresarial: "Cámara empresarial",
    otro: "Otro",
  };

  // si no está en el mapa, lo "humaniza"
  if (map[t]) return map[t];

  // fallback: "organizacion_politica" -> "Organizacion politica" (sin acentos)
  // si quieres acentos perfectos, agrega el tipo al map de arriba
  return t
    .replace(/_/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
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
 // reset foto borrar estado anterior
  const img = document.getElementById("perfilFoto");
  const fb  = document.getElementById("perfilFotoFallback");
  img.src = "";
  img.style.display = "none";
  fb.style.display = "inline-block";

  try {
      const p = await apiGet(`/personas/${idPersona}/perfil`);
      // NIVEL DE CONFIABILIDAD
      const banner = document.getElementById("perfilConfiabilidadBanner");
      if (p.nivel_confiabilidad) {
        banner.innerHTML = renderConfiabilidadBanner(p.nivel_confiabilidad);
        banner.classList.remove("d-none");
      } else {
        banner.innerHTML = "";
        banner.classList.add("d-none");
      }
    // FOTO
    const img = document.getElementById("perfilFoto");
    const fb  = document.getElementById("perfilFotoFallback");

    const url = (p.foto_url || "").trim();

    if (url) {
      img.src = url;
      img.style.display = "inline-block";
      fb.style.display = "none";

      // fallback si falla la imagen
      img.onerror = () => {
        img.style.display = "none";
        fb.style.display = "inline-block";
        img.onerror = null;
      };
    } else {
      img.style.display = "none";
      fb.style.display = "inline-block";
    }
    // Nombre completo
    const nombreCompleto = [p.nombre, p.apellido_paterno, p.apellido_materno].filter(Boolean).join(' ');
    document.getElementById('perfilModalTitle').textContent = nombreCompleto || 'Perfil';

    // Municipio subtitle (prioridad: trabajo > real > legal)
    const mun = p.municipio_trabajo_politico
      || p.residencia_real_display
      || p.residencia_legal_display
      || '—';
    document.getElementById('perfilModalSubtitle').textContent = `• ${mun}`;

    // Badges principales
    const partido = p.partido_actual_siglas || p.partido_actual || null;

    // ✅ grupos de postulación (multi) con fallback al viejo campo
    const gruposPostulacion = Array.isArray(p.grupos_postulacion) && p.grupos_postulacion.length
      ? p.grupos_postulacion
      : (p.grupo_postulacion ? [{ nombre: p.grupo_postulacion }] : []);

    const gruposPostulacionBadges = gruposPostulacion.map(g =>
      badgeHtml(g?.nombre || '—', 'text-bg-light border')
    ).join(' ');

    const badgesPerfil = [
      badgeEscalaInfluencia(p.escala_influencia),
      badgeHtml(partido, 'text-bg-dark'),
      badgeHtml(p.ideologia_politica, 'text-bg-secondary'),
      badgeHtml(p.tema_interes_central, 'text-bg-warning'),
      (p.sin_controversias_publicas === true ? badgeHtml('Sin controversias', 'text-bg-success') : '')
    ].filter(Boolean).join(' ');

    // Badges meta (captura/modificación)


    // Render final
    document.getElementById('perfilBadges').innerHTML = `
      <div class="d-flex flex-column gap-2">
        <div class="d-flex flex-wrap gap-1">
          ${badgesPerfil || `<span class="text-muted small">—</span>`}
        </div>

        <div class="d-flex flex-wrap gap-1 align-items-center">
          <span class="small text-muted fw-semibold me-1">Grupos de postulación:</span>
          ${gruposPostulacionBadges || `<span class="text-muted small">—</span>`}
        </div>
      </div>
    `;

    const TZ_MX = "America/Mexico_City";

    function fmtDateMX(dt) {
      if (!dt) return "—";

      const d = new Date(dt);
      if (Number.isNaN(d.getTime())) return String(dt);

      return new Intl.DateTimeFormat("es-MX", {

        timeZone: TZ_MX,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
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

    setText('v_mun_legal', p.residencia_legal_display || p.municipio_residencia_legal || '—');
    setText('v_mun_real',  p.residencia_real_display  || p.municipio_residencia_real  || '—');
    setText('v_mun_trab',  p.municipio_trabajo_politico || '—');

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

    //Municipalidades de trabajo (lista nueva)
    const munTrab = listOrEmpty(p.municipios_trabajo);
    setHtmlIfExists('v_municipios_trabajo', renderSimpleList(munTrab, (m) => {
      const pri = m.es_principal ? `<span class="badge text-bg-success ms-2">Principal</span>` : '';
      const notas = m.notas ? `<div class="text-muted small">${esc(m.notas)}</div>` : '';
      return `
        <div class="border rounded p-2">
          <div class="d-flex align-items-center justify-content-between gap-2">
            <div class="fw-semibold">${esc(m.municipio || '—')}</div>
            <div>${pri}</div>
          </div>
          ${notas}
        </div>
      `;
    }) || `<span class="text-muted small">—</span>`);

    //Fuentes de consulta (nueva)
    const fuentes = listOrEmpty(p.fuentes_consulta);
    setHtmlIfExists('v_fuentes', renderSimpleList(fuentes, (f) => {
      const head = esc(f.fuente || `Fuente #${f.id_fuente || '—'}`);
      const fecha = f.fecha_consulta ? `<div class="text-muted small">Fecha: ${esc(f.fecha_consulta)}</div>` : '';
      const det = f.detalle ? `<div class="text-muted small">${esc(f.detalle)}</div>` : '';

      return `
        <div class="border rounded p-2">
          <div class="fw-semibold">${head}</div>
          ${fecha}
          ${det}
        </div>
      `;
    }) || `<span class="text-muted small">—</span>`);

    // Liderazgo e influencia
    const lid = p.liderazgo_influencia;

    if (!lid) {
      document.getElementById("v_liderazgo").innerHTML = `<span class="text-muted small">—</span>`;
    } else {
      const nivel = lid.nivel ? esc(String(lid.nivel).toUpperCase()) : "—";
      const presencia = lid.presencia_territorial ? esc(lid.presencia_territorial) : "—";
      const cuenta = (lid.cuenta_con_estructura === true) ? "Sí" : (lid.cuenta_con_estructura === false ? "No" : "—");

      const tiposBonitos = prettyLiderazgoTipos(lid.tipos, lid.tipo_otro_texto);

      const tiposHtml = tiposBonitos.length
        ? `<div class="d-flex flex-wrap gap-1">
            ${tiposBonitos.map(t => `<span class="badge text-bg-light border">${esc(t)}</span>`).join("")}
          </div>`
        : `<span class="text-muted small">—</span>`;

      document.getElementById("v_liderazgo").innerHTML = `
        <div class="border rounded p-2">
          <div class="row g-2 small">
            <div class="col-12"><span class="text-muted">Nivel:</span> <b>${nivel}</b></div>
            <div class="col-12"><span class="text-muted">Presencia territorial:</span> <b>${esc(presencia)}</b></div>
            <div class="col-12"><span class="text-muted">Cuenta con estructura:</span> <b>${esc(cuenta)}</b></div>
            <div class="col-12 mt-1"><span class="text-muted">Tipos:</span><div class="mt-1">${tiposHtml}</div></div>
          </div>
        </div>
      `;
    }

    // Empresas 
    const emps = listOrEmpty(p.empresas);
    setHtmlIfExists('v_empresas', renderSimpleList(emps, (e) => {
      const head = esc(e.nombre_empresa || '—');
      const rol = [e.rol, e.rol_otro].filter(Boolean).map(esc).join(' / ');
      const rel = [e.nombre_relacionado, e.relacion].filter(Boolean).map(esc).join(' • ');
      const per = e.periodo ? `<div class="text-muted small">${esc(e.periodo)}</div>` : '';
      const notas = e.notas ? `<div class="text-muted small">${esc(e.notas)}</div>` : '';
      return `
        <div class="border rounded p-2">
          <div class="fw-semibold">${head}</div>
          ${rol ? `<div class="text-muted small">${rol}</div>` : ''}
          ${rel ? `<div class="text-muted small">${rel}</div>` : ''}
          ${per}
          ${notas}
        </div>
      `;
    }) || `<span class="text-muted small">—</span>`);

    // Cargos elección popular
    const cargosEP = listOrEmpty(p.cargos_eleccion_popular);
    setHtmlIfExists('v_cargos_ep', renderSimpleList(cargosEP, (c) => {
      // ✅ display primero (nuevo), si no existe usa legacy
      const cargoTxt = c.cargo_display || c.cargo_catalogo || c.cargo || '—';
      const partidoTxt = c.partido_display || c.partido_postulante_siglas || c.partido_postulante_catalogo || c.partido_postulante || null;

      const metaParts = [
        c.periodo,
        c.modalidad ? String(c.modalidad).toUpperCase() : null,
        partidoTxt
      ].filter(Boolean).map(esc);

      const suplente = (c.es_suplente === true)
        ? `<span class="badge text-bg-warning ms-2">Suplente</span>`
        : '';

      const titular = (c.es_suplente === true && c.titular_candidatura)
        ? `<div class="text-muted small mt-1">Titular: <b>${esc(c.titular_candidatura)}</b></div>`
        : '';

      const orden = c.orden_gobierno
        ? `<span class="badge text-bg-light border ms-2">${esc(c.orden_gobierno)}</span>`
        : '';

      return `
        <div class="border rounded p-2">
          <div class="d-flex align-items-center flex-wrap gap-2">
            <div class="fw-semibold">${esc(cargoTxt)}</div>
            ${suplente}
            ${orden}
          </div>
          ${metaParts.length ? `<div class="text-muted small">${metaParts.join(' • ')}</div>` : ''}
          ${titular}
        </div>
      `;
    }) || `<span class="text-muted small">—</span>`);

    // Eventos movilización (lista)
    const eventos = listOrEmpty(p.capacidad_movilizacion_eventos);
    setHtmlIfExists('v_eventos_movilizacion', renderSimpleList(eventos, (e) => {
      const head = esc(e.nombre_evento || '—');
      const meta = [
        e.fecha_evento ? `Fecha: ${e.fecha_evento}` : null,
        e.asistencia != null ? `Asistencia: ${e.asistencia}` : null,
        e.lugar_evento ? `Lugar: ${e.lugar_evento}` : null
      ].filter(Boolean).map(esc).join(' • ');

      const fotos = Array.isArray(e.fotos) ? e.fotos.filter(Boolean) : [];
      const fotosHtml = fotos.length ? `
        <div class="d-flex flex-wrap gap-2 mt-2">
          ${fotos.map(url => `
            <a href="${escAttr(url)}" target="_blank" rel="noopener">
              <img src="${escAttr(url)}" style="width:92px;height:64px;object-fit:cover" class="rounded border">
            </a>
          `).join('')}
        </div>
      ` : '';

      return `
        <div class="border rounded p-2">
          <div class="fw-semibold">${head}</div>
          ${meta ? `<div class="text-muted small">${meta}</div>` : ''}
          ${fotosHtml}
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
      const tipoLabel = o.tipo ? labelParticipacionTipo(o.tipo) : null;
      const top = `${tipoLabel ? esc(tipoLabel) + ': ' : ''}${esc(o.nombre || '—')}`;

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
                  <span class="text-muted small">Años: ${esc(h.anios ?? '—')}</span>
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
    // Referentes (FIX: cargo no definido)
    const refs = listOrEmpty(p.referentes);

    document.getElementById('v_referentes').innerHTML = renderSimpleList(refs, (r) => {
      const nombreRef = [r.nombres, r.apellido_paterno, r.apellido_materno]
        .filter(Boolean)
        .map(esc)
        .join(' ') || '—';

      const lvl = r.nivel
        ? `<span class="badge text-bg-info ms-2">${esc(r.nivel)}</span>`
        : '';

      // ✅ aquí estaba el bug: antes usabas `cargo` sin declararlo
      const cargoHtml = r.cargo
        ? `<div class="text-muted small mt-1">${esc(r.cargo)}</div>`
        : '';

      return `
        <div class="border rounded p-2">
          <div class="d-flex align-items-center flex-wrap gap-2">
            <div class="fw-semibold">${nombreRef}</div>
            ${lvl}
          </div>
          ${cargoHtml}
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
          console.log("RAW created_at:", p.created_at);
      console.log("RAW updated_at:", p.updated_at);

      console.log("DATE created ISO:", new Date(p.created_at).toISOString());
      console.log("DATE updated ISO:", new Date(p.updated_at).toISOString());
  } catch (err) {
    console.error(err);
    showPerfilState({loading:false, error:'No pude cargar el perfil. ' + (err.message || '')});
  }
}


  // 2. applySearch() FIX:
  function applySearch(){
    const q = norm(document.getElementById('searchInput').value);
    const filtered = !q ? personasCache : personasCache.filter(p => norm(p.nombre_completo).includes(q));
    const countEl = document.getElementById('countBadge') || document.getElementById('lblConteo');
    if (countEl) countEl.textContent = filtered.length;
    renderCards(filtered);
  }

  // 3. norm() usa nombre_completo:
  function norm(s){
    return (s || '').toString().trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  // Reemplaza SOLO esta función en tu analista.js:
  async function loadPersonasByMunicipioId(idMunicipio){
    currentMunicipioTrabajoId = Number(idMunicipio) || null;
    
    // ✅ SAFE: Verifica existencia ANTES de usar
    const countBadge = document.getElementById('countBadge');
    const lblConteo = document.getElementById('lblConteo');
    const loadingEl = countBadge || lblConteo;
    
    if (loadingEl) loadingEl.textContent = '... cargando';

    try {
      const resp = await apiGet(`/personas/admin/cards?municipio_trabajo=${idMunicipio}&page=1&size=500`);
      personasCache = resp.data || [];
      
      const total = String(resp?.total ?? personasCache.length);
      if (countBadge) countBadge.textContent = total;
      if (lblConteo && !countBadge) lblConteo.textContent = `${total} registros`;
      
      applySearch();
    } catch(e) {
      console.error('Error cargando personas:', e);
      if (loadingEl) loadingEl.textContent = 'Error';
    }
  }
  //filtro registro por usuarios
  async function loadCapturistasFiltro() {
    const sel = document.getElementById("fUsuario");
    if (!sel) return;

    // 👇 ya lo tienes en routes: GET /personas/admin/capturistas
    const resp = await apiGet("/personas/admin/capturistas");
    const list = resp.data || resp || [];

    sel.innerHTML = `<option value="">Todos</option>` + list.map(u => `
      <option value="${u.id_usuario}">
        ${u.nombre}${u.cargo ? ` (${u.cargo})` : ""}${u.area ? ` - ${u.area}` : ""}
      </option>
    `).join("");
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
// KPI COMPLETUD - FUNCIONALIDAD IGUAL, SOLO MEJORADO VISUAL
// KPI COMPLETUD + MUNICIPIOS - VERSIÓN FINAL
async function loadKpiCompletitud() {
  const body = document.getElementById("kpiCompletitudBody");
  if (!body) return;

  body.innerHTML = `
    <div class="text-center py-4">
      <div class="spinner-border spinner-border-sm text-primary me-2" role="status"></div>
      <small class="text-muted">Cargando dashboard...</small>
    </div>
  `;

  try {
    // CARGAR AMBOS ENDPOINTS EN PARALELO
    const [respCompletitud, respMunicipios] = await Promise.all([
      apiGet("/personas/admin/kpis/completitud"),
      apiGet("/personas/admin/kpis/municipios")
    ]);

    const g = respCompletitud.global || {};
    const rows = respCompletitud.por_usuario || [];
    const municipios = respMunicipios.top10 || []; // TOP 10 MUNICIPIOS
    const resumen = respMunicipios.resumen || {};

    body.innerHTML = `
      <!-- HEADER DASHBOARD -->
      <div class="futurista-kpi-header">
        <div class="futurista-kpi-title-group">
          <div class="futurista-kpi-icon-pulse">
            <i class="bi bi-clipboard-check futurista-kpi-icon-glow"></i>
          </div>
          <div>
            <h5 class="futurista-kpi-title">Dashboard Completitud Formularios</h5>
            <small class="futurista-kpi-subtitle">
              Global • Usuarios • ${resumen.total_municipios ?? 0} Municipios • Actualizado hoy
            </small>
          </div>
        </div>
        <div class="futurista-kpi-score-badge">
          <i class="bi bi-graph-up"></i> ${g.score_promedio ?? "0.00"} Score Promedio
        </div>
      </div>

      <!-- KPI CARDS PRINCIPALES (sin cambios) -->
      <div class="futurista-kpi-grid">
        <!-- TOTAL REGISTROS -->
        <div class="futurista-kpi-card futurista-kpi-total">
          <div class="futurista-kpi-card-inner">
            <div class="futurista-kpi-icon futurista-kpi-icon-people">
              <i class="bi bi-people"></i>
            </div>
            <div class="futurista-kpi-content">
              <div class="futurista-kpi-label">Total Registros</div>
              <div class="futurista-kpi-value">${g.total_personas?.toLocaleString() ?? 0}</div>
              <div class="futurista-kpi-trend futurista-kpi-trend-up">
                <i class="bi bi-arrow-up"></i> +12% vs mes anterior
              </div>
            </div>
          </div>
        </div>

        <!-- COMPLETOS ≥80% -->
        <div class="futurista-kpi-card futurista-kpi-success">
          <div class="futurista-kpi-card-inner">
            <div class="futurista-kpi-icon futurista-kpi-icon-success">
              <i class="bi bi-check-circle"></i>
            </div>
            <div class="futurista-kpi-content">
              <div class="futurista-kpi-label">Completos ≥ 80%</div>
              <div class="futurista-kpi-value">${g.completos_80 ?? 0}</div>
              <div class="futurista-kpi-progress">
                <div class="futurista-kpi-progress-bar" style="width: ${g.pct_completos_80 ?? 0}%"></div>
                <small>${g.pct_completos_80 ?? 0}%</small>
              </div>
            </div>
          </div>
        </div>

        <!-- CRÍTICOS <50% -->
        <div class="futurista-kpi-card futurista-kpi-warning">
          <div class="futurista-kpi-card-inner">
            <div class="futurista-kpi-icon futurista-kpi-icon-warning">
              <i class="bi bi-exclamation-triangle"></i>
            </div>
            <div class="futurista-kpi-content">
              <div class="futurista-kpi-label">Formularios incompletos &lt; 50%</div>
              <div class="futurista-kpi-value">${g.criticos_lt50 ?? 0}</div>
              <div class="futurista-kpi-trend futurista-kpi-trend-down">
                <i class="bi bi-arrow-down"></i> ${g.criticos_lt50 ?? 0} registros
              </div>
            </div>
          </div>
        </div>

        <!-- SCORE PROMEDIO -->
        <div class="futurista-kpi-card futurista-kpi-primary">
          <div class="futurista-kpi-card-inner">
            <div class="futurista-kpi-icon futurista-kpi-icon-gauge">
              <i class="bi bi-speedometer2"></i>
            </div>
            <div class="futurista-kpi-content">
              <div class="futurista-kpi-label">Score Promedio</div>
              <div class="futurista-kpi-value">${(g.score_promedio ?? 0).toFixed(1)}</div>
              <div class="futurista-kpi-gauge" data-score="${g.score_promedio ?? 0}">
                <div class="futurista-kpi-gauge-fill"></div>
                <div class="futurista-kpi-gauge-glow"></div>
              </div>
            </div>
          </div>
        </div>
      </div>

        <!-- kpi municipios -->
      <div class="futurista-kpi-municipio-section">
        <div class="futurista-kpi-section-header">
          <h6 class="futurista-kpi-section-title">
            <i class="bi bi-geo-alt futurista-kpi-icon-small"></i>
            Municipios Trabajo Político
          </h6>
          <div class="futurista-kpi-section-stats">
            <div class="futurista-kpi-muni-stats-grid">
              <div class="futurista-kpi-stat-item active-munis">
                <div class="futurista-kpi-stat-number">${resumen.municipios_con_registros ?? 0}</div>
                <div class="futurista-kpi-stat-label">Municipios Activos</div>
                <div class="futurista-kpi-stat-total">${resumen.total_municipios ?? 0} total</div>
              </div>
              <div class="futurista-kpi-stat-separator"></div>
              <div class="futurista-kpi-stat-item total-personas">
                <div class="futurista-kpi-stat-number">${resumen.total_personas?.toLocaleString() ?? 0}</div>
                <div class="futurista-kpi-stat-label">Total Registros</div>
                <div class="futurista-kpi-stat-progress">
                  <div class="futurista-kpi-stat-progress-bar" style="width: 100%"></div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- CHARTS CONTAINER -->
        <div class="futurista-kpi-charts-grid">
          <!-- GRÁFICA 1: TOP 10 BARRAS HORIZONTALES -->
          <div class="futurista-kpi-chart-card">
            <div class="futurista-kpi-chart-header">
              <h6>Top 10 Municipios</h6>
              <div class="futurista-kpi-legend">
                <span class="legend-item">
                  <span class="legend-color"></span> Toluca
                </span>
              </div>
            </div>
            <canvas id="topMunicipiosChart"></canvas>
          </div>

          <!-- GRÁFICA 2: DONUT DISTRIBUCIÓN -->
          <div class="futurista-kpi-chart-card">
            <div class="futurista-kpi-chart-header">
              <h6>Distribución Total</h6>
              <div class="futurista-kpi-legend">
                <span>Con registros</span>
                <span class="text-success">${resumen.municipios_con_registros ?? 0}</span>
              </div>
            </div>
            <canvas id="distribucionChart"></canvas>
          </div>

          <!-- GRÁFICA 3: BARRAS VERTICALES BOTTOM 10 -->
          <div class="futurista-kpi-chart-card">
            <div class="futurista-kpi-chart-header">
              <h6>Oportunidades (Bottom 10)</h6>
              <div class="futurista-kpi-legend">
                <span>Sin registros</span>
                <span class="text-warning">${resumen.municipios_sin_registros ?? 0}</span>
              </div>
            </div>
            <canvas id="oportunidadesChart"></canvas>
          </div>
        </div>
      </div>

      <!-- TABLA USUARIOS CON ÁREA -->
      <div class="futurista-kpi-table-card">
        <div class="futurista-kpi-table-header">
          <h6><i class="bi bi-person-lines-fill futurista-kpi-icon-small"></i>Por Usuario</h6>
        </div>
        <div class="futurista-kpi-table-body">
          <div class="table-responsive">
            <table class="futurista-kpi-table">
              <thead>
                <tr>
                  <th style="width: 40%">Usuario</th>
                  <th class="text-center" style="width: 12%">Total</th>
                  <th class="text-center" style="width: 12%">Score</th>
                  <th class="text-center" style="width: 12%">✓ ≥80%</th>
                  <th class="text-center" style="width: 12%">%</th>
                  <th class="text-center" style="width: 12%">Área</th>
                </tr>
              </thead>
              <tbody>
                ${rows.slice(0, 10).map(r => `
                  <tr class="futurista-kpi-user-row">
                    <td>
                      <div class="futurista-kpi-user-info">
                        <div class="futurista-kpi-avatar" style="background: linear-gradient(135deg, hsl(${Math.floor(Math.random()*360)}, 70%, 60%), hsl(${Math.floor(Math.random()*360)+60}, 70%, 55%))">
                          ${(r.nombre || '').charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <div class="fw-semibold">${esc(r.nombre || "—")}</div>
                          <small class="text-muted">${esc(r.email || "")}</small>
                        </div>
                      </div>
                    </td>
                    <td class="text-center futurista-kpi-number">${r.total ?? 0}</td>
                    <td class="text-center">
                      <span class="futurista-kpi-score-badge" data-score="${r.score_promedio ?? 0}">
                        ${(r.score_promedio ?? 0).toFixed(1)}
                      </span>
                    </td>
                    <td class="text-center">${r.completos_80 ?? 0}</td>
                    <td class="text-center">
                      <div class="futurista-kpi-mini-progress">
                        <div class="futurista-kpi-mini-progress-bar" style="width: ${r.pct_completos_80 ?? 0}%"></div>
                      </div>
                      <small>${r.pct_completos_80 ?? 0}%</small>
                    </td>
                    <td class="text-center">
                      <span class="futurista-kpi-area-badge-multiline">
                        ${esc(r.area || 'Sin área')}
                      </span>
                    </td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>
      </div>

    `;

    // GUARDAR DATOS PARA CHARTS
    window.chartsMunicipios = respMunicipios;

    // Inicializar todo
    setTimeout(() => {
      initFuturistaKpiAnimations();
    }, 300);

  } catch (err) {
    console.error(err);
    body.innerHTML = `
      <div class="futurista-kpi-error">
        <i class="bi bi-exclamation-triangle-fill futurista-kpi-error-icon"></i>
        <div>No pude cargar el Dashboard KPI</div>
      </div>
    `;
  }
}

  document.getElementById("btnKpiCompletitudReload")?.addEventListener("click", loadKpiCompletitud);

  function initFuturistaKpiAnimations() {
    // Animar gauge principal
    document.querySelectorAll('.futurista-kpi-gauge').forEach(gauge => {
      const score = parseFloat(gauge.dataset.score) || 0;
      const fill = gauge.querySelector('.futurista-kpi-gauge-fill');
      const angle = (score / 100) * 180;
      fill.style.transform = `rotate(${-90 + angle}deg)`;
    });

  // Animar score badges
  document.querySelectorAll('.futurista-kpi-score-badge').forEach(badge => {
    const score = parseFloat(badge.dataset.score) || 0;
    const hue = 240 - (score * 2); // Verde a rojo
    badge.style.background = `linear-gradient(135deg, hsl(${hue}, 70%, 55%), hsl(${hue - 20}, 70%, 50%))`;
  });

  // Efecto hover en filas
  document.querySelectorAll('.futurista-kpi-user-row').forEach(row => {
    row.addEventListener('mouseenter', () => {
      row.style.transform = 'scale(1.01)';
    });
    row.addEventListener('mouseleave', () => {
      row.style.transform = 'scale(1)';
    });
  });
    // INICIALIZAR CHARTS DESPUÉS DE DOM
  if (window.chartsMunicipios) {
    initMunicipiosCharts(window.chartsMunicipios);
  }
}

function fixTableScroll() {
  const tableBody = document.querySelector('.futurista-kpi-table-body');
  if (!tableBody) return;

  let isScrolling = false;

  // 🛑 Previene vibración scroll
  tableBody.addEventListener('wheel', (e) => {
    e.stopPropagation();
    if (!isScrolling) {
      isScrolling = true;
      setTimeout(() => { isScrolling = false; }, 50);
    }
  }, { passive: false });

  // 📱 Touch smooth
  tableBody.addEventListener('touchmove', (e) => {
    e.stopPropagation();
  }, { passive: false });
}

// Llama después de render
setTimeout(fixTableScroll, 500);

function initMunicipiosCharts(respMunicipios) {
  const { top10, bottom10, resumen, cero } = respMunicipios;

  // 1. TOP 10 - BARRAS HORIZONTALES
  const topCtx = document.getElementById('topMunicipiosChart');
  if (topCtx && top10?.length) {
    new Chart(topCtx, {
      type: 'bar',
      data: {
        labels: top10.map(m => m.municipio.slice(0, 25)),
        datasets: [{
          label: 'Registros',
          data: top10.map(m => m.total),
          backgroundColor: top10.map((_, i) => `hsl(${220 + i * 15}, 70%, 55%)`),
          borderColor: top10.map((_, i) => `hsl(${220 + i * 15}, 70%, 45%)`),
          borderRadius: 8,
          borderWidth: 2,
          barThickness: 24,
        }]
      },
      options: {
        indexAxis: 'y', // ← Barras horizontales
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: {
            beginAtZero: true,
            grid: { display: false },
            ticks: { font: { size: 12, weight: '600' } }
          },
          y: {
            grid: { color: 'rgba(0,0,0,0.05)' },
            ticks: { font: { size: 11 } }
          }
        },
        animation: {
          duration: 2000,
          easing: 'easeOutQuart'
        }
      }
    });
  }

  // 2. DISTRIBUCIÓN - DONUT
  const donutCtx = document.getElementById('distribucionChart');
  if (donutCtx && top10?.length) {
    const otros = Math.max(resumen.total_personas - top10.reduce((sum, m) => sum + m.total, 0), 0);
    new Chart(donutCtx, {
      type: 'doughnut',
      data: {
        labels: ['Top 10', `Otros (${otros.toLocaleString()})`],
        datasets: [{
          data: [top10.reduce((sum, m) => sum + m.total, 0), otros],
          backgroundColor: ['hsl(220, 70%, 55%)', 'hsl(30, 70%, 60%)'],
          borderWidth: 0,
          cutout: '65%'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { padding: 20, font: { size: 13, weight: '600' } }
          }
        },
        animation: {
          animateRotate: true,
          duration: 2500
        }
      }
    });
  }

  // 3. BOTTOM 10 - BARRAS VERTICALES
  const bottomCtx = document.getElementById('oportunidadesChart');
  if (bottomCtx && bottom10?.length) {
    new Chart(bottomCtx, {
      type: 'bar',
      data: {
        labels: bottom10.map(m => m.municipio.slice(0, 20)),
        datasets: [{
          label: 'Registros',
          data: bottom10.map(m => m.total),
          backgroundColor: bottom10.map((_, i) => `hsl(${40 + i * 10}, 70%, ${50 + i * 3}%)`),
          borderRadius: 6,
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: {
            beginAtZero: true,
            max: Math.max(...bottom10.map(m => m.total)) * 1.2,
            grid: { display: false },
            ticks: { font: { size: 12 } }
          },
          x: {
            grid: { color: 'rgba(0,0,0,0.05)' },
            ticks: { font: { size: 11 }, maxRotation: 45 }
          }
        },
        animation: {
          delay: 500,
          duration: 2000,
          easing: 'easeOutBounce'
        }
      }
    });
  }
}


  //escala influencia 
  function badgeEscalaInfluencia(val) {
    if (!val) return '';

    const map = {
      municipal:  'text-bg-success',
      distrital:  'text-bg-info',
      regional:   'text-bg-primary',
      estatal:    'text-bg-warning',
      nacional:   'text-bg-danger'
    };

    const key = val.toLowerCase().trim();
    const cls = map[key] || 'text-bg-secondary';

    return badgeHtml(capitalize(val), cls);
  }

  function capitalize(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : "";
  }

  function badge(text, cls){
    if (!text) return '';
    return `<span class="badge ${cls} me-1 mb-1">${text}</span>`;
  }

  window.addEventListener("DOMContentLoaded", init);


})();
