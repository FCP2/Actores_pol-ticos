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

const KPI_VERIFICACION_URL = "/api/personas/dashboard/kpi/verificacion";
const KPI_OFICINAS_URL = "/api/personas/dashboard/kpi/oficinas";

const OFICINAS_URL = "/api/personas/admin/oficinas";
const CAPTURISTAS_URL = "/api/personas/admin/capturistas";


const MUNICIPIOS_URL = "/api/municipios";
const COBERTURA_URL = "/api/analista/municipios/cobertura";
const CAPAS_URL     = "/api/analista/municipios/capas";
const MUNICIPIOS_JSON_URL = "/data/municipios.json";
const KPI_RESUMEN_EJECUTIVO_URL = "/api/personas/admin/kpis/resumen-ejecutivo";

const KPI_ALERTAS_URL = "/api/personas/dashboard/kpi/alertas";

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
  let _modoOcultar = false; // true = modal usado para ocultar, false = devolver

  let chartVerificacion = null;
  let chartMunicipios = null;
  let chartOficinas = null;
  let gridLoading = false;
  let gridReloadPending = false;

const gridState = {
  q: "",
  oficinaId: "",
  capturistaId: "",
  municipio_trabajo: "",
  multiples_municipios: "",
  verifLevel: "",
  verificado: "",
  partidoId: "",
  confiabilidad: "",
  liderazgo: "",
  controversias: "",
  referente: "",
  refNivel: "",
  refMode: "exact",
  sinMunicipioPrincipal: false,
  sortField: "id_persona",
  sortDir: "desc",
  pageSize: 25
};

  /* =========================
     HELPERS
     ========================= */
  async function fetchBlob(url, options = {}) {
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

    if (!res.ok) {
      let msg = "Error de servidor";
      try {
        const err = await res.json();
        msg = err?.error || err?.detail || msg;
      } catch {
        // ignore
      }
      throw new Error(msg);
    }

    return res.blob();
  }

  function canVerifyFinal() {
    const user = getCurrentUser();
    return user?.puede_verificar_final === true;
  }

  function irAEdicionCaptura(idPersona) {
    const id = Number(idPersona);
    if (!Number.isFinite(id) || id <= 0) {
      updateAlert("No se pudo abrir el registro para editar.", "warning");
      return;
    }
    location.href = `/captura?edit=${encodeURIComponent(String(id))}`;
  }

  function debounce(fn, wait = 250) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }
  function fmtDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";

  return d.toLocaleString("es-MX", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
  }

