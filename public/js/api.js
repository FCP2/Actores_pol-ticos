function logout() {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  if (location.pathname !== "/") location.href = "/";
}

function getToken() {
  return localStorage.getItem("token") || "";
}

async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = { ...(options.headers || {}) };

  // Solo set Content-Type si mandas body JSON y aún no está definido
  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch("/api" + path, { ...options, headers });

  // Lee respuesta como texto primero (para manejar JSON y no-JSON)
  const text = await res.text();
  const ct = res.headers.get("content-type") || "";

  let data = null;
  if (ct.includes("application/json")) {
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { _nonJson: true, text }; // JSON inválido
    }
  } else {
    data = { _nonJson: true, text };
  }

  if (!res.ok) {
    if (res.status === 401) {
      logout();
      throw new Error("Sesión expirada. Inicia sesión de nuevo.");
    }

    if (res.status === 403) {
      throw new Error("No tienes permisos para realizar esta acción.");
    }

    const msg =
      (data && data.error) ||
      (data && data.message) ||
      (data && data._nonJson ? `Respuesta no-JSON (${res.status}): ${String(data.text || "").slice(0, 160)}...` : null) ||
      `Error ${res.status}`;

    throw new Error(msg);
  }

  return data;
}

function apiGet(path) {
  return apiFetch(path, { method: "GET" });
}

function apiPost(path, body) {
  return apiFetch(path, { method: "POST", body: JSON.stringify(body || {}) });
}

function apiPut(path, body) {
  return apiFetch(path, { method: "PUT", body: JSON.stringify(body || {}) });
}

function apiDelete(path) {
  return apiFetch(path, { method: "DELETE" });
}