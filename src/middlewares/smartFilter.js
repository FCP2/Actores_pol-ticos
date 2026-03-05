// middlewares/smartFilter.js

function normalizeText(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function resolveScopeFallback({ roles = [], cargo = "" }) {
  const c = normalizeText(cargo);
  if (roles.includes("superadmin")) return "ALL";
  if (c.includes("coordinador") || c.includes("coordinacion") || c.includes("coord")) return "OFFICE";
  if (roles.includes("analista") || c.includes("director") || c.includes("direccion")) return "AREA";
  return "SELF";
}

function applySmartFilters(req, res, next) {
  const roles = req.user?.roles || [];
  const isSuperadmin = roles.includes("superadmin");

  // ✅ Nuevo: si ya viene scope, úsalo; si no, fallback por cargo
  const scope = req.user?.scope || resolveScopeFallback({ roles, cargo: req.user?.cargo });

  const userArea = String(req.user?.area || "").trim() || null;
  const idOficina = req.user?.id_oficina ?? null;
  const idUsuario = req.user?.id_usuario ?? null;

  req.smartFilters = {
    isSuperadmin,
    scope,

    addOfficeFilter: (params, where) => {
      if (!idOficina) return where.push("1=0");
      params.push(idOficina);
      where.push(`p.id_oficina = $${params.length}`);
    },

    addAreaCreatorFilter: (params, where) => {
      if (!userArea) return where.push("1=0");
      params.push(userArea);
      where.push(`
        EXISTS (
          SELECT 1
          FROM usuarios u_scope
          WHERE u_scope.id_usuario = p.creado_por
            AND COALESCE(u_scope.area,'') = $${params.length}
        )
      `);
    },

    addSelfFilter: (params, where) => {
      if (!idUsuario) return where.push("1=0");
      params.push(idUsuario);
      where.push(`p.creado_por = $${params.length}`);
    },

    addFullFilter: (params, where) => {
      if (isSuperadmin || scope === "ALL") return;

      if (scope === "OFFICE") return req.smartFilters.addOfficeFilter(params, where);
      if (scope === "AREA")   return req.smartFilters.addAreaCreatorFilter(params, where);

      return req.smartFilters.addSelfFilter(params, where);
    },
  };

  next();
}

module.exports = { applySmartFilters };