function fmtDT(v) {
  if (!v) return "—";
  try {
    return new Date(v).toLocaleString("es-MX", {
      timeZone: "America/Mexico_City",
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return v;
  }
}

function getChartBaseOptions(extra = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: "index",
      intersect: false
    },
    plugins: {
      legend: {
        position: "bottom",
        labels: {
          boxWidth: 12,
          boxHeight: 12,
          padding: 16,
          color: "#374151",
          font: {
            size: 12,
            weight: "600"
          }
        }
      },
      tooltip: {
        backgroundColor: "rgba(17, 24, 39, 0.96)",
        titleColor: "#fff",
        bodyColor: "#e5e7eb",
        padding: 12,
        cornerRadius: 10,
        displayColors: true
      }
    },
    ...extra
  };
}
function collectGridFilters() {
  gridState.q = $("fltSearch")?.value?.trim() || "";
  gridState.oficinaId = $("filtroOficina")?.value || "";
  gridState.capturistaId = $("fltCapturista")?.value || "";
  gridState.municipio_trabajo = $("selMunicipio")?.value || "";
  gridState.partidoId = $("fltPartido")?.value || "";
  gridState.confiabilidad = $("fltConfiabilidad")?.value || "";
  gridState.liderazgo = $("fltLiderazgo")?.value || "";
  gridState.controversias = $("fltControversias")?.value || "";
  gridState.referente = $("fltReferente")?.value?.trim() || "";
  gridState.refMode = "exact";
  gridState.fechaDesde = $("fltFechaDesde")?.value || "";
  gridState.fechaHasta = $("fltFechaHasta")?.value || ""; 
  // ✅ nuevo filtro por nivel de verificación
  gridState.verifLevel = $("fltVerificacion")?.value || "";

  gridState.verificado = "";

  gridState.sinMunicipioPrincipal = $("fltSinMunicipioPrincipal")?.checked || false;

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
    confiabilidad: gridState.confiabilidad,
    liderazgo: gridState.liderazgo,
    controversias: gridState.controversias,
    referente: gridState.referente,
    refMode: gridState.refMode,
    
    fechaDesde: gridState.fechaDesde,
    fechaHasta: gridState.fechaHasta,

    // ✅ nuevo
    verifLevel: gridState.verifLevel,

    // ✅ viejo filtro binario, por compatibilidad
    verificado: gridState.verificado,
    sin_municipio_principal: gridState.sinMunicipioPrincipal ? "1" : "",
    partidoId: gridState.partidoId,

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

    _keepSelection = true;
    reloadGrid(true);
    loadSummaryKpis().catch(console.error);
    renderAlertSummary?.();
    updateGridInfoExtra?.();
  }

  /* =========================
     UI BOOT
     ========================= */

  function bootSessionUI() {
    const user = getCurrentUser();
    const debouncedReferentes = debounce(() => {
      loadReferentesDashboard().catch(console.error);
    }, 250);
    

    $("fltReferente")?.addEventListener("focus", () => {
      loadReferentesDashboard().catch(console.error);
    });

    $("fltReferente")?.addEventListener("input", debouncedReferentes);

    $("fltReferente")?.addEventListener("change", () => {
      applyFiltersAndReload();
    });
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

    if (!canVerifyFinal()) {
      $("btnIrCaptura")?.classList.add("d-none");
    }
    $("btnIrCaptura")?.addEventListener("click", () => {
      location.href = "/captura";
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

    $("btnReporteEjecutivo")?.addEventListener("click", async () => {
      try {
        const qs = buildGridQuery();
        const blob = await fetchBlob(`/api/personas/reportes/ejecutivo?${qs.toString()}`);
        const blobUrl = URL.createObjectURL(blob);
        window.open(blobUrl, "_blank");
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      } catch (err) {
        updateAlert(err.message || "No se pudo generar el reporte ejecutivo.", "danger");
      }
    });
    
    $("btnReporteMunicipios")?.addEventListener("click", () => {
      poblarSelectMunicipiosReporte();
      bootstrap.Modal.getOrCreateInstance($("modalReporteMunicipios")).show();
    });

    $("chkTodosMunicipios")?.addEventListener("change", () => {
      const sel = $("selMunicipiosReporte");
      const checked = $("chkTodosMunicipios").checked;
      if (sel) {
        Array.from(sel.options).forEach(o => { o.selected = checked; });
        actualizarLblMunicipios();
        sel.disabled = checked;
      }
    });

    $("selMunicipiosReporte")?.addEventListener("change", actualizarLblMunicipios);

    $("btnGenerarReporteMunicipios")?.addEventListener("click", async () => {
      const todosCheck = $("chkTodosMunicipios")?.checked;
      const sel = $("selMunicipiosReporte");
      const seleccionados = todosCheck
        ? []
        : Array.from(sel?.selectedOptions || []).map(o => o.value);

      if (!todosCheck && !seleccionados.length) {
        updateAlert("Selecciona al menos un municipio o marca 'Todos'.", "warning");
        return;
      }

      const qs = todosCheck ? "municipios=all" : `municipios=${seleccionados.join(",")}`;

      try {
        const blob = await fetchBlob(`/api/personas/reportes/municipios?${qs}`);
        const url = URL.createObjectURL(blob);
        window.open(url, "_blank");
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        bootstrap.Modal.getOrCreateInstance($("modalReporteMunicipios")).hide();
      } catch (err) {
        updateAlert(err.message || "No se pudo generar el reporte.", "danger");
      }
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

    $("modalObservacionFinal")?.addEventListener("hidden.bs.modal", () => {
      _resetModalObservacion();
    });

    $("modalObservacionFinal")?.addEventListener("show.bs.modal", () => {
      if ($("txtObservacionFinal")) $("txtObservacionFinal").value = "";
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

    $("btnConfirmarDevolucion")?.addEventListener("click", async (e) => {
      e.preventDefault();

      if (!selectedRowData?.id_persona) return;

      const obs = $("txtObservacionFinal")?.value?.trim();
      const dirigidoA = String($("selObservacionDirigidoA")?.value || "SELF").toUpperCase();
      if (!obs) {
        updateAlert("Escribe el motivo antes de continuar.", "warning");
        return;
      }

      // ── MODO OCULTAR ──────────────────────────────────────────
      if (_modoOcultar) {
        bootstrap.Modal.getOrCreateInstance($("modalObservacionFinal")).hide();
        await _ejecutarToggleOculto(selectedRowData, null, obs, dirigidoA);
        _resetModalObservacion();
        return;
      }

      // ── MODO DEVOLVER FINAL (comportamiento original) ─────────
      try {
        await fetchJson(`/api/personas/analista/personas/${selectedRowData.id_persona}/devolver-final`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ observacion: obs, dirigido_a: dirigidoA })
        });

        updateAlert("Observación enviada correctamente. El registro regresó de FINAL.", "success");
        _resetModalObservacion();
        bootstrap.Modal.getOrCreateInstance($("modalObservacionFinal")).hide();

        _keepSelection = true;
        reloadGrid(true);
        loadSummaryKpis().catch(console.error);
        renderAlertSummary().catch(console.error);
        updateGridInfoExtra?.();

      } catch (err) {
        console.error("Error devolución final:", err);
        updateAlert(err.message || "No se pudo enviar la observación.", "danger");
      }
    });

    const debouncedApply = debounce(applyFiltersAndReload, 350);
    $("fltSearch")?.addEventListener("input", debouncedApply);

    [
      "fltRegion", "filtroOficina", "selMunicipio", "fltVerificacion",
      "fltPartido", "fltConfiabilidad", "fltLiderazgo", "fltControversias",
      "fltEmpresas", "fltElecciones", "fltCapturista", "fltAnalista",
      "fltVerificadorFinal", "fltFechaDesde", "fltFechaHasta",
      "fltSinMunicipioPrincipal"
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
    $("btnVerTrazabilidad")?.addEventListener("click", () => {
      if (!selectedRowData?.id_persona) return;

      renderTrazabilidadModal(selectedRowData);
      bootstrap.Modal.getOrCreateInstance($("modalTrazabilidad")).show();
    });

    $("btnDescargarFichaPdf")?.addEventListener("click", () => {
      if (!selectedRowData?.id_persona) return;
      generarPDFPersona(selectedRowData.id_persona).catch(err => updateAlert(err.message, "danger"));
    });

    $("btnInboxNotificaciones")?.addEventListener("click", async () => {
      const rows = await loadNotificaciones();

      renderNotificaciones(rows);
      updateBadgeNotificaciones(rows);

      bootstrap.Modal.getOrCreateInstance($("modalNotificaciones")).show();
    });
    
  }

  function clearFilters() {
    [
      "fltSearch", "fltRegion", "filtroOficina", "selMunicipio", "fltVerificacion",
      "fltPartido", "fltConfiabilidad", "fltLiderazgo", "fltControversias", "fltEmpresas",
      "fltElecciones", "fltCapturista", "fltAnalista", "fltVerificadorFinal",
      "fltFechaDesde", "fltFechaHasta","fltReferente"
    ].forEach(id => {
      const el = $(id);
      if (el) el.value = "";
    });

    if ($("fltSinMunicipioPrincipal")) $("fltSinMunicipioPrincipal").checked = false;
    gridState.sinMunicipioPrincipal = false;

    gridState.q = "";
    gridState.region = "";
    gridState.oficinaId = "";
    gridState.municipio_trabajo = "";
    gridState.verifLevel = "";
    gridState.partidoId = "";
    gridState.confiabilidad = "";
    gridState.liderazgo = "";
    gridState.controversias = "";
    gridState.empresas = "";
    gridState.elecciones = "";
    gridState.capturistaId = "";
    gridState.analista = "";
    gridState.verificador_final = "";
    gridState.fecha_desde = "";
    gridState.fecha_hasta = "";
    gridState.referente = "";
    gridState.refMode = "exact";
    gridState.solo_pendientes_final = false;

    $("advancedFilters")?.classList.add("d-none");
    resetMapUI();
    applyFiltersAndReload();
  }

  function applyFiltersAndReload() {
    collectGridFilters();
    reloadGrid();
    loadSummaryKpis().catch(console.error);
    loadAndPaintFilteredMunicipiosDashboard().catch(console.error);
    renderAlertSummary().catch(console.error);
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
    if (gridState.sinMunicipioPrincipal) active.push("sin municipio principal");
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

    await loadCapasMapa();

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
    });

    document.querySelectorAll(".map-layer-btn[data-layer]").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".map-layer-btn[data-layer]").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        window.switchMapLayer?.(btn.dataset.layer);
      });
    });
  }

  function resetMapUI() {
    if ($("selMunicipio")) $("selMunicipio").value = "";
    window.clearActorFocusOnMap?.({ restoreCoverage: true });
    setText("mapResumen", "Selecciona una capa para visualizar indicadores territoriales.", "");
    if (typeof window.resetMapCoverageView === "function") {
      window.resetMapCoverageView();
    }
  }

  async function loadCapasMapa() {
    try {
      const resp = await fetchJson(CAPAS_URL);
      const data = resp?.data || [];
      window.setCapasMapa?.(data);
    } catch (err) {
      console.warn("No se pudo cargar capas del mapa:", err.message);
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

/*refrentes, seleccion actores pintar el mapa*/
async function loadAndPaintFilteredMunicipiosDashboard() {
  try {
    // Si hay municipio seleccionado en el mapa, resaltarMunicipioById ya lo marcó — no pisar
    if (gridState.municipio_trabajo) return;

    const hasRelevantFilter =
      !!gridState.referente ||
      !!gridState.oficinaId ||
      !!gridState.capturistaId ||
      !!gridState.partidoId ||
      !!gridState.confiabilidad ||
      !!gridState.liderazgo ||
      !!gridState.controversias ||
      !!gridState.verifLevel ||
      !!gridState.q;

    if (!hasRelevantFilter) {
      window.resetMunicipiosHighlight?.();
      window.resetMapCoverageView?.();
      return;
    }

    const qs = buildGridQuery();
    const resp = await apiGet(`/personas/admin/grid/mapa-municipios?${qs.toString()}`);
    const rows = resp?.data || [];

    const ids = [...new Set(
      rows.map(r => Number(r.id_municipio)).filter(Boolean)
    )];

    if (!ids.length) {
      window.resetMunicipiosHighlight?.();
      window.resetMapCoverageView?.();
      return;
    }

    if (window.mapReady && window.highlightMunicipiosByIdList) {
      window.highlightMunicipiosByIdList(ids, { dimOthers: true });
    } else {
      window._pendingHighlightMunicipiosById = ids;
    }

  } catch (e) {
    console.error("Error cargando municipios filtrados del dashboard:", e);
    window.resetMunicipiosHighlight?.();
    window.resetMapCoverageView?.();
  }
}

  /* =========================
     FILTROS CATÁLOGOS
     ========================= */
function updateBadgeNotificaciones(rows = []) {
  const badge = $("badgeNotificaciones");
  if (!badge) return;

  const pendientes = rows.filter(r => !r.leida);

  if (pendientes.length > 0) {
    badge.textContent = pendientes.length;
    badge.classList.remove("d-none");
  } else {
    badge.classList.add("d-none");
  }
}

async function loadNotificaciones() {
  try {
    const resp = await fetchJson("/api/personas/dashboard/notificaciones");
    return resp?.data || [];
  } catch (e) {
    console.error("Error notificaciones:", e);
    return [];
  }
}

async function loadAlertSummaryData() {
  try {
    const qs = buildGridQuery();
    const resp = await fetchJson(`${KPI_ALERTAS_URL}?${qs.toString()}`);
    return resp?.data || {};
  } catch (e) {
    console.error("Error cargando alertas dashboard:", e);
    return {};
  }
}

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

async function loadPartidosFiltro() {
  try {
    const resp = await apiGet("/catalogos/partidos");

    const data = resp?.data || resp || [];
    const sel = $("fltPartido");
    if (!sel) return;

    sel.innerHTML =
      `<option value="">Todos</option>` +
      data.map(p => `<option value="${p.id_partido}">${esc(p.nombre)}</option>`).join("");

  } catch (e) {
    console.error("Error cargando partidos:", e);
  }
}

function loadConfiabilidadFiltro() {
  const sel = $("fltConfiabilidad");
  if (!sel) return;

  sel.innerHTML = `
    <option value="">Todas</option>
    <option value="alto">Alto</option>
    <option value="medio">Medio</option>
    <option value="bajo">Bajo</option>
  `;
}

function loadInfluenciaFiltro() {
  const sel = $("fltLiderazgo");
  if (!sel) return;

  sel.innerHTML = `
    <option value="">Todos</option>
    <option value="municipal">Municipal</option>
    <option value="regional">Regional</option>
    <option value="distrital">Distrital</option>
    <option value="estatal">Estatal</option>
    <option value="nacional">Nacional</option>
  `;
}

async function loadReferentesDashboard() {
  try {
    const qs = new URLSearchParams();

    if ($("filtroOficina")?.value) qs.set("oficinaId", $("filtroOficina").value);
    if ($("fltCapturista")?.value) qs.set("capturistaId", $("fltCapturista").value);
    if ($("selMunicipio")?.value) qs.set("municipio_trabajo", $("selMunicipio").value);
    if ($("fltSearch")?.value?.trim()) qs.set("q", $("fltSearch").value.trim());

    const typed = $("fltReferente")?.value?.trim();
    if (typed) qs.set("referente", typed);

    qs.set("mode", "ref_list_dashboard");
    qs.set("refMode", "exact");

    const resp = await fetchJson(`${GRID_DATA_URL}?${qs.toString()}`);
    const rows = resp?.data || [];

    const dl = $("lstReferentesDashboard");
    if (!dl) return;

    dl.innerHTML = rows.map(r => {
      const nombre = String(r.label || r.nombre || "").trim();
      return `<option value="${esc(nombre)}"></option>`;
    }).join("");
  } catch (e) {
    console.error("Error cargando referentes dashboard:", e);
  }
}

function poblarSelectMunicipiosReporte() {
  const sel = $("selMunicipiosReporte");
  if (!sel || sel.options.length > 1) return; // ya poblado

  (municipiosDb || []).forEach(m => {
    const opt = document.createElement("option");
    opt.value = String(m.id_municipio);
    opt.textContent = m.nombre;
    sel.appendChild(opt);
  });

  actualizarLblMunicipios();
}

function actualizarLblMunicipios() {
  const sel = $("selMunicipiosReporte");
  const lbl = $("lblMunicipiosSeleccionados");
  if (!sel || !lbl) return;
  const n = $("chkTodosMunicipios")?.checked
    ? sel.options.length
    : sel.selectedOptions.length;
  lbl.textContent = `${n} seleccionado(s)`;
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

function legacyPersonaFormatter(cell) {
  const row    = cell.getRow().getData();
  const nombre = row.nombre_completo || "Sin nombre";
  const sub    = row.telefono_principal || row.referentes_nombres || "Sin detalle";

  const ocultoBadge = row.oculto
    ? `<span class="grid-chip danger ms-1" title="Registro oculto para la oficina">OCULTO</span>`
    : "";

  const n = Number(row.obs_pendientes || 0);
  const obsBadge = n > 0
    ? `<span class="grid-chip warn ms-1"
           title="${n} observación${n > 1 ? "es" : ""} sin atender"
           style="background:#fef3c7;color:#92400e;border:1px solid #fde68a;">
         <i class="bi bi-envelope-exclamation-fill me-1"></i>Obs${n > 1 ? ` (${n})` : "."}
       </span>`
    : "";

  return `
    <div class="persona-cell">
      <div class="persona-meta">
        <div class="persona-nombre">${esc(nombre)}${ocultoBadge}${obsBadge}</div>
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
    if (v === "OFFICE") return chipFormatter("Coordinación", "warning");
    if (v === "AREA") return chipFormatter("Dirección", "info");
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
  const user = getCurrentUser();
  const isSuperadmin = Array.isArray(user.roles) && user.roles.includes("superadmin");
  const ocultarBtn = isSuperadmin && canVerifyFinal()
    ? `<button class="grid-action-btn ${row.oculto ? "danger" : "secondary"}"
         data-action="ocultar" data-id="${row.id_persona}"
         title="${row.oculto ? "Mostrar registro" : "Ocultar registro"}">
         <i class="bi bi-eye${row.oculto ? "" : "-slash"}"></i>
       </button>`
    : "";

  return `
    <div class="grid-actions">
      <button class="grid-action-btn view" data-action="ver" data-id="${row.id_persona}" title="Ver perfil">
        <i class="bi bi-eye"></i>
      </button>
      ${ocultarBtn}
    </div>
  `;
}

function personaFormatter(cell) {
  const row = cell.getRow().getData();
  const nombre = row.nombre_completo || row.nombre || "Sin nombre";
  const municipio = row.municipio_trabajo_nombre || "Sin municipio";
  const obsPendientes = Number(row.obs_pendientes || 0);

  const ocultoBadge = row.oculto
    ? `<span class="badge text-bg-danger">OCULTO</span>`
    : "";

  const obsBadge = obsPendientes > 0
    ? `<span class="badge text-bg-warning" title="${obsPendientes} observacion${obsPendientes > 1 ? "es" : ""} sin atender">
         <i class="bi bi-envelope-exclamation-fill me-1"></i>${obsPendientes}
       </span>`
    : "";

  return `
    <div class="persona-list-card">
      <div class="persona-list-photo">
        ${
          row.foto_url
            ? `<img src="${esc(row.foto_url)}" alt="Foto de ${esc(nombre)}" loading="lazy">`
            : `<span>${esc(initials(nombre))}</span>`
        }
      </div>
      <div class="d-flex justify-content-between align-items-start gap-3">
        <div class="min-w-0">
          <div class="persona-list-name text-uppercase">${esc(nombre)}</div>
          <div class="d-flex align-items-center flex-wrap gap-2 mt-2">
            <span class="badge rounded-pill text-bg-light border text-dark">ID ${esc(row.id_persona || "N/D")}</span>
            <span class="badge rounded-pill persona-municipio-badge">
              <i class="bi bi-geo-alt-fill me-1"></i>${esc(municipio)}
            </span>
            ${ocultoBadge}
            ${obsBadge}
          </div>
        </div>
        <i class="bi bi-chevron-right text-muted mt-1"></i>
      </div>
    </div>
  `;
}

function toggleOcultoPersona(row, tabulatorRow) {
  if (!row?.id_persona) return;

  // Si está oculto → mostrar directo (sin modal, sin motivo)
  if (row.oculto) {
    _ejecutarToggleOculto(row, tabulatorRow, null, null);
    return;
  }

  // Si está visible → pedir motivo con el modal existente en modo ocultar
  _modoOcultar = true;
  const modal = $("modalObservacionFinal");
  if (!modal) return;

  const label = modal.querySelector("#modalObservacionLabel");
  const btn   = $("btnConfirmarDevolucion");
  if (label) label.innerHTML = `<i class="bi bi-eye-slash me-2"></i>Ocultar registro — escribe el motivo`;
  if (btn)   { btn.textContent = "Ocultar registro"; btn.className = "btn btn-danger"; }

  bootstrap.Modal.getOrCreateInstance(modal).show();
}

async function _ejecutarToggleOculto(row, tabulatorRow, observacion, dirigidoA) {
  try {
    const body = observacion ? { observacion, dirigido_a: dirigidoA || "SELF" } : {};
    const resp = await apiPatch(`/personas/${row.id_persona}/oculto`, body);
    if (!resp?.ok) throw new Error("No se pudo cambiar la visibilidad");

    const nuevoEstado = resp.oculto;
    row.oculto = nuevoEstado;
    if (selectedRowData?.id_persona === row.id_persona) selectedRowData.oculto = nuevoEstado;

    if (tabulatorRow) {
      tabulatorRow.update({ oculto: nuevoEstado });
    } else {
      reloadGrid();
    }

    // refresca el panel de detalle si el registro activo es el mismo
    if (selectedRowData?.id_persona === row.id_persona) {
      openDetailPanel({ ...selectedRowData, oculto: nuevoEstado });
    }

    renderAlertSummary().catch(console.error);
    updateAlert(
      nuevoEstado ? "Registro ocultado. Se notificó al destinatario." : "Registro visible para la oficina.",
      nuevoEstado ? "warning" : "success"
    );
  } catch (e) {
    console.error(e);
    updateAlert(e.message || "Error al cambiar visibilidad del registro.", "danger");
  }
}

function _resetModalObservacion() {
  _modoOcultar = false;
  if ($("txtObservacionFinal"))    $("txtObservacionFinal").value = "";
  if ($("selObservacionDirigidoA")) $("selObservacionDirigidoA").value = "SELF";

  const label = $("modalObservacionLabel");
  const btn   = $("btnConfirmarDevolucion");
  if (label) label.innerHTML = `<i class="bi bi-arrow-counterclockwise me-2"></i>Devolver con observación`;
  if (btn)   { btn.textContent = "Devolver"; btn.className = "btn btn-warning"; }
}

function updateVerificationButtons(row) {
  const canVerify = canVerifyFinal();

  const btnAprobar = $("btnAprobarFinal");
  const btnDesverificar = $("btnAbrirDesverificarFinal");

  if (!btnAprobar || !btnDesverificar) return;

  // 🚫 Si NO puede verificar → oculta todo
  if (!canVerify) {
    btnAprobar.classList.add("d-none");
    btnDesverificar.classList.add("d-none");
    return;
  }

  // ✅ Si SÍ puede verificar → mostrar según estado
  btnAprobar.classList.remove("d-none");
  btnDesverificar.classList.remove("d-none");

  const yaFinal = !!row.verificado_at;

  // lógica UX pro
  btnAprobar.disabled = yaFinal;
  btnDesverificar.disabled = !yaFinal;
}

function initPersonasGrid() {
  if (window.personasGrid) return window.personasGrid;

  window.personasGrid = new Tabulator("#gridPersonas", {
    layout: "fitColumns",
    height: "560px",
    placeholder: "Sin registros para mostrar",
    pagination: true,
    paginationMode: "remote",
    paginationSize: gridState.pageSize,
    paginationSizeSelector: [10, 25, 50, 100],
    movableColumns: false,
    selectableRows: 1,
    headerSortTristate: true,
    rowHeight: 76,
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
      if (_highlightId) {
        requestAnimationFrame(() => _flashRow(_highlightId));
      } else if (_keepSelection && selectedRowData?.id_persona) {
        const id = selectedRowData.id_persona;
        _keepSelection = false;
        requestAnimationFrame(() => _reSelectAfterReload(id));
      }
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

    legacyColumns: [
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
            irAEdicionCaptura(row.id_persona);
            return;
          }

          if (action === "del") {
            updateAlert(`Aquí conectamos eliminación para ID ${row.id_persona}.`, "secondary");
          }

          if (action === "ocultar") {
            await toggleOcultoPersona(row, cell.getRow());
          }
        }
      }
    ],

    columns: [
      {
        title: "Listado de Actores",
        field: "nombre_completo",
        formatter: personaFormatter,
        headerSort: true
      }
    ]
  });

  // ✅ igual que analista.js
  window.personasGrid.on("rowClick", async function (_e, row) {
    const data = row.getData();
    selectedRowData = data;
    row.select();

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

function reloadGrid(keepPage = false) {
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

  // Preservar página si es un refresh post-edición
  const currentPage = keepPage ? (window.personasGrid.getPage() || 1) : 1;

  window.personasGrid.setData().then(() => {
    if (keepPage && currentPage > 1) {
      window.personasGrid.setPage(currentPage).catch(() => {});
    }
  }).catch(() => {});
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

function getPartidoLogo(row) {
  // Prioridad: 1. siglas del JOIN, 2. partido_nombre, 3. fallback
  const siglas = row.siglas?.trim().toUpperCase() || 
                 (row.partido_nombre || '').trim().toUpperCase() || '';
  
  const logos = {
    'PAN': '/static/assets/partidos/pan.png',
    'PRI': '/static/assets/partidos/pri.png', 
    'PVEM': '/static/assets/partidos/pvem.png',
    'PT': '/static/assets/partidos/pt.png',
    'MC': '/static/assets/partidos/mc.png',
    'PRD': '/static/assets/partidos/prd.png',
    'MORENA': '/static/assets/partidos/morena.png',
    'OTRO': '/static/assets/partidos/otro.png',
    'IND': '/static/assets/partidos/ind.png'
  };
  
  return logos[siglas] || logos['OTRO'] || null;
}

function renderPartidoChip(row) {
  if (!row.id_partido_actual && !row.partido_otro_texto) {
    return '<span class="badge bg-secondary">Sin partido</span>';
  }

  const logoUrl = getPartidoLogo(row);

  return `
    <div class="partido-chip">
      ${logoUrl ? `
        <img src="${esc(logoUrl)}" alt="Logo partido"
             class="partido-logo rounded"
             onerror="this.style.display='none'; this.insertAdjacentHTML('afterend','<span class=\'badge bg-secondary\'>?</span>');"
             loading="lazy">
      ` : '<span class="badge bg-secondary">?</span>'}
    </div>
  `;
}



function legacyOpenDetailPanel(row) {
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
        ${row.oculto ? `<span class="badge bg-danger mt-1">OCULTO PARA LA OFICINA</span>` : ""}
      </div>
    </div>
    ${(() => {
      const u = getCurrentUser();
      const esSuperadmin = Array.isArray(u.roles) && u.roles.includes("superadmin");
      if (!esSuperadmin || !canVerifyFinal()) return "";
      return `
        <div class="d-flex justify-content-end gap-2 mb-2">
          <button id="btnEditarCapturaDetalle" class="btn btn-sm btn-primary">
            <i class="bi bi-pencil-square me-1"></i>
            Editar
          </button>
          <button id="btnToggleOculto" class="btn btn-sm ${row.oculto ? "btn-outline-success" : "btn-outline-danger"}">
            <i class="bi bi-eye${row.oculto ? "" : "-slash"} me-1"></i>
            ${row.oculto ? "Hacer visible para la oficina" : "Ocultar para la oficina"}
          </button>
        </div>
      `;
    })()}

    <div class="detail-kv-row">
      <span class="label">Partido político</span>
      <span class="value partido-value">
        ${renderPartidoChip(row)}
      </span>
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
      <div class="detail-block-title">Historial y validación</div>
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

  $("btnEditarCapturaDetalle")?.addEventListener("click", () => {
    irAEdicionCaptura(row.id_persona);
  });

  // toggle ocultar desde el panel de detalle
  $("btnToggleOculto")?.addEventListener("click", () => {
    toggleOcultoPersona(row, null);
  });

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

function openDetailPanel(row) {
  selectedRowData = row || null;

  const empty = $("estadoVacioFicha");
  const detail = $("contenedorFichaDetalle");
  if (!detail || !row) return;

  const previousPreviewUrl = $("previewExpedientePanel")?.dataset?.previewUrl;
  if (previousPreviewUrl) URL.revokeObjectURL(previousPreviewUrl);

  empty?.classList.add("d-none");
  detail.classList.remove("d-none");

  const firmaStep = (label, dateValue) => {
    const validado = Boolean(dateValue);
    return `
      <div class="signature-step ${validado ? "is-valid" : "is-pending"}">
        <div class="signature-dot">
          <i class="bi ${validado ? "bi-check-lg" : "bi-clock"}"></i>
        </div>
        <div class="signature-body">
          <div class="fw-bold">${esc(label)}</div>
          <div class="small text-muted">${esc(fmtDateTime(dateValue))}</div>
          <span class="badge ${validado ? "text-bg-success" : "text-bg-warning"} mt-2">
            ${validado ? "Validado" : "Pendiente"}
          </span>
        </div>
      </div>
    `;
  };

  detail.innerHTML = `
    <div class="detail-tabs-shell">
      <div class="detail-tabs-nav">
        <button type="button" class="detail-tab-btn active" data-detail-tab="quick">
          <i class="bi bi-layout-text-sidebar-reverse me-1"></i>Detalle rapido
        </button>
        <button type="button" class="detail-tab-btn" data-detail-tab="preview">
          <i class="bi bi-file-earmark-pdf me-1"></i>Preview expediente
        </button>
      </div>

      <div class="detail-tab-pane active" id="detailTabQuick">
        <div class="detail-executive detail-two-column">
          <div class="row g-2 h-100">
        <div class="col-md-8 detail-info-column">
          <div class="detail-main-card rounded-3">
            <div class="detail-executive-header">
              <div class="detail-biblio-photo">
                ${
                  row.foto_url
                    ? `<img class="detail-executive-avatar" src="${esc(row.foto_url)}" alt="Foto de perfil">`
                    : `<div class="detail-executive-avatar detail-executive-initials">${esc(initials(row.nombre_completo || row.nombre || ""))}</div>`
                }
              </div>
              <div>
                <div class="d-flex align-items-center gap-2 flex-wrap mb-1">
                  <span class="badge rounded-pill text-bg-light border text-dark">ID ${esc(row.id_persona || "N/D")}</span>
                  <span class="badge rounded-pill detail-brand-badge">Nivel Final</span>
                  ${row.oculto ? `<span class="badge text-bg-danger">OCULTO</span>` : ""}
                </div>
                <h3 class="detail-executive-name mb-1">${esc(row.nombre_completo || row.nombre || "Sin nombre")}</h3>
                <div class="text-muted small mb-2">
                  <i class="bi bi-calendar3 me-1"></i>Fecha de captura: ${esc(fmtDateTime(row.created_at))}
                </div>
                <div class="detail-party-box">
                  <div class="detail-party-label">PARTIDO ACTUAL</div>
                  <div class="d-flex align-items-center gap-2">
                    ${renderPartidoChip(row)}
                    <div class="fw-bold text-dark">${esc(row.siglas || row.partido_nombre || row.partido_otro_texto || "Sin partido")}</div>
                  </div>
                </div>
              </div>
            </div>

            <div class="row row-cols-2 g-2 detail-meta-grid">
              <div class="col">
                <div class="detail-meta-item">
                  <i class="bi bi-building"></i>
                  <div><span>Region</span><strong>${esc(row.oficina_nombre || "N/D")}</strong></div>
                </div>
              </div>
              <div class="col">
                <div class="detail-meta-item">
                  <i class="bi bi-person-badge"></i>
                  <div><span>Capturista</span><strong>${esc(row.creado_por_nombre || "N/D")}</strong></div>
                </div>
              </div>
              <div class="col">
                <div class="detail-meta-item">
                  <i class="bi bi-geo-alt"></i>
                  <div><span>Municipios</span><strong>${esc(row.total_municipios_trabajo || 0)}</strong></div>
                </div>
              </div>
              <div class="col">
                <div class="detail-meta-item">
                  <i class="bi bi-eye"></i>
                  <div><span>Reviso</span><strong>${esc(row.verif_office_por_nombre || "Pendiente")}</strong></div>
                </div>
              </div>
            </div>
          </div>

          <div class="detail-signature-flow">
            <div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3">
              <div>
                <div class="detail-section-label">Revisiónn</div>
                <div class="small text-muted">Revisión institucional</div>
              </div>
              ${verificationChip(row.estado_verificacion)}
            </div>
            <div class="signature-line">
              ${firmaStep("Direccion", row.verif_area_at)}
              ${firmaStep("Coordinacion", row.verif_office_at)}
              ${firmaStep("Subsecretario", row.verificado_at)}
            </div>
          </div>

          <div class="detail-comments-panel rounded-3">
            <div class="text-muted fw-bold mb-2 small">OBSERVACIONES DEL REGISTRO</div>
            <div id="detailObservacionesRegistro" class="detail-observations-list">
              <div class="text-muted small">Cargando observaciones...</div>
            </div>
          </div>
        </div>

        <div class="col-md-4 detail-actions-sidebar">
          <div class="detail-control-section">
            <div class="detail-control-heading"><span>Gestion y Consulta</span></div>
            <div class="detail-action-grid detail-action-stack">
              ${canVerifyFinal() ? `
                <button type="button" class="btn btn-outline-secondary" id="btnEditarCapturaDetalle">
                  <i class="bi bi-pencil-square me-1"></i>Editar Captura
                </button>
              ` : ""}
              <button type="button" class="btn detail-export-btn" id="btnExportarExpedienteDetalle">
                <i class="bi bi-file-earmark-pdf me-1"></i>Exportar Expediente
              </button>
              <button type="button" class="btn btn-outline-secondary" id="btnVerTrazabilidadDetalle">
                <i class="bi bi-clock-history me-1"></i>Control de Historial
              </button>
              ${(() => {
                const u = getCurrentUser();
                const esSuperadmin = Array.isArray(u.roles) && u.roles.includes("superadmin");
                if (!esSuperadmin || !canVerifyFinal()) return "";
                return `
                  <button type="button" class="btn btn-outline-secondary" id="btnToggleOcultoDetalle">
                    <i class="bi bi-eye${row.oculto ? "" : "-slash"} me-1"></i>
                    ${row.oculto ? "Hacer visible para la oficina" : "Ocultar para la Oficina"}
                  </button>
                `;
              })()}
            </div>
          </div>

          <div class="detail-control-section">
            <div class="detail-control-heading"><span>Verificacion de Estado</span></div>
            <div class="detail-action-grid detail-action-stack">
              <button type="button" class="btn btn-final-approve" id="btnAprobarFinalDetalle">
                <i class="bi bi-check-circle-fill me-1"></i>Aprobar Verificacion FINAL
              </button>
              <button type="button" class="btn btn-final-return" id="btnDevolverObservacionDetalle">
                <i class="bi bi-reply-fill me-1"></i>Devolver con Observacion
              </button>
              <button type="button" class="btn btn-final-revoke" id="btnAbrirDesverificarFinalDetalle">
                <i class="bi bi-x-circle me-1"></i>Quitar Verificacion Final
              </button>
            </div>
          </div>
        </div>
      </div>
        </div>
      </div>

      <div class="detail-tab-pane" id="detailTabPreview">
        <div id="previewExpedientePanel" class="preview-expediente-panel">
          <div class="preview-expediente-empty">
            <i class="bi bi-file-earmark-pdf"></i>
            <div class="fw-bold mt-2">Preview del expediente</div>
            <div class="small text-muted">Abre esta pestaña para generar la vista previa oficial.</div>
          </div>
        </div>
      </div>
    </div>
  `;

  const canVerify = canVerifyFinal();
  const yaFinal = Boolean(row.verificado_at);
  const btnAprobarDetalle = $("btnAprobarFinalDetalle");
  const btnDesverificarDetalle = $("btnAbrirDesverificarFinalDetalle");

  if (!canVerify) {
    btnAprobarDetalle?.classList.add("d-none");
    btnDesverificarDetalle?.classList.add("d-none");
  } else {
    if (btnAprobarDetalle) btnAprobarDetalle.disabled = yaFinal;
    if (btnDesverificarDetalle) btnDesverificarDetalle.disabled = !yaFinal;
  }

  $("btnVerTrazabilidadDetalle")?.addEventListener("click", () => {
    if (!selectedRowData?.id_persona) return;
    renderTrazabilidadModal(selectedRowData);
    bootstrap.Modal.getOrCreateInstance($("modalTrazabilidad")).show();
  });

  $("btnAprobarFinalDetalle")?.addEventListener("click", () => {
    if (!selectedRowData?.id_persona) return;
    bootstrap.Modal.getOrCreateInstance($("modalVerificacionFinal")).show();
  });

  $("btnAbrirDesverificarFinalDetalle")?.addEventListener("click", () => {
    if (!selectedRowData?.id_persona) {
      updateAlert("Selecciona un registro antes de retirar la verificacion.", "warning");
      return;
    }
    bootstrap.Modal.getOrCreateInstance($("modalDesverificarFinal")).show();
  });

  $("btnDevolverObservacionDetalle")?.addEventListener("click", () => {
    if (!selectedRowData?.id_persona) return;
    bootstrap.Modal.getOrCreateInstance($("modalObservacionFinal")).show();
  });

  $("btnToggleOcultoDetalle")?.addEventListener("click", () => {
    if (!selectedRowData?.id_persona) return;
    toggleOcultoPersona(selectedRowData, null);
  });

  $("btnEditarCapturaDetalle")?.addEventListener("click", () => {
    irAEdicionCaptura(row.id_persona);
  });

  $("btnExportarExpedienteDetalle")?.addEventListener("click", () => {
    if (!row?.id_persona) return;
    generarPDFPersona(row.id_persona).catch(err => updateAlert(err.message, "danger"));
  });

  setupDetailPreviewTabs(row.id_persona);

  loadDetalleObservaciones(row.id_persona).catch(err => {
    console.error("Error cargando observaciones del detalle:", err);
    const box = $("detailObservacionesRegistro");
    if (box) {
      box.innerHTML = `<div class="text-danger small">No se pudieron cargar las observaciones.</div>`;
    }
  });
}

async function loadDetalleObservaciones(idPersona) {
  const box = $("detailObservacionesRegistro");
  if (!box || !idPersona) return;

  const resp = await apiGet(`/personas/analista/personas/${idPersona}/observaciones`);
  const rows = Array.isArray(resp?.data) ? resp.data : [];

  if (!rows.length) {
    box.innerHTML = `
      <div class="detail-observation-empty">
        Sin observaciones registradas para este expediente.
      </div>
    `;
    return;
  }

  box.innerHTML = rows.map(obs => {
    const pendiente = obs.atendida === false;
    const nivel = obs.nivel || "OBS";
    const destino = obs.dirigido_a || "";
    const fecha = obs.created_at ? fmtDateTime(obs.created_at) : "";

    return `
      <div class="detail-observation-item ${pendiente ? "is-pending" : "is-done"}">
        <div class="d-flex justify-content-between align-items-start gap-2 mb-1">
          <div class="d-flex flex-wrap gap-1">
            <span class="badge ${pendiente ? "text-bg-warning" : "text-bg-success"}">
              ${pendiente ? "Pendiente" : "Atendida"}
            </span>
            <span class="badge text-bg-light border text-dark">${esc(nivel)}</span>
            ${destino ? `<span class="badge text-bg-light border text-dark">Para: ${esc(destino)}</span>` : ""}
          </div>
          <span class="small text-muted text-nowrap">${esc(fecha)}</span>
        </div>
        <div class="detail-observation-text">${esc(obs.observacion || "Sin detalle")}</div>
        <div class="small text-muted mt-1">
          ${obs.creado_por_nombre ? `Registró: ${esc(obs.creado_por_nombre)}` : "Registro del sistema"}
          ${obs.atendida_por_nombre ? ` · Atendió: ${esc(obs.atendida_por_nombre)}` : ""}
        </div>
      </div>
    `;
  }).join("");
}

function setupDetailPreviewTabs(idPersona) {
  const buttons = Array.from(document.querySelectorAll("[data-detail-tab]"));
  const quick = $("detailTabQuick");
  const preview = $("detailTabPreview");
  let previewLoaded = false;

  buttons.forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.detailTab;

      buttons.forEach(b => b.classList.toggle("active", b === btn));
      quick?.classList.toggle("active", tab === "quick");
      preview?.classList.toggle("active", tab === "preview");

      if (tab === "preview" && !previewLoaded) {
        previewLoaded = true;
        loadExpedientePreviewPdf(idPersona).catch(err => {
          console.error("Error cargando preview expediente:", err);
          const box = $("previewExpedientePanel");
          if (box) {
            box.innerHTML = `
              <div class="alert alert-danger mb-0">
                No se pudo cargar el preview del expediente.
              </div>
            `;
          }
        });
      }
    });
  });
}

async function loadExpedientePreviewPdf(idPersona) {
  const box = $("previewExpedientePanel");
  if (!box || !idPersona) return;

  box.innerHTML = `
    <div class="preview-expediente-loading">
      <div class="spinner-border spinner-border-sm text-secondary" role="status"></div>
      <span>Generando preview...</span>
    </div>
  `;

  const token = localStorage.getItem("token") || "";
  const res = await fetch(`/api/personas/preview/${encodeURIComponent(idPersona)}/pdf`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (res.status === 401) {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    location.href = "/";
    return;
  }

  if (!res.ok) {
    throw new Error("No se pudo generar el preview.");
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);

  box.dataset.previewUrl = url;
  box.innerHTML = `
    <iframe
      class="preview-expediente-frame"
      src="${url}"
      title="Preview del expediente"
    ></iframe>
  `;
}

  function closeDetailPanel() {
    $("detailPanel")?.classList.remove("open");
    $("detailPanelBackdrop")?.classList.add("d-none");
  }
  function renderTrazabilidadModal(row) {
    const header = $("trazabilidadHeader");
    const timeline = $("trazabilidadTimeline");
    if (!header || !timeline || !row) return;

    header.innerHTML = `
      <div class="d-flex align-items-center gap-3">
        ${
              `<div class="rounded-circle d-flex align-items-center justify-content-center bg-secondary text-white"
                    style="width:56px;height:56px;font-weight:700;">
                ${esc(initials(row.nombre_completo || row.nombre || ""))}
              </div>`
        }
        <div>
          <div class="fw-bold fs-5">${esc(row.nombre_completo || "Sin nombre")}</div>
          <div class="text-muted">${esc(row.oficina_nombre || "Sin oficina")}</div>
        </div>
      </div>
    `;

    const events = [];

    if (row.created_at) {
      events.push({
        type: "Creación del registro",
        icon: "bi-plus-circle",
        badge: "bg-primary",
        user: row.creado_por_nombre || "—",
        cargo: row.creado_por_cargo || "",
        area: row.creado_por_area || "",
        at: row.created_at
      });
    }

    if (row.updated_at && row.modificado_por_nombre) {
      events.push({
        type: "Última modificación",
        icon: "bi-pencil-square",
        badge: "bg-warning text-dark",
        user: row.modificado_por_nombre || "—",
        cargo: row.modificado_por_cargo || "",
        area: row.modificado_por_area || "",
        at: row.updated_at
      });
    }

    if (row.verif_area_at) {
      events.push({
        type: "Verificación Dirección",
        icon: "bi-shield-check",
        badge: "bg-info text-dark",
        user: row.verif_area_por_nombre || "—",
        cargo: row.verif_area_por_cargo || "",
        area: row.verif_area_por_area || "",
        at: row.verif_area_at
      });
    }

    if (row.verif_office_at) {
      events.push({
        type: "Verificación Coordinación",
        icon: "bi-shield-check",
        badge: "bg-secondary",
        user: row.verif_office_por_nombre || "—",
        cargo: row.verif_office_por_cargo || "",
        area: row.verif_office_por_area || "",
        at: row.verif_office_at
      });
    }

    if (row.verificado_at) {
      events.push({
        type: "Verificación Final",
        icon: "bi-patch-check-fill",
        badge: "bg-success",
        user: row.verificado_por_nombre || "—",
        cargo: row.verificado_por_cargo || "",
        area: row.verificado_por_area || "",
        at: row.verificado_at
      });
    }

    timeline.innerHTML = `
      <div class="timeline-wrap">
        ${events.map(ev => `
          <div class="timeline-item d-flex gap-3 mb-4">
            <div class="timeline-marker">
              <span class="badge rounded-pill ${ev.badge} p-3">
                <i class="bi ${ev.icon}"></i>
              </span>
            </div>
            <div class="timeline-content flex-grow-1 border rounded-3 p-3 bg-light-subtle">
              <div class="d-flex justify-content-between align-items-start flex-wrap gap-2">
                <div>
                  <div class="fw-semibold">${esc(ev.type)}</div>
                  <div class="text-muted small">${esc(ev.user)}</div>
                </div>
                <div class="small text-muted">${esc(fmtDateTime(ev.at))}</div>
              </div>
              ${
                ev.cargo || ev.area
                  ? `<div class="mt-2 small">
                      ${ev.cargo ? `<div><strong>Cargo:</strong> ${esc(ev.cargo)}</div>` : ""}
                      ${ev.area ? `<div><strong>Área:</strong> ${esc(ev.area)}</div>` : ""}
                    </div>`
                  : ""
              }
            </div>
          </div>
        `).join("")}
      </div>
    `;
  }

function renderNotificaciones(rows = []) {
  const el = $("notificacionesContainer");
  if (!el) return;

  const leidas = rows.filter(r => r.leida).length;
  const noLeidas = rows.length - leidas;

  if (!rows.length) {
    el.innerHTML = `<div class="text-muted">No hay notificaciones recientes.</div>`;
    return;
  }

  el.innerHTML = `
    <div class="notification-stats">
      <div class="stats-row">
        <div class="stat-item ${noLeidas ? 'stat-unread' : 'stat-read'}">
          <i class="bi bi-bell"></i> ${noLeidas} Nueva${noLeidas !== 1 ? 's' : ''}
        </div>
        <div class="stat-item stat-read">
          <i class="bi bi-check-circle"></i> ${leidas} Leída${leidas !== 1 ? 's' : ''}
        </div>
        <div class="stat-item stat-total">
          <i class="bi bi-list-ul"></i> Total: ${rows.length}
        </div>
      </div>
    </div>
  ` + rows.map(r => `
    <div class="notification-item ${r.leida ? "is-read" : "is-unread"}"
         data-id="${r.id_evento}" data-persona="${r.id_persona}">
      
      <span class="notification-badge ${r.leida ? "is-read" : "is-unread"}" title="${r.leida ? 'Leída' : 'Nueva'}">
        <i class="bi ${r.leida ? 'bi-check-lg' : 'bi-bell-fill'}"></i>
        ${r.leida ? 'Leída' : 'Nueva'}
      </span>
      
      <div class="notification-info">
        <div class="notification-username" title="${esc(r.usuario || "Sistema")}">
          ${esc(r.usuario || "Sistema")}
        </div>
        <div class="notification-date">${esc(fmtDT(r.fecha))}</div>
      </div>
      
      <div class="notification-content" title="${esc(r.detalle || "—")}">
        ${esc(r.detalle || "—")}
      </div>
      
      <div class="notification-meta">
        #${r.id_persona}
      </div>
    </div>
  `).join("");

  el.querySelectorAll(".notification-item").forEach(item => {
    item.addEventListener("click", async () => {
      const idObservacion = Number(item.dataset.id);
      if (!Number.isFinite(idObservacion)) return;
      try {
        await fetchJson(`/api/personas/dashboard/notificaciones/${idObservacion}/leida`, { method: "POST" });
        item.classList.remove("is-unread");
        item.classList.add("is-read");
        updateBadgeNotificaciones(rows);
      } catch (e) {
        console.error("No se pudo marcar como leída:", e);
      }
    });
  });
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

  await Promise.all([
    loadKpiVerificacion(),
    loadKpiOficinas()
  ]);
}

function renderChartMunicipios(rows) {
  const canvas = $("chartMunicipios");
  if (!canvas) return;

  const top = (rows || []).slice(0, 10);
  const labels = top.map(r => r.municipio);
  const values = top.map(r => Number(r.total || 0));

  if (chartMunicipios) chartMunicipios.destroy();
  chartMunicipios = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Actores",
        data: values,
        backgroundColor: "#7c3aed",
        borderRadius: 8,
        borderSkipped: false,
        maxBarThickness: 18
      }]
    },
    options: getChartBaseOptions({
      indexAxis: "y",
      interaction: {
        mode: "nearest",
        intersect: true
      },
      plugins: {
        ...getChartBaseOptions().plugins,
        legend: { display: false }
      },
      scales: {
        x: {
          beginAtZero: true,
          grid: {
            color: "rgba(15, 23, 42, 0.08)"
          },
          ticks: {
            color: "#6b7280",
            precision: 0
          }
        },
        y: {
          grid: {
            display: false
          },
          ticks: {
            color: "#374151",
            font: {
              size: 11,
              weight: "600"
            }
          }
        }
      }
    })
  });
}

  async function loadKpiVerificacion() {
  try {
    const qs = buildGridQuery();
    const resp = await fetchJson(`${KPI_VERIFICACION_URL}?${qs.toString()}`);
    const rows = resp?.data || [];
    renderChartVerificacion(rows);
  } catch (err) {
    console.warn("No se pudo cargar KPI verificación:", err.message);
  }
}

function renderChartVerificacion(rows) {
  const canvas = $("chartVerificacion");
  if (!canvas) return;

  const order = ["SIN VERIFICAR", "AREA", "OFFICE", "FINAL"];
  const labelsMap = {
    "SIN VERIFICAR": "Sin verificar",
    "AREA": "Dirección",
    "OFFICE": "Coordinación",
    "FINAL": "Ofi. Subsecretario"
  };

  const map = new Map(
    (rows || []).map(r => [
      String(r.estado_verificacion || "").toUpperCase(),
      Number(r.total || 0)
    ])
  );

  const labels = order.map(k => labelsMap[k]);
  const values = order.map(k => map.get(k) || 0);

  if (chartVerificacion) chartVerificacion.destroy();
  chartVerificacion = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: [
          "#9ca3af", // Sin verificar
          "#f59e0b", // Dirección
          "#3b82f6", // Coordinación
          "#16a34a"  // Final
        ],
        borderWidth: 0,
        hoverOffset: 8
      }]
    },
    options: getChartBaseOptions({
      cutout: "62%",
      plugins: {
        ...getChartBaseOptions().plugins,
        legend: {
          position: "bottom",
          labels: {
            boxWidth: 12,
            boxHeight: 12,
            padding: 16,
            color: "#374151",
            font: { size: 12, weight: "600" }
          }
        }
      }
    })
  });
}

async function loadKpiOficinas() {
  try {
    const qs = buildGridQuery();
    const resp = await fetchJson(`${KPI_OFICINAS_URL}?${qs.toString()}`);
    const rows = resp?.data || [];
    renderChartOficinas(rows);
  } catch (err) {
    console.warn("No se pudo cargar KPI oficinas:", err.message);
  }
}

function renderChartOficinas(rows) {
  const canvas = $("chartOficinas");
  if (!canvas) return;

  const top = (rows || []).slice(0, 8);
  const labels = top.map(r => r.oficina || "Sin oficina");
  const total = top.map(r => Number(r.total || 0));
  const finalizados = top.map(r => Number(r.finalizados || 0));

  if (chartOficinas) chartOficinas.destroy();
  chartOficinas = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Total registros",
          data: total,
          backgroundColor: "#cbd5e1",
          borderRadius: 8,
          borderSkipped: false,
          maxBarThickness: 22
        },
        {
          label: "Finalizados",
          data: finalizados,
          backgroundColor: "#16a34a",
          borderRadius: 8,
          borderSkipped: false,
          maxBarThickness: 22
        }
      ]
    },
    options: getChartBaseOptions({
      plugins: {
        ...getChartBaseOptions().plugins,
        legend: {
          position: "bottom",
          labels: {
            boxWidth: 12,
            boxHeight: 12,
            padding: 14,
            color: "#374151",
            font: { size: 12, weight: "600" }
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: "#374151",
            font: {
              size: 11,
              weight: "600"
            }
          }
        },
        y: {
          beginAtZero: true,
          grid: {
            color: "rgba(15, 23, 42, 0.08)"
          },
          ticks: {
            color: "#6b7280",
            precision: 0
          }
        }
      }
    })
  });
}

const OBSERVACIONES_DESCARTADAS_KEY = "dashboard_observaciones_descartadas_v1";

function getObservacionesDescartadas() {
  try {
    return new Set(JSON.parse(localStorage.getItem(OBSERVACIONES_DESCARTADAS_KEY) || "[]").map(String));
  } catch {
    return new Set();
  }
}

function descartarObservacionAlerta(idObservacion) {
  const hidden = getObservacionesDescartadas();
  hidden.add(String(idObservacion));
  localStorage.setItem(OBSERVACIONES_DESCARTADAS_KEY, JSON.stringify([...hidden]));
}

function restaurarObservacionesDescartadas() {
  localStorage.removeItem(OBSERVACIONES_DESCARTADAS_KEY);
}

// ── Modal paginado de observaciones ──────────────────────────────────────────
const OBS_TIPOS = {
  "observaciones": "pendientes",
  "atendidas":     "atendidas_hoy",
  "final":         "final_7d"
};

async function showObservacionesModal(alerta, page = 1) {
  const body  = $("alertaDetalleBody");
  const title = $("modalAlertaDetalleLabel");
  if (!body || !title) return;

  const tipo = OBS_TIPOS[alerta.tipo] || "pendientes";
  const size = 25;

  title.innerHTML = `<i class="bi bi-exclamation-triangle me-2"></i>${esc(alerta.title || "Observaciones")}`;
  body.innerHTML  = `<div class="text-muted py-3 text-center"><div class="spinner-border spinner-border-sm me-2"></div>Cargando...</div>`;
  bootstrap.Modal.getOrCreateInstance($("modalAlertaDetalle")).show();

  try {
    const resp = await fetchJson(`/api/personas/dashboard/alertas/observaciones?tipo=${tipo}&page=${page}&size=${size}`);
    const rows      = resp.data      || [];
    const total     = resp.total     || 0;
    const last_page = resp.last_page || 1;
    const hidden    = getObservacionesDescartadas();

    const filas = rows
      .filter(r => !hidden.has(String(r.id_observacion || "")))
      .map(r => {
        const fecha       = r.atendida_at || r.created_at;
        const nivelLabel  = { FINAL:"Final", AREA:"Dirección", OFFICE:"Coordinación", SELF:"Capturista" }[r.nivel] || r.nivel || "—";
        const dirigidoLabel = (() => {
          const base = { SELF:"Capturista", AREA:"Dirección", OFFICE:"Coordinación" }[r.dirigido_a] || r.dirigido_a || "—";
          return r.dirigido_a_nombre ? `${base} — ${esc(r.dirigido_a_nombre)}` : base;
        })();
        const atendida = r.atendida_por_nombre
          ? `<div class="small text-success mt-1"><i class="bi bi-check-circle me-1"></i>Atendida por: ${esc(r.atendida_por_nombre)}${r.atendida_at ? ` · ${esc(fmtDT(r.atendida_at))}` : ""}</div>`
          : "";
        return `
          <div class="alert-modal-item" data-alert-item="${esc(r.id_observacion || "")}">
            <div class="d-flex justify-content-between gap-3 flex-wrap">
              <div>
                <div class="fw-semibold">${esc(r.persona || `Registro #${r.id_persona || ""}`)}</div>
                <div class="small text-muted">
                  ID ${esc(r.id_persona || "—")}
                  · Nivel <strong>${esc(nivelLabel)}</strong>
                  · Para <strong>${dirigidoLabel}</strong>
                </div>
              </div>
              <div class="text-end">
                <div class="small text-muted">${esc(fmtDT(fecha))}</div>
                ${r.id_observacion ? `<button type="button" class="btn btn-sm btn-outline-secondary mt-1" data-action="descartar-observacion-alerta" data-id="${esc(r.id_observacion)}">Ocultar</button>` : ""}
              </div>
            </div>
            <div class="mt-2 fst-italic">${esc(r.observacion || "—")}</div>
            <div class="small text-muted mt-2 d-flex flex-wrap gap-3">
              <span><i class="bi bi-building me-1"></i>${esc(r.oficina_nombre || "—")}</span>
              <span><i class="bi bi-person me-1"></i>Capturó: ${esc(r.capturista_nombre || "—")}</span>
              <span><i class="bi bi-eye me-1"></i>Observó: ${esc(r.creado_por_nombre || "Sistema")}</span>
            </div>
            ${atendida}
          </div>`;
      }).join("") || `<div class="text-muted">Sin observaciones visibles en esta página.</div>`;

    // Paginación
    const desde = (page - 1) * size + 1;
    const hasta = Math.min(page * size, total);
    const paginacion = last_page > 1 ? `
      <div class="d-flex justify-content-between align-items-center mt-3 pt-2 border-top flex-wrap gap-2">
        <div class="small text-muted">Mostrando ${desde}–${hasta} de ${total}</div>
        <div class="d-flex gap-1">
          <button class="btn btn-sm btn-outline-secondary" ${page <= 1 ? "disabled" : ""} data-obs-page="${page - 1}">
            <i class="bi bi-chevron-left"></i>
          </button>
          <span class="btn btn-sm btn-light disabled">${page} / ${last_page}</span>
          <button class="btn btn-sm btn-outline-secondary" ${page >= last_page ? "disabled" : ""} data-obs-page="${page + 1}">
            <i class="bi bi-chevron-right"></i>
          </button>
        </div>
      </div>` : `<div class="small text-muted mt-2">Total: ${total} observaciones</div>`;

    body.innerHTML = `
      <div class="small text-muted mb-3">${esc(alerta.text || "")}</div>
      <div class="alert-modal-list">${filas}</div>
      ${paginacion}`;

    body.querySelectorAll("[data-obs-page]").forEach(btn => {
      btn.addEventListener("click", () => showObservacionesModal(alerta, Number(btn.dataset.obsPage)));
    });
    body.querySelectorAll('[data-action="descartar-observacion-alerta"]').forEach(btn => {
      btn.addEventListener("click", () => {
        descartarObservacionAlerta(btn.dataset.id);
        showObservacionesModal(alerta, page);
      });
    });

  } catch (e) {
    body.innerHTML = `<div class="text-danger">Error al cargar: ${esc(e.message)}</div>`;
  }
}

function showAlertDetailModal(alerta, opts = {}) {
  const body = $("alertaDetalleBody");
  const title = $("modalAlertaDetalleLabel");
  if (!body || !title) return;

  const hidden = getObservacionesDescartadas();
  const isObservacionAlert = alerta?.tipo === "observaciones";
  const mostrarOcultas = opts.mostrarOcultas === true;
  const allRows = Array.isArray(alerta?.items) ? alerta.items : [];
  const ocultasCount = isObservacionAlert
    ? allRows.filter(r => r.id_observacion && hidden.has(String(r.id_observacion))).length
    : 0;
  const rows = allRows
    .filter(r => !isObservacionAlert || mostrarOcultas || !r.id_observacion || !hidden.has(String(r.id_observacion)));
  title.innerHTML = `<i class="bi bi-exclamation-triangle me-2"></i>${esc(alerta?.title || "Detalle de alerta")}`;

  if (!rows.length) {
    body.innerHTML = `
      ${isObservacionAlert && ocultasCount ? `
        <div class="d-flex gap-2 flex-wrap mb-3">
          <button type="button" class="btn btn-sm btn-outline-primary" data-action="mostrar-observaciones-ocultas">Mostrar ocultas (${ocultasCount})</button>
          <button type="button" class="btn btn-sm btn-outline-danger" data-action="desocultar-observaciones">Desocultar todas</button>
        </div>
      ` : ""}
      <div class="text-muted">No hay detalle visible para esta alerta.</div>
    `;
  } else {
    body.innerHTML = `
      <div class="small text-muted mb-3">${esc(alerta?.text || "")}</div>
      ${isObservacionAlert ? `
        <div class="d-flex gap-2 flex-wrap mb-3">
          ${ocultasCount && !mostrarOcultas ? `<button type="button" class="btn btn-sm btn-outline-primary" data-action="mostrar-observaciones-ocultas">Mostrar ocultas (${ocultasCount})</button>` : ""}
          ${ocultasCount ? `<button type="button" class="btn btn-sm btn-outline-danger" data-action="desocultar-observaciones">Desocultar todas</button>` : ""}
        </div>
      ` : ""}
      <div class="alert-modal-list">
        ${rows.map(r => {
          // ── Desverificados automáticamente ──
          if ("desverf_final_at" in r) {
            const CAMPO_LABELS = {
              nombre: "Nombre", apellido_paterno: "Apellido paterno", apellido_materno: "Apellido materno",
              curp: "CURP", rfc: "RFC", clave_elector: "Clave de elector",
              edad: "Edad", estado_civil: "Estado civil", escala_influencia: "Escala de influencia",
              nivel_confiabilidad: "Confiabilidad", id_partido_actual: "Partido político",
              partido_otro_texto: "Otro partido", municipio_trabajo_politico: "Municipio de trabajo",
              id_oficina: "Oficina", foto_url: "Foto"
            };
            const camposRaw   = (r.desverf_final_campos || "").split(",").map(s => s.trim()).filter(Boolean);
            const camposLabel = camposRaw.map(c => CAMPO_LABELS[c] || c).join(", ");
            return `
              <div class="alert-modal-item">
                <div class="d-flex justify-content-between gap-3 flex-wrap">
                  <div>
                    <div class="fw-semibold">
                      <span class="badge bg-warning text-dark me-1">DESVERIFICADO</span>
                      ${esc(r.persona || `Registro #${r.id_persona || ""}`)}
                    </div>
                    <div class="small text-muted">Oficina: ${esc(r.oficina_nombre || "—")}</div>
                  </div>
                  <div class="small text-muted text-end">${esc(fmtDT(r.desverf_final_at))}</div>
                </div>
                <div class="small text-muted mt-1">Modificado por: ${esc(r.desverf_por_nombre || "—")}</div>
                ${camposLabel ? `
                <div class="mt-2 p-2 rounded" style="background:#fff8e1;border:1px solid #ffe082;">
                  <div class="small fw-semibold" style="color:#b45309;"><i class="bi bi-pencil-square me-1"></i>Campos que cambiaron:</div>
                  <div class="small mt-1" style="color:#92400e;">${esc(camposLabel)}</div>
                </div>` : ""}
                <div class="small text-warning mt-1">
                  <i class="bi bi-arrow-counterclockwise me-1"></i>Requiere re-verificación FINAL
                </div>
              </div>`;
          }
          // ── Registros ocultos ──
          if ("oculto_at" in r) {
            return `
              <div class="alert-modal-item">
                <div class="d-flex justify-content-between gap-3 flex-wrap">
                  <div>
                    <div class="fw-semibold">
                      <span class="badge bg-danger me-1">OCULTO</span>
                      ${esc(r.persona || `Registro #${r.id_persona || ""}`)}
                    </div>
                    <div class="small text-muted">Oficina: ${esc(r.oficina_nombre || "—")}</div>
                  </div>
                  <div class="small text-muted">${esc(fmtDT(r.oculto_at))}</div>
                </div>
                <div class="small text-muted mt-1">Ocultado por: ${esc(r.oculto_por_nombre || "—")}</div>
              </div>`;
          }
          // ── Observaciones / devoluciones ──
          const fecha       = r.atendida_at || r.created_at;
          const descartada  = isObservacionAlert && r.id_observacion && hidden.has(String(r.id_observacion));
          const nivelLabel  = { FINAL:"Final", AREA:"Dirección", OFFICE:"Coordinación", SELF:"Capturista" }[r.nivel] || r.nivel || "—";
          const dirigidoLabel = (() => {
            const base = { SELF:"Capturista", AREA:"Dirección", OFFICE:"Coordinación" }[r.dirigido_a] || r.dirigido_a || "—";
            return r.dirigido_a_nombre ? `${base} — ${esc(r.dirigido_a_nombre)}` : base;
          })();
          const atendida = r.atendida_por_nombre
            ? `<div class="small text-success mt-1"><i class="bi bi-check-circle me-1"></i>Atendida por: ${esc(r.atendida_por_nombre)}${r.atendida_at ? ` · ${esc(fmtDT(r.atendida_at))}` : ""}</div>`
            : "";
          return `
            <div class="alert-modal-item" data-alert-item="${esc(r.id_observacion || "")}">
              <div class="d-flex justify-content-between gap-3 flex-wrap">
                <div>
                  <div class="fw-semibold">${esc(r.persona || `Registro #${r.id_persona || ""}`)}</div>
                  <div class="small text-muted">
                    ID ${esc(r.id_persona || "—")}
                    · Nivel <strong>${esc(nivelLabel)}</strong>
                    · Para <strong>${dirigidoLabel}</strong>
                    ${descartada ? " · <em>Oculta</em>" : ""}
                  </div>
                </div>
                <div class="text-end">
                  <div class="small text-muted">${esc(fmtDT(fecha))}</div>
                  ${isObservacionAlert && r.id_observacion && !descartada
                    ? `<button type="button" class="btn btn-sm btn-outline-secondary mt-2"
                               data-action="descartar-observacion-alerta"
                               data-id="${esc(r.id_observacion)}">Ocultar alerta</button>`
                    : ""}
                </div>
              </div>
              <div class="mt-2 fst-italic">${esc(r.observacion || "—")}</div>
              <div class="small text-muted mt-2 d-flex flex-wrap gap-3">
                <span><i class="bi bi-building me-1"></i>${esc(r.oficina_nombre || "—")}</span>
                <span><i class="bi bi-person me-1"></i>Capturó: ${esc(r.capturista_nombre || "—")}</span>
                <span><i class="bi bi-eye me-1"></i>Observó: ${esc(r.creado_por_nombre || "Sistema")}</span>
              </div>
              ${atendida}
            </div>`;
        }).join("")}
      </div>
    `;
  }

  body.querySelectorAll('[data-action="descartar-observacion-alerta"]').forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (!id) return;
      descartarObservacionAlerta(id);
      showAlertDetailModal(alerta);
    });
  });

  body.querySelectorAll('[data-action="mostrar-observaciones-ocultas"]').forEach(btn => {
    btn.addEventListener("click", () => showAlertDetailModal(alerta, { mostrarOcultas: true }));
  });

  body.querySelectorAll('[data-action="desocultar-observaciones"]').forEach(btn => {
    btn.addEventListener("click", () => {
      restaurarObservacionesDescartadas();
      showAlertDetailModal(alerta);
    });
  });

  bootstrap.Modal.getOrCreateInstance($("modalAlertaDetalle")).show();
}

async function renderAlertSummary() {
  const c = $("alertsContainer");
  if (!c) return;

  const alertas = [];
  const stats   = await loadAlertSummaryData();

  // ── Configuración visual por tipo ──────────────────────────────────
  const V = {
    pendientes: { icon: "bi-exclamation-circle-fill", bg: "#fef2f2", color: "#dc2626", sev: "danger",  pulse: true  },
    final:      { icon: "bi-arrow-counterclockwise",  bg: "#fffbeb", color: "#d97706", sev: "warning", pulse: false },
    desverif:   { icon: "bi-shield-exclamation",      bg: "#fdf2f4", color: "#8b2136", sev: "guinda",  pulse: false },
    atendidas:  { icon: "bi-check-circle-fill",       bg: "#f0fdf4", color: "#16a34a", sev: "success", pulse: false },
    ocultos:    { icon: "bi-eye-slash-fill",          bg: "#f5f3ff", color: "#7c3aed", sev: "purple",  pulse: false },
    contexto:   { icon: "bi-funnel-fill",             bg: "#eff6ff", color: "#0284c7", sev: "info",    pulse: false },
    sensitivo:  { icon: "bi-exclamation-octagon-fill",bg: "#fffbeb", color: "#b45309", sev: "warning", pulse: false },
  };

  const push = (v, label, sub, extra = {}) =>
    alertas.push({ ...v, label, sub, ...extra });

  // ── KPI alerts ─────────────────────────────────────────────────────
  const nPend = Number(stats.observaciones_pendientes || 0);
  if (nPend > 0)
    push(V.pendientes, "Observaciones pendientes",
      "Registros devueltos que requieren atención inmediata",
      { count: nPend, tipo: "observaciones", usePagination: true,
        items: stats.observaciones_pendientes_detalle || [],
        title: `${nPend} observación(es) pendiente(s)` });

  const nFinal = Number(stats.devoluciones_final_7d || 0);
  if (nFinal > 0)
    push(V.final, "Devoluciones FINAL · últimos 7 días",
      "Cierres institucionales devueltos recientemente",
      { count: nFinal, tipo: "final", usePagination: true,
        items: stats.devoluciones_final_7d_detalle || [],
        title: `${nFinal} devolución(es) FINAL en los últimos 7 días` });

  const nDesv = Number(stats.desverificados_auto || 0);
  if (nDesv > 0)
    push(V.desverif, "Perdieron verificación FINAL",
      "Datos modificados post-verificación. Requieren revisión.",
      { count: nDesv,
        items: stats.desverificados_auto_detalle || [],
        title: `${nDesv} registro(s) perdieron verificación FINAL por cambio de datos` });

  const nAten = Number(stats.observaciones_atendidas_hoy || 0);
  if (nAten > 0)
    push(V.atendidas, "Observaciones atendidas",
      "Con seguimiento registrado",
      { count: nAten, tipo: "atendidas", usePagination: true,
        items: stats.observaciones_atendidas_hoy_detalle || [],
        title: `${nAten} observacion(es) atendida(s)` });

  const nOcul = Number(stats.registros_ocultos || 0);
  if (nOcul > 0)
    push(V.ocultos, "Registros ocultos",
      "Bajo revisión del área final. Solo visibles para superadmin.",
      { count: nOcul,
        items: stats.registros_ocultos_detalle || [],
        title: `${nOcul} registro(s) oculto(s) para su oficina` });

  // ── Context alerts (filtros activos) ───────────────────────────────
  if (gridState.solo_pendientes_final)
    push(V.contexto, "Vista: pendientes FINAL",
      "La bandeja muestra registros que requieren cierre institucional.",
      { title: "Vista enfocada en pendientes FINAL" });

  if (gridState.controversias === "1")
    push(V.sensitivo, "Filtro: controversias activo",
      "Se priorizan perfiles con seguimiento sensible.",
      { title: "Filtro de controversias activo" });

  if (gridState.oficinaId)
    push(V.contexto, "Segmentado por oficina",
      "El tablero está acotado a una oficina específica.",
      { title: "Segmentación por oficina" });

  // ── Empty state ────────────────────────────────────────────────────
  if (!alertas.length) {
    c.innerHTML = `
      <div class="acrd-empty">
        <div class="acrd-empty-icon"><i class="bi bi-shield-check"></i></div>
        <div class="acrd-empty-title">Sistema al día</div>
        <div class="acrd-empty-sub">Sin incidencias que requieran atención</div>
      </div>`;
    return;
  }

  // ── Render cards ───────────────────────────────────────────────────
  c.innerHTML = alertas.map((a, idx) => {
    const clickable = a.usePagination || (Array.isArray(a.items) && a.items.length > 0);
    const countHtml = a.count != null
      ? `<div class="acrd-count" style="color:${a.color}">${a.count}</div>`
      : "";
    const actionHtml = clickable
      ? `<div class="acrd-action"><span>Ver detalle</span><i class="bi bi-arrow-right-short"></i></div>`
      : "";
    return `
      <div class="acrd acrd-${a.sev}${clickable ? " is-clickable" : ""}" data-alert-idx="${idx}">
        <div class="acrd-icon${a.pulse ? " acrd-pulse" : ""}"
             style="background:${a.bg};color:${a.color}">
          <i class="bi ${a.icon}"></i>
        </div>
        <div class="acrd-body">
          ${countHtml}
          <div class="acrd-label">${esc(a.label)}</div>
          <div class="acrd-sub">${esc(a.sub)}</div>
          ${actionHtml}
        </div>
      </div>`;
  }).join("");

  c.querySelectorAll("[data-alert-idx]").forEach(el => {
    el.addEventListener("click", () => {
      const idx    = Number(el.dataset.alertIdx);
      const alerta = alertas[idx];
      if (!alerta) return;
      if (alerta.usePagination) { showObservacionesModal(alerta, 1); return; }
      if (Array.isArray(alerta.items) && alerta.items.length) showAlertDetailModal(alerta);
    });
  });
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
    await loadPartidosFiltro();
    loadConfiabilidadFiltro();
    loadInfluenciaFiltro();
    //loadReferentesDashboard().catch(console.error);
    await loadAllDashboardData();

    const rows = await loadNotificaciones();
    updateBadgeNotificaciones(rows);
  }

  // ── Highlight de registro post-edición ──────────────────────────────────────
  const _highlightId = (() => {
    const p = new URLSearchParams(window.location.search).get("highlight");
    const id = Number(p);
    if (id > 0) {
      // Limpia el param de la URL sin recargar
      window.history.replaceState({}, "", "/dashboard");
      // Usa updated_at DESC para que el registro editado esté en página 1
      gridState.sortField = "updated_at";
      return id;
    }
    return null;
  })();

  let _keepSelection = false; // flag para re-seleccionar tras reloadGrid(true)

  function _flashRow(idPersona) {
    if (!idPersona || !window.personasGrid) return;
    const row = window.personasGrid.getRow(idPersona);
    if (!row) return;
    const el  = row.getElement();
    const data = row.getData();
    if (!el) return;

    // Scroll suave al registro
    el.scrollIntoView({ behavior: "smooth", block: "center" });

    // Animación dorada
    el.style.transition = "background .3s, outline .3s";
    el.style.background  = "#fef3c7";
    el.style.outline     = "2px solid #b89056";
    el.style.borderRadius = "6px";
    setTimeout(() => {
      el.style.background = "";
      el.style.outline    = "";
    }, 3000);

    // Seleccionar la fila y abrir panel lateral con datos frescos
    selectedRowData = data;
    openDetailPanel(data);
  }

  function _reSelectAfterReload(idPersona) {
    if (!idPersona || !window.personasGrid) return;
    const row = window.personasGrid.getRow(idPersona);
    if (!row) return;
    const el   = row.getElement();
    const data = row.getData();

    selectedRowData = data;
    openDetailPanel(data);  // refresca panel con datos actualizados

    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      // Pulso sutil para indicar que se actualizó
      el.style.transition  = "background .25s";
      el.style.background  = "#f0fdf4";
      setTimeout(() => { el.style.background = ""; }, 1500);
    }
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
