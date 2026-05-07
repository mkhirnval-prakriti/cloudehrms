/**
 * Data-scope rules: Super Admin + Admin = org-wide; Attendance/Location managers = same branch only;
 * Staff = self only (enforced per-route with history:read_self etc.).
 */
const { ROLES } = require("./rbac");

function isOrgWide(actor) {
  return actor && (actor.role === ROLES.SUPER_ADMIN || actor.role === ROLES.ADMIN);
}

function isBranchScoped(actor) {
  return actor && (actor.role === ROLES.ATTENDANCE_MANAGER || actor.role === ROLES.LOCATION_MANAGER);
}

/**
 * Whether actor may act on another user's row (same branch for managers; org for admin).
 */
function assertUserAccess(actor, targetRow) {
  if (!actor || !targetRow) return { ok: false, status: 404, error: "Not found" };
  if (Number(actor.id) === Number(targetRow.id)) return { ok: true };
  if (isOrgWide(actor)) {
    if (targetRow.role === ROLES.SUPER_ADMIN && actor.role !== ROLES.SUPER_ADMIN) {
      return { ok: false, status: 403, error: "Forbidden" };
    }
    return { ok: true };
  }
  if (isBranchScoped(actor)) {
    if (actor.branch_id == null) return { ok: false, status: 403, error: "Forbidden" };
    if (targetRow.branch_id == null) return { ok: false, status: 403, error: "Forbidden" };
    if (Number(actor.branch_id) !== Number(targetRow.branch_id)) {
      return { ok: false, status: 403, error: "Forbidden" };
    }
    if (targetRow.role === ROLES.SUPER_ADMIN || targetRow.role === ROLES.ADMIN) {
      return { ok: false, status: 403, error: "Forbidden" };
    }
    return { ok: true };
  }
  return { ok: false, status: 403, error: "Forbidden" };
}

function assertUserIdAccess(db, actor, targetUserId) {
  const row = db
    .prepare(`SELECT id, branch_id, role FROM users WHERE id = ? AND deleted_at IS NULL`)
    .get(Number(targetUserId));
  if (!row) return { ok: false, status: 404, error: "Not found" };
  return assertUserAccess(actor, row);
}

/**
 * Extra SQL fragment for queries that already JOIN users AS `alias`.
 */
function branchScopeSql(actor, alias = "u") {
  if (isOrgWide(actor)) return { sql: "", params: [] };
  if (isBranchScoped(actor)) {
    if (actor.branch_id == null) return { sql: " AND 1=0", params: [] };
    return { sql: ` AND ${alias}.branch_id = ?`, params: [actor.branch_id] };
  }
  return { sql: ` AND ${alias}.id = ?`, params: [actor.id] };
}

/** Allowed roles when a user creates an account.
 *  SUPER_ADMIN → any role
 *  ADMIN       → ATTENDANCE_MANAGER, LOCATION_MANAGER, USER  (NOT ADMIN or SUPER_ADMIN)
 *  Others      → only USER
 */
function allowedRolesForCreate(actor) {
  if (actor.role === ROLES.SUPER_ADMIN) return null; // no restriction
  if (actor.role === ROLES.ADMIN) {
    return new Set([ROLES.ATTENDANCE_MANAGER, ROLES.LOCATION_MANAGER, ROLES.USER]);
  }
  return new Set([ROLES.USER]);
}

function assertRoleAssignableOnCreate(actor, newRole) {
  const allowed = allowedRolesForCreate(actor);
  if (!allowed) return { ok: true };
  if (!allowed.has(newRole)) {
    return { ok: false, status: 403, error: "You can only create Staff accounts for your branch" };
  }
  return { ok: true };
}

module.exports = {
  ROLES,
  isOrgWide,
  isBranchScoped,
  assertUserAccess,
  assertUserIdAccess,
  branchScopeSql,
  allowedRolesForCreate,
  assertRoleAssignableOnCreate,
};
