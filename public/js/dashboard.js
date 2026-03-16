/* =========================
   DASHBOARD SUPERADMIN
   ========================= */

(() => {
  "use strict";

/* =========================
   CONFIG
   ========================= */
const GRID_DATA_URL = "/api/personas/admin/grid";
const KPI_MUNICIPIOS_URL = "/api/personas/admin/kpis/municipios";
const OFICINAS_URL = "/api/personas/admin/oficinas";
const CAPTURISTAS_URL = "/api/personas/admin/capturistas";


const MUNICIPIOS_URL = "/api/municipios";
const COBERTURA_URL = "/api/analista/municipios/cobertura";
const MUNICIPIOS_JSON_URL = "/data/municipios.json";
const KPI_RESUMEN_EJECUTIVO_URL = "/api/personas/admin/kpis/resumen-ejecutivo";

  /* =========================
     STATE
     ========================= */

  let municipiosDb = [];
  let municipiosJson = [];
  let municipioIdByNorm = new Map();
  let jsonWktByNorm = new Map();
  let nombreById = new Map();

  let personasGrid = null;
  let selectedRowData = null;

  let chartVerificacion = null;
  let chartMunicipios = null;
  let chartOficinas = null;
  let gridLoading = false;
  let gridReloadPending = false;

const gridState = {
  pageSize: 25,
  q: "",
  oficinaId: "",
  capturistaId: "",
  municipio_trabajo: "",
  multiples_municipios: "",
  verificado: "", // "1" o "0"
  referente: "",
  referenteCargo: "",
  refNivel: "",
  refMode: "",
  sortField: "updated_at",
  sortDir: "desc"
};

  /* =========================
     HELPERS
     ========================= */

  function debounce(fn, wait = 250) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }
function collectGridFilters() {
  gridState.q = $("fltSearch")?.value?.trim() || "";
  gridState.oficinaId = $("filtroOficina")?.value || "";
  gridState.capturistaId = $("fltCapturista")?.value || "";
  gridState.municipio_trabajo = $("selMunicipio")?.value || "";

  // ✅ nuevo filtro por nivel de verificación
  gridState.verifLevel = $("fltVerificacion")?.value || "";

  // ✅ viejo filtro rápido: solo pendientes finales
  gridState.verificado = $("fltSoloPendientesFinal")?.checked ? "0" : "";

  gridState.pageSize = Number($("gridPageSize")?.value || 25);
}

function buildGridQuery(extra = {}) {
  const qs = new URLSearchParams();

  const merged = {
    q: gridState.q,
    oficinaId: gridState.oficinaId,
    capturistaId: gridState.capturistaId,
    municipio_trabajo: gridState.municipio_trabajo,
    multiples_municipios: gridState.multiples_municipios,

    // ✅ nuevo
    verifLevel: gridState.verifLevel,

    // ✅ viejo filtro binario, por compatibilidad
    verificado: gridState.verificado,

    referente: gridState.referente,
    referenteCargo: gridState.referenteCargo,
    refNivel: gridState.refNivel,
    refMode: gridState.refMode,
    sortField: gridState.sortField,
    sortDir: gridState.sortDir,
    ...extra
  };

  Object.entries(merged).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "") return;
    qs.set(k, String(v));
  });

  return qs;
}

  function $(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#039;"
    }[c]));
  }

  function normalizeName(s) {
    return (s || "")
      .toString()
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .replace(/[^\w\s.-]/g, "");
  }

  function norm(s) {
    return (s || "").toString().trim().toLowerCase();
  }

  function fmtNum(n) {
    const x = Number(n);
    return Number.isFinite(x) ? x.toLocaleString("es-MX") : "0";
  }

  function fmtPct(n) {
    const x = Number(n);
    return Number.isFinite(x) ? `${x.toFixed(1)}%` : "0%";
  }

  function fmtDate(d) {
    if (!d) return "—";
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return String(d);
    return dt.toLocaleDateString("es-MX");
  }

  function setText(id, value, fallback = "—") {
    const el = $(id);
    if (!el) return;
    el.textContent = (value === undefined || value === null || value === "") ? fallback : String(value);
  }

  function updateAlert(message, type = "info") {
    const box = $("alertBox");
    if (!box) return;
    box.className = `alert alert-${type}`;
    box.textContent = message;
    box.classList.remove("d-none");
  }

  function hideAlert() {
    const box = $("alertBox");
    if (!box) return;
    box.classList.add("d-none");
    box.textContent = "";
  }

  async function fetchJson(url, options = {}) {
    const token = localStorage.getItem("token");
    const headers = {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`
    };

    const res = await fetch(url, { ...options, headers });

    if (res.status === 401) {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      location.href = "/";
      throw new Error("Sesión expirada");
    }

    const ct = res.headers.get("content-type") || "";
    const isJson = ct.includes("application/json");
    const payload = isJson ? await res.json() : await res.text();

    if (!res.ok) {
      const msg = isJson ? (payload?.error || payload?.message || "Error de servidor") : String(payload);
      throw new Error(msg);
    }

    return payload;
  }


  function getCurrentUser() {
    try {
      return JSON.parse(localStorage.getItem("user") || "{}");
    } catch {
      return {};
    }
  }

  function fillSelect(selectEl, rows, { valueKey, labelKey, firstOption = "Todos", firstValue = "" } = {}) {
    if (!selectEl) return;
    const current = selectEl.value || "";
    selectEl.innerHTML = `<option value="${esc(firstValue)}">${esc(firstOption)}</option>`;

    (rows || []).forEach(r => {
      const opt = document.createElement("option");
      opt.value = String(r[valueKey] ?? "");
      opt.textContent = String(r[labelKey] ?? "");
      selectEl.appendChild(opt);
    });

    if (current) selectEl.value = current;
  }

  function fillMunicipiosSelect(selectEl, municipios, includeAll = true) {
    if (!selectEl) return;
    const current = selectEl.value || "";
    selectEl.innerHTML = includeAll
      ? `<option value="">Todos</option>`
      : `<option value="" selected disabled>Selecciona un municipio...</option>`;

    (municipios || []).forEach(m => {
      const opt = document.createElement("option");
      opt.value = String(m.id_municipio);
      opt.textContent = m.nombre;
      selectEl.appendChild(opt);
    });

    if (current) selectEl.value = current;
  }
//actualizacion UI DESPUES D EVERIFICAR Y DESVERIFICAR
  function afterVerificationSuccess(message) {
    updateAlert(message, "success");

    if ($("chkConfirmFinal")) {
      $("chkConfirmFinal").checked = false;
    }

    if ($("chkConfirmDesverificarFinal")) {
      $("chkConfirmDesverificarFinal").checked = false;
    }

    bootstrap.Modal.getOrCreateInstance($("modalVerificacionFinal"))?.hide();
    bootstrap.Modal.getOrCreateInstance($("modalDesverificarFinal"))?.hide();

    reloadGrid();
    loadSummaryKpis().catch(console.error);
    renderAlertSummary?.();
    updateGridInfoExtra?.();
  }

  /* =========================
     UI BOOT
     ========================= */

  function bootSessionUI() {
    const user = getCurrentUser();
    setText("lblUsuario", user.nombre || user.email || "Usuario");
    setText("lblRol", Array.isArray(user.roles) ? user.roles.join(", ") : (user.rol || "superadmin"));
    setText("txtUsuarioActivo", `Usuario: ${user.nombre || user.email || "—"}`);
    setText("txtFechaCorte", `Corte: ${new Date().toLocaleDateString("es-MX")}`);

    $("btnLogout")?.addEventListener("click", () => {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      location.href = "/";
    });

    $("btnToggleSidebar")?.addEventListener("click", () => {
      $("dashboardSidebar")?.classList.toggle("open");
    });

    $("btnRefreshDashboard")?.addEventListener("click", () => {
      loadAllDashboardData();
    });

    $("btnToggleAdvancedFilters")?.addEventListener("click", () => {
      $("advancedFilters")?.classList.toggle("d-none");
    });

    $("btnClearFilters")?.addEventListener("click", clearFilters);
    $("btnApplyFilters")?.addEventListener("click", applyFiltersAndReload);

    $("btnExportar")?.addEventListener("click", () => {
      const modal = bootstrap.Modal.getOrCreateInstance($("modalExportar"));
      modal.show();
    });

    $("btnReporteEjecutivo")?.addEventListener("click", () => {
      updateAlert("El reporte ejecutivo aún lo conectamos al endpoint final.", "secondary");
    });

    $("btnExportExcel")?.addEventListener("click", () => exportGrid("xlsx"));
    $("btnExportCsv")?.addEventListener("click", () => exportGrid("csv"));
    $("btnExportPdf")?.addEventListener("click", () => updateAlert("La exportación PDF ejecutiva la conectamos en el siguiente paso.", "secondary"));


    $("btnCloseDetailPanel")?.addEventListener("click", closeDetailPanel);
    $("detailPanelBackdrop")?.addEventListener("click", closeDetailPanel);

    $("btnAprobarFinal")?.addEventListener("click", () => {
      if (!selectedRowData) return;
      bootstrap.Modal.getOrCreateInstance($("modalVerificacionFinal")).show();
    });
//listener
    $("btnAbrirDesverificarFinal")?.addEventListener("click", () => {
      if (!selectedRowData?.id_persona) {
        updateAlert("Selecciona un registro antes de retirar la verificación.", "warning");
        return;
      }

      bootstrap.Modal.getOrCreateInstance($("modalDesverificarFinal")).show();
    });
    $("btnDevolverObservacion")?.addEventListener("click", () => {
      if (!selectedRowData) return;
      bootstrap.Modal.getOrCreateInstance($("modalObservacionFinal")).show();
    });
    //place holder

    $("btnConfirmarFinal")?.addEventListener("click", async () => {
      if (!selectedRowData?.id_persona) return;

      if (!$("chkConfirmFinal")?.checked) {
        updateAlert("Confirma la casilla antes de aprobar.", "warning");
        return;
      }

      try {
        await apiFetch(`/personas/analista/personas/${selectedRowData.id_persona}/verificar`, {
          method: "POST"
        });

        afterVerificationSuccess("Registro aprobado en verificación FINAL.");
      } catch (err) {
        updateAlert(err.message || "No se pudo aprobar la verificación final.", "danger");
      }
    });

    $("btnConfirmarDesverificarFinal")?.addEventListener("click", async () => {
      if (!selectedRowData?.id_persona) return;

      if (!$("chkConfirmDesverificarFinal")?.checked) {
        updateAlert("Confirma la casilla antes de retirar la verificación.", "warning");
        return;
      }

      try {
        await apiFetch(`/personas/analista/personas/${selectedRowData.id_persona}/desverificar`, {
          method: "POST"
        });

        afterVerificationSuccess("Se retiró la verificación FINAL del registro.");
      } catch (err) {
        updateAlert(err.message || "No se pudo retirar la verificación final.", "danger");
      }
    });

    $("btnConfirmarDevolucion")?.addEventListener("click", async () => {
      if (!selectedRowData) return;
      const obs = $("txtObservacionFinal")?.value?.trim();
      if (!obs) {
        updateAlert("Escribe una observación antes de devolver.", "warning");
        return;
      }
      updateAlert(`Pendiente conectar devolución FINAL para ID ${selectedRowData.id_persona}.`, "secondary");
      bootstrap.Modal.getOrCreateInstance($("modalObservacionFinal")).hide();
    });

    const debouncedApply = debounce(applyFiltersAndReload, 350);
    $("fltSearch")?.addEventListener("input", debouncedApply);

    [
      "fltRegion", "filtroOficina", "selMunicipio", "fltVerificacion",
      "fltPartido", "fltConfiabilidad", "fltLiderazgo", "fltControversias",
      "fltEmpresas", "fltElecciones", "fltCapturista", "fltAnalista",
      "fltVerificadorFinal", "fltFechaDesde", "fltFechaHasta", "fltSoloPendientesFinal"
    ].forEach(id => {
      const el = $(id);
      if (!el) return;
      const evt = el.type === "checkbox" ? "change" : "change";
      el.addEventListener(evt, () => {
        if (id === "filtroOficina") {
          loadCapturistasByOficinaFiltro(el.value).catch(console.error);
        }
        applyFiltersAndReload();
      });
    });

    $("btnVerPerfilCompleto")?.addEventListener("click", () => {
      if (!selectedRowData?.id_persona) return;
      if (typeof window.openPerfilModal === "function") {
        window.openPerfilModal(selectedRowData.id_persona);
      } else {
        updateAlert(`Aquí conectamos tu modal de perfil para ID ${selectedRowData.id_persona}.`, "secondary");
      }
    });

    $("btnVerTrazabilidad")?.addEventListener("click", () => {
      if (!selectedRowData?.id_persona) return;
      updateAlert(`Aquí conectamos la trazabilidad para ID ${selectedRowData.id_persona}.`, "secondary");
    });

    $("btnDescargarFichaPdf")?.addEventListener("click", () => {
      if (!selectedRowData?.id_persona) return;
      generarPDFPersona(selectedRowData.id_persona).catch(err => updateAlert(err.message, "danger"));
    });
  }

  function clearFilters() {
    [
      "fltSearch", "fltRegion", "filtroOficina", "selMunicipio", "fltVerificacion",
      "fltPartido", "fltConfiabilidad", "fltLiderazgo", "fltControversias", "fltEmpresas",
      "fltElecciones", "fltCapturista", "fltAnalista", "fltVerificadorFinal",
      "fltFechaDesde", "fltFechaHasta"
    ].forEach(id => {
      const el = $(id);
      if (el) el.value = "";
    });

    if ($("fltSoloPendientesFinal")) $("fltSoloPendientesFinal").checked = false;

    gridState.q = "";
    gridState.region = "";
    gridState.oficina = "";
    gridState.municipio = "";
    gridState.verifLevel = "";
    gridState.partido = "";
    gridState.confiabilidad = "";
    gridState.liderazgo = "";
    gridState.controversias = "";
    gridState.empresas = "";
    gridState.elecciones = "";
    gridState.capturista = "";
    gridState.analista = "";
    gridState.verificador_final = "";
    gridState.fecha_desde = "";
    gridState.fecha_hasta = "";
    gridState.solo_pendientes_final = false;

    $("advancedFilters")?.classList.add("d-none");
    resetMapUI();
    applyFiltersAndReload();
  }

  function applyFiltersAndReload() {
    collectGridFilters();
    reloadGrid();
    loadSummaryKpis().catch(console.error);
    renderAlertSummary();
    updateGridInfoExtra();
  }

  function quickView(type) {
    switch (type) {
      case "pendientes":
        $("fltSoloPendientesFinal").checked = true;
        break;
      case "finalizados":
        $("fltSoloPendientesFinal").checked = false;
        gridState.verificado = "1";
        break;
      case "alertas":
        updateAlert("La vista de alertas la conectamos con un filtro backend específico.", "secondary");
        return;
      default:
        clearFilters();
        return;
    }
    applyFiltersAndReload();
  }

  function updateGridInfoExtra() {
    const active = [];
    if (gridState.q) active.push(`búsqueda: "${gridState.q}"`);
    if (gridState.oficinaId) active.push("oficina");
    if (gridState.municipio_trabajo) active.push("municipio");
    if (gridState.verificado === "0") active.push("pendientes FINAL");
    setText("gridInfoExtra", active.length ? `Filtros activos: ${active.join(" · ")}` : "Sin filtros aplicados");
  }

  /* =========================
     MAPA
     ========================= */

  async function initMapModule() {
    municipiosDb = await fetchJson(MUNICIPIOS_URL);
    municipiosDb.sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" }));

    municipioIdByNorm = new Map();
    nombreById = new Map();
    municipiosDb.forEach(m => {
      const key = normalizeName(m.nombre);
      municipioIdByNorm.set(key, m.id_municipio);
      nombreById.set(m.id_municipio, m.nombre);
    });

    municipiosJson = await fetchJson(MUNICIPIOS_JSON_URL);

    jsonWktByNorm = new Map();
    municipiosJson.forEach(m => {
      const key = normalizeName(m.municipio);
      if (m.poligono) jsonWktByNorm.set(key, m.poligono);
    });

    const municipiosConPoligono = [];
    municipiosDb.forEach(m => {
      const key = normalizeName(m.nombre);
      const wkt = jsonWktByNorm.get(key);
      if (wkt) {
        municipiosConPoligono.push({
          id_municipio: m.id_municipio,
          nombre: m.nombre,
          wkt
        });
      }
    });

    fillMunicipiosSelect($("selMunicipio"), municipiosDb, true);

    if (typeof window.initMap === "function") {
      window.initMap();
    }
    if (typeof window.drawMunicipios === "function") {
      window.drawMunicipios(municipiosConPoligono);
    }

    await loadAndPaintMunicipioCoverage();

    if (typeof window.setOnMunicipioSelected === "function") {
      window.setOnMunicipioSelected((idMunicipio) => {
        const sel = $("selMunicipio");
        if (!sel) return;
        sel.value = String(idMunicipio);
        sel.dispatchEvent(new Event("change"));
      });
    }

    $("selMunicipio")?.addEventListener("change", async () => {
      const id = Number($("selMunicipio").value || 0);
      if (!id) {
        resetMapUI();
        applyFiltersAndReload();
        return;
      }

      setText("mapResumen", `Municipio seleccionado: ${nombreById.get(id) || "Municipio"}`);
      gridState.municipio_trabajo = String(id);

      if (typeof window.resaltarMunicipioById === "function") {
        window.resaltarMunicipioById(id);
      }

      applyFiltersAndReload();
    });

    $("btnResetMap")?.addEventListener("click", () => {
      resetMapUI();
      applyFiltersAndReload();
    });

    $("mapLayerSelect")?.addEventListener("change", () => {
      updateMapLayerText();
    });

    updateMapLayerText();
  }

  function resetMapUI() {
    if ($("selMunicipio")) $("selMunicipio").value = "";
    window.clearActorFocusOnMap?.({ restoreCoverage: true });
    setText("mapResumen", "Selecciona una capa para visualizar indicadores territoriales.", "");
    if (typeof window.resetMapCoverageView === "function") {
      window.resetMapCoverageView();
    }
  }

  function updateMapLayerText() {
    const layer = $("mapLayerSelect")?.value || "cobertura";
    const map = {
      cobertura: "Capa activa: cobertura de registros.",
      verificacion: "Capa activa: nivel de verificación por municipio.",
      confiabilidad: "Capa activa: confiabilidad por municipio.",
      controversias: "Capa activa: controversias por municipio.",
      influencia: "Capa activa: influencia territorial."
    };
    setText("mapResumen", map[layer], "");
  }

  async function loadAndPaintMunicipioCoverage() {
    try {
      const resp = await fetchJson(COBERTURA_URL);
      const conteo = resp?.data || resp || [];

      if (typeof window.setMunicipioCoverageCounts === "function") {
        const normalized = {};
        (conteo || []).forEach(row => {
          const id = Number(row.id_municipio);
          if (!id) return;
          normalized[id] = Number(row.total || row.count || 0);
        });
        window.setMunicipioCoverageCounts(normalized);
      }
    } catch (err) {
      console.warn("No se pudo pintar cobertura municipal:", err.message);
    }
  }

async function loadPersonaMunicipiosTrabajoDashboard(idPersona) {
  try {


    const resp = await apiGet(`/personas/${idPersona}/municipios-trabajo`);

    const rows = resp.data || [];


    if (rows.length) {
      if (window.mapReady && window.highlightPersonaMunicipiosDetalle) {
        window.highlightPersonaMunicipiosDetalle(rows);
      } else {
        window._pendingPersonaMunicipiosDetalle = rows;
      }
    } else {
      window.resetMunicipiosHighlight?.();
    }
  } catch (e) {
    window.resetMunicipiosHighlight?.();
  }
}

  /* =========================
     FILTROS CATÁLOGOS
     ========================= */

  async function loadOficinasFiltro() {
    const oficinas = await fetchJson(OFICINAS_URL);
    fillSelect($("filtroOficina"), oficinas || [], {
      valueKey: "id_oficina",
      labelKey: "nombre",
      firstOption: "Todas",
      firstValue: ""
    });
  }

async function loadCapturistasByOficinaFiltro(oficinaId) {
  const qs = new URLSearchParams();
  if (oficinaId) qs.set("oficinaId", String(oficinaId));

  const url = qs.toString()
    ? `${CAPTURISTAS_URL}?${qs.toString()}`
    : CAPTURISTAS_URL;

  const capturistas = await fetchJson(url);

  fillSelect($("fltCapturista"), capturistas || [], {
    valueKey: "id_usuario",
    labelKey: "nombre",
    firstOption: "Todos",
    firstValue: ""
  });
}

  /* =========================
     TABULATOR
     ========================= */

function initials(nombre = "") {
  return String(nombre)
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map(s => s[0]?.toUpperCase() || "")
    .join("");
}

function personaFormatter(cell) {
  const row = cell.getRow().getData();
  const nombre = row.nombre_completo || "Sin nombre";
  const sub = row.telefono_principal || row.referentes_nombres || "Sin detalle";

  return `
    <div class="persona-cell">
      <div class="persona-meta">
        <div class="persona-nombre">${esc(nombre)}</div>
        <div class="persona-sub">${esc(sub)}</div>
      </div>
    </div>
  `;
}

  function chipFormatter(value, type = "neutral", text = null) {
    return `<span class="grid-chip ${type}">${esc(text ?? value ?? "—")}</span>`;
  }

  function verificationChip(value) {
    const v = String(value || "").toUpperCase();
    if (v === "FINAL") return chipFormatter("FINAL", "success");
    if (v === "OFFICE") return chipFormatter("OFFICE", "warning");
    if (v === "AREA") return chipFormatter("AREA", "info");
    return chipFormatter("SIN VERIFICAR", "neutral");
  }

  function confiabilidadChip(value) {
    const v = String(value || "").toLowerCase();
    if (v.includes("alta") || v === "alto") return chipFormatter("Alta", "success");
    if (v.includes("media") || v.includes("medio")) return chipFormatter("Media", "warning");
    if (v.includes("baja") || v === "bajo") return chipFormatter("Baja", "danger");
    return chipFormatter("N/D", "neutral");
  }

  function boolChip(value, yesText = "Sí", noText = "No") {
    return value
      ? chipFormatter(yesText, "danger")
      : chipFormatter(noText, "neutral");
  }

function actionsFormatter(cell) {
  const row = cell.getRow().getData();
  return `
    <div class="grid-actions">
      <button class="grid-action-btn view" data-action="ver" data-id="${row.id_persona}" title="Ver perfil">
        <i class="bi bi-eye"></i>
      </button>
      <button class="grid-action-btn edit" data-action="edit" data-id="${row.id_persona}" title="Editar">
        <i class="bi bi-pencil"></i>
      </button>
      <button class="grid-action-btn delete" data-action="del" data-id="${row.id_persona}" title="Eliminar">
        <i class="bi bi-trash"></i>
      </button>
    </div>
  `;
}

function updateVerificationButtons(data) {
  const isFinal = !!data?.verificado_at;

  $("btnAprobarFinal")?.classList.toggle("d-none", isFinal);
  $("btnAbrirDesverificarFinal")?.classList.toggle("d-none", !isFinal);
}

function initPersonasGrid() {
  if (window.personasGrid) return window.personasGrid;

  window.personasGrid = new Tabulator("#gridPersonas", {
    layout: "fitColumns",
    height: "620px",
    placeholder: "Sin registros para mostrar",
    responsiveLayout: "collapse",
    pagination: true,
    paginationMode: "remote",
    paginationSize: gridState.pageSize,
    paginationSizeSelector: [10, 25, 50, 100],
    movableColumns: false,
    headerSortTristate: true,
    rowHeight: 80,
    ajaxFiltering: false,
    ajaxSorting: true,

    ajaxURL: GRID_DATA_URL,
    ajaxConfig: {
      method: "GET",
      headers: {
        Authorization: `Bearer ${localStorage.getItem("token") || ""}`
      }
    },

    ajaxURLGenerator: function (url, config, params) {
      const qs = buildGridQuery({
        page: params.page || 1,
        size: params.size || gridState.pageSize
      });
      return `${url}?${qs.toString()}`;
    },

    ajaxResponse: function (url, params, response) {
      const total = Number(response?.total || 0);
      const data = response?.data || [];
      const pageSize = Number(params.size || gridState.pageSize || 25);
      const lastPage = Number(response?.last_page || Math.max(1, Math.ceil(total / pageSize)));

      setText("gridInfo", `Mostrando ${fmtNum(data.length)} de ${fmtNum(total)} registros`, "");
      return {
        last_page: lastPage,
        data
      };
    },

    dataLoaded: function(data) {
      console.log("✅ Tabla lista con", data.length, "filas");
    },

    ajaxError: function (xhr) {
      if (xhr?.status === 401) {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        window.location.href = "/";
        return;
      }
      updateAlert("No se pudo cargar la bandeja de actores.", "danger");
    },

    columns: [
      {
        title: "Actor político",
        field: "nombre_completo",
        formatter: personaFormatter,
        minWidth: 240,
        responsive: 0
      },
      {
        title: "Municipio",
        field: "municipio_trabajo_nombre",
        formatter: cell => `<span class="grid-chip primary">${esc(cell.getValue() || "—")}</span>`,
        minWidth: 140,
        hozAlign: "center",
        responsive: 1
      },
      {
        title: "Oficina",
        field: "oficina_nombre",
        minWidth: 150,
        responsive: 2
      },
      {
        title: "Municipios",
        field: "total_municipios_trabajo",
        formatter: cell => {
          const n = Number(cell.getValue() || 0);
          return n > 1
            ? `<span class="grid-chip warning">${n} municipios</span>`
            : `<span class="grid-chip neutral">${n || 0}</span>`;
        },
        minWidth: 110,
        hozAlign: "center",
        responsive: 2
      },
      {
        title: "Dirección",
        field: "verif_area_at",
        formatter: cell => {
          const row = cell.getRow().getData();
          return verificationLevelCard(
            row.verif_area_at,
            row.verif_area_por_nombre,
            "Dirección"
          );
        },
        minWidth: 150,
        hozAlign: "center",
        responsive: 2
      },
      {
        title: "Coordinación",
        field: "verif_office_at",
        formatter: cell => {
          const row = cell.getRow().getData();
          return verificationLevelCard(
            row.verif_office_at,
            row.verif_office_por_nombre,
            "Coordinación"
          );
        },
        minWidth: 160,
        hozAlign: "center",
        responsive: 1
      },
      {
        title: "Ofi. Subsecretario",
        field: "verificado_at",
        formatter: cell => {
          const row = cell.getRow().getData();
          return verificationLevelCard(
            row.verificado_at,
            row.verificado_por_nombre,
            "Ofi. del Subsecretario"
          );
        },
        minWidth: 160,
        hozAlign: "center",
        responsive: 1
      },
      {
        title: "Capturista",
        field: "creado_por_nombre",
        minWidth: 140,
        responsive: 3
      },
      {
        title: "Fecha de captura:",
        field: "created_at",
        formatter: cell => esc(fmtDate(cell.getValue())),
        minWidth: 110,
        hozAlign: "center",
        responsive: 3
      },
      {
        title: "Acciones",
        field: "id_persona",
        formatter: actionsFormatter,
        headerSort: false,
        hozAlign: "center",
        width: 130,
        responsive: 0,
        cellClick: async function (e, cell) {
          const btn = e.target.closest("[data-action]");
          if (!btn) return;

          e.stopPropagation();

          const action = btn.dataset.action;
          const row = cell.getRow().getData();

          console.log("CLICK botón acción:", action, row);

          if (action === "ver") {
            selectedRowData = row;
            openDetailPanel(row);

            if (row?.id_persona) {
              await loadPersonaMunicipiosTrabajoDashboard(row.id_persona);
            }
            return;
          }

          if (action === "edit") {
            if (typeof window.openEditPersonaModal === "function") {
              window.openEditPersonaModal(row.id_persona);
            }
            return;
          }

          if (action === "del") {
            updateAlert(`Aquí conectamos eliminación para ID ${row.id_persona}.`, "secondary");
          }
        }
      }
    ]
  });

  // ✅ igual que analista.js
  window.personasGrid.on("rowClick", async function (_e, row) {
    const data = row.getData();
    selectedRowData = data;



    try {
      openDetailPanel(data);
    } catch (err) {
      console.error("Error en openDetailPanel:", err);
    }

    if (data?.id_persona) {
      await loadPersonaMunicipiosTrabajoDashboard(data.id_persona);
    }
  });

  return window.personasGrid;
}

function verificationLevelCard(dateValue, userName, label) {
  if (!dateValue) {
    return `
      <div class="verif-cell">
        <div class="verif-chip neutral">Pendiente</div>
        <div class="verif-user">—</div>
        <div class="verif-date">—</div>
      </div>
    `;
  }

  return `
    <div class="verif-cell" title="${esc(label)}: ${esc(userName || "Usuario")} · ${esc(fmtDate(dateValue))}">
      <div class="verif-chip success">${esc(label)}</div>
      <div class="verif-user">${esc(userName || "Usuario")}</div>
      <div class="verif-date">${esc(fmtDate(dateValue))}</div>
    </div>
  `;
}

async function loadKpisResumenEjecutivo() {
  try {
    const qs = buildGridQuery();
    const data = await fetchJson(`${KPI_RESUMEN_EJECUTIVO_URL}?${qs.toString()}`);

    setText("kpiTotalActores", fmtNum(data.total_actores || 0), "0");
    setText("kpiDireccion", fmtNum(data.verificados_direccion || 0), "0");
    setText("kpiCoordinacion", fmtNum(data.verificados_coordinacion || 0), "0");
    setText("kpiFinal", fmtNum(data.verificados_final || 0), "0");
    setText("kpiPendientesFinal", fmtNum(data.pendientes_final || 0), "0");
    setText("kpiControversias", fmtNum(data.con_controversias || 0), "0");
    setText("kpiConfiabilidadAlta", fmtNum(data.confiabilidad_alta || 0), "0");

    if ($("kpiTotalActoresMeta")) $("kpiTotalActoresMeta").textContent = "Registro general";
    if ($("kpiDireccionMeta")) $("kpiDireccionMeta").textContent = "Primer nivel";
    if ($("kpiCoordinacionMeta")) $("kpiCoordinacionMeta").textContent = "Segundo nivel";
    if ($("kpiFinalMeta")) $("kpiFinalMeta").textContent = "Cierre institucional";
    if ($("kpiPendientesFinalMeta")) $("kpiPendientesFinalMeta").textContent = "Requieren revisión";
    if ($("kpiControversiasMeta")) $("kpiControversiasMeta").textContent = "Seguimiento sensible";
    if ($("kpiConfiabilidadAltaMeta")) $("kpiConfiabilidadAltaMeta").textContent = "Base sólida";
  } catch (err) {
    console.warn("No se pudo cargar KPI resumen ejecutivo:", err.message);
  }
}

function reloadGrid() {
  collectGridFilters();

  if (!window.personasGrid) {
    initPersonasGrid();
    return;
  }

  if (gridLoading) {
    gridReloadPending = true;
    return;
  }

  const newSize = Number(gridState.pageSize || 25);
  if (window.personasGrid.getPageSize() !== newSize) {
    window.personasGrid.setPageSize(newSize);
    return;
  }

  window.personasGrid.setData();
}

  function exportGrid(type) {
    if (!personasGrid) return;
    if (type === "csv") personasGrid.download("csv", "actores_politicos.csv");
    if (type === "xlsx") {
      updateAlert("Para Excel con Tabulator necesitas incluir sheetjs/jszip si aún no lo tienes cargado.", "secondary");
    }
  }

  /* =========================
     DETAIL PANEL
     ========================= */

function openDetailPanel(row) {
  selectedRowData = row || null;

  const panel = $("detailPanel");
  const backdrop = $("detailPanelBackdrop");
  const body = $("detailPanelBody");

  if (!panel || !backdrop || !body || !row) return;

  body.innerHTML = `
    <div class="detail-hero-professional">
      ${
        row.foto_url
          ? `<div class="avatar-container">
              <img class="avatar-img" src="${esc(row.foto_url)}" alt="Foto de perfil">
            </div>`
          : `<div class="avatar-container no-photo">
              ${esc(initials(row.nombre_completo || row.nombre || ""))}
            </div>`
      }
      <div class="profile-info">
        <div class="detail-name">${esc(row.nombre_completo || row.nombre || "Sin nombre")}</div>
      </div>
    </div>

    <div class="detail-block">
      <div class="detail-block-title">Resumen</div>
      <div class="detail-kv">
        <div class="detail-kv-row">
          <span class="label">Municipio principal</span>
          <span class="value">${esc(row.municipio_trabajo_nombre || "—")}</span>
        </div>
        <div class="detail-kv-row">
          <span class="label">Cobertura territorial</span>
          <span class="value">
            ${Number(row.total_municipios_trabajo || 0)} municipio(s)
            ${
              Number(row.total_municipios_trabajo || 0) > 1
                ? `<button class="btn btn-sm btn-outline-primary ms-2" id="btnVerMunicipiosDetalle">Ver más</button>`
                : ""
            }
          </span>
        </div>
        <div id="detailMunicipiosExtra" class="d-none"></div>
        <div class="detail-kv-row">
          <span class="label">Oficina</span>
          <span class="value">${esc(row.oficina_nombre || "—")}</span>
        </div>
        <div class="detail-kv-row">
          <span class="label">Capturista</span>
          <span class="value">${esc(row.creado_por_nombre || "—")}</span>
        </div>
        <div class="detail-kv-row">
          <span class="label">Confiabilidad</span>
          <span class="value">${esc(row.nivel_confiabilidad || "—")}</span>
        </div>
        <div class="detail-kv-row">
          <span class="label">Verificación</span>
          <span class="value">${esc(row.estado_verificacion || "SIN VERIFICAR")}</span>
        </div>
      </div>
    </div>

    <div class="detail-block">
      <div class="detail-block-title">Señales</div>
      <div class="d-flex flex-wrap gap-2">
        ${verificationChip(row.estado_verificacion)}
        ${confiabilidadChip(row.nivel_confiabilidad)}
        ${boolChip(Boolean(row.tiene_controversias), "Con controversias", "Sin controversias")}
      </div>
    </div>

    <div class="detail-block">
      <div class="detail-block-title">Trazabilidad</div>
      <div class="detail-kv">
        <div class="detail-kv-row">
          <span class="label">Creado</span>
          <span class="value">${esc(fmtDate(row.created_at))}</span>
        </div>
        <div class="detail-kv-row">
          <span class="label">Actualizado</span>
          <span class="value">${esc(fmtDate(row.updated_at))}</span>
        </div>
        <div class="detail-kv-row">
          <span class="label">Verif. Dirección</span>
          <span class="value">${esc(row.verif_area_por_nombre || "—")}</span>
        </div>
        <div class="detail-kv-row">
          <span class="label">Verif. Coordinación</span>
          <span class="value">${esc(row.verif_office_por_nombre || "—")}</span>
        </div>
        <div class="detail-kv-row">
          <span class="label">Verificador final</span>
          <span class="value">${esc(row.verificado_por_nombre || "—")}</span>
        </div>
      </div>
    </div>
  `;

  //abrir ver mas municipios
  $("btnVerMunicipiosDetalle")?.addEventListener("click", async () => {
    if (!row?.id_persona) return;

    const box = document.getElementById("detailMunicipiosExtra");
    if (!box) return;

    if (box.dataset.loaded === "1") {
      box.classList.toggle("d-none");
      return;
    }

    try {
      const resp = await apiGet(`/personas/${row.id_persona}/municipios-trabajo`);
      const rows = resp?.data || [];

      box.innerHTML = `
        <div class="mt-2">
          ${rows.map(r => `
            <div class="d-flex justify-content-between align-items-center border rounded px-2 py-1 mb-1">
              <span>${esc(r.municipio || "—")}</span>
              <span class="badge ${r.es_principal ? "bg-primary" : "bg-secondary"}">
                ${r.es_principal ? "Principal" : "Secundario"}
              </span>
            </div>
          `).join("")}
        </div>
      `;
      box.dataset.loaded = "1";
      box.classList.remove("d-none");
    } catch (e) {
      console.error("Error cargando municipios detalle:", e);
      updateAlert("No se pudieron cargar los municipios del registro.", "danger");
    }
  });

  updateVerificationButtons(row);
  panel.classList.add("open");
  backdrop.classList.remove("d-none");
}

  function closeDetailPanel() {
    $("detailPanel")?.classList.remove("open");
    $("detailPanelBackdrop")?.classList.add("d-none");
  }

  /* =========================
     KPIS Y CHARTS
     ========================= */

async function loadSummaryKpis() {
  await loadKpisResumenEjecutivo();

  try {
    const qs = buildGridQuery();
    const data = await fetchJson(`${KPI_MUNICIPIOS_URL}?${qs.toString()}`);

    const resumen = data?.resumen || {};
    const top10 = data?.top10 || [];

    const pct = Number(resumen.total_municipios)
      ? (Number(resumen.municipios_con_registros || 0) / Number(resumen.total_municipios)) * 100
      : 0;

    setText("kpiCobertura", fmtPct(pct), "0%");
    if ($("kpiCoberturaMeta")) $("kpiCoberturaMeta").textContent = "Presencia territorial";

    renderChartMunicipios(top10);
  } catch (err) {
    console.warn("No se pudo cargar KPI municipios:", err.message);
  }
}

  function renderChartVerificacion(rows) {
    const canvas = $("chartVerificacion");
    if (!canvas) return;

    const labels = rows.length
      ? rows.map(r => r.label)
      : ["Sin verificar", "AREA", "OFFICE", "FINAL"];

    const values = rows.length
      ? rows.map(r => Number(r.total || 0))
      : [0, 0, 0, 0];

    if (chartVerificacion) chartVerificacion.destroy();
    chartVerificacion = new Chart(canvas, {
      type: "doughnut",
      data: {
        labels,
        datasets: [{ data: values }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } }
      }
    });
  }

  function renderChartMunicipios(rows) {
    const canvas = $("chartMunicipios");
    if (!canvas) return;

    const labels = (rows || []).slice(0, 10).map(r => r.municipio);
    const values = (rows || []).slice(0, 10).map(r => Number(r.total || 0));

    if (chartMunicipios) chartMunicipios.destroy();
    chartMunicipios = new Chart(canvas, {
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

  function renderChartOficinas(rows) {
    const canvas = $("chartOficinas");
    if (!canvas) return;

    const labels = (rows || []).map(r => r.oficina || r.label || "—");
    const values = (rows || []).map(r => Number(r.total || 0));

    if (chartOficinas) chartOficinas.destroy();
    chartOficinas = new Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [{ label: "Registros", data: values }]
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { beginAtZero: true } }
      }
    });
  }

  function renderAlertSummary() {
    const c = $("alertsContainer");
    if (!c) return;

    const alertas = [];

    if (gridState.solo_pendientes_final) {
      alertas.push({
        cls: "is-warning",
        title: "Vista enfocada en pendientes FINAL",
        text: "La bandeja muestra registros que requieren cierre institucional."
      });
    }

    if (gridState.controversias === "1") {
      alertas.push({
        cls: "is-danger",
        title: "Filtro de controversias activo",
        text: "Se priorizan perfiles con seguimiento sensible."
      });
    }

    if (gridState.oficina) {
      alertas.push({
        cls: "is-info",
        title: "Segmentación por oficina",
        text: "El tablero está acotado a una oficina específica."
      });
    }

    if (!alertas.length) {
      c.innerHTML = `
        <div class="alert-item">
          <div class="alert-item-title">Sin alertas cargadas</div>
          <div class="alert-item-text text-muted">Aquí aparecerán incidencias, focos de atención y prioridades.</div>
        </div>
      `;
      return;
    }

    c.innerHTML = alertas.map(a => `
      <div class="alert-item ${a.cls}">
        <div class="alert-item-title">${esc(a.title)}</div>
        <div class="alert-item-text">${esc(a.text)}</div>
      </div>
    `).join("");
  }

  /* =========================
     PDF PERSONA
     ========================= */

  async function generarPDFPersona(idPersona) {
    const token = localStorage.getItem("token");
    const res = await fetch(`/api/personas/${idPersona}/pdf`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (res.status === 401) {
      localStorage.clear();
      location.href = "/";
      return;
    }

    if (res.status === 403) {
      updateAlert("No tienes permisos para generar el PDF.", "warning");
      return;
    }

    if (!res.ok) {
      updateAlert("No se pudo generar el PDF.", "danger");
      return;
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /* =========================
     CARGA GENERAL
     ========================= */

  async function loadAllDashboardData() {
    hideAlert();
    try {
      collectGridFilters();
      await Promise.all([
        loadSummaryKpis(),
        renderAlertSummary()
      ]);
      reloadGrid();
      setText("txtFechaCorte", `Corte: ${new Date().toLocaleDateString("es-MX")}`);
    } catch (err) {
      updateAlert(err.message || "No se pudo cargar el dashboard.", "danger");
    }
  }

  async function initDashboard() {
    bootSessionUI();
    initPersonasGrid();

    await Promise.all([
      initMapModule(),
      loadOficinasFiltro()
    ]);

    await loadCapturistasByOficinaFiltro("");
    await loadAllDashboardData();
  }

  document.addEventListener("DOMContentLoaded", () => {
    initDashboard().catch(err => {
      console.error(err);
      updateAlert(err.message || "Error al iniciar el dashboard.", "danger");
    });
  });

  // expón algunas referencias por si quieres usarlas desde otros scripts
  window.dashboardSuperadmin = {
    reloadGrid,
    loadAllDashboardData,
    openDetailPanel
  };
})();
