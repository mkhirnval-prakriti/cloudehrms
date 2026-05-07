const ROLES = {
  SUPER_ADMIN: "SUPER_ADMIN",
  ADMIN: "ADMIN",
  ATTENDANCE_MANAGER: "ATTENDANCE_MANAGER",
  LOCATION_MANAGER: "LOCATION_MANAGER",
  USER: "USER",
};

const ROLE_MATRIX = {
  [ROLES.SUPER_ADMIN]: ["*", "audit:read"],
  [ROLES.ADMIN]: [
    "audit:read",
    "dashboard:read",
    "branches:read",
    "branches:write",
    "departments:read",
    "attendance:self",
    "attendance:read_all",
    "attendance:punch",
    "attendance:manual",
    "attendance:edit_any",
    "attendance:kiosk",
    "attendance:face_placeholder",
    "history:read",
    "history:edit",
    "leave:read_all",
    "leave:approve_manager",
    "export:read",
    "integrations:sync",
    "notices:read",
    "notices:write",
    "timings:read",
    "timings:write",
    "users:read",
    "users:update",
    "settings:read",
    "settings:write",
    "payroll:read",
    "payroll:write",
    "documents:read_all",
    "documents:verify",
    "crm:read",
    "crm:write",
    "biometric:admin",
    "biometric:request_update",
  ],
  [ROLES.ATTENDANCE_MANAGER]: [
    "dashboard:read",
    "branches:read",
    "departments:read",
    "attendance:self",
    "attendance:read_all",
    "attendance:punch",
    "attendance:manual",
    "attendance:edit_any",
    "attendance:kiosk",
    "attendance:face_placeholder",
    "history:read",
    "history:edit",
    "leave:apply",
    "leave:read_self",
    "leave:read_all",
    "export:read",
    "integrations:sync",
    "notices:read",
    "notices:write",
    "timings:read",
    "timings:write",
    "users:read",
    "roles:read",
    "settings:read",
    "payroll:read_self",
    "documents:read_all",
    "documents:verify",
    "crm:read",
    "crm:write",
    "biometric:admin",
    "biometric:request_update",
  ],
  [ROLES.LOCATION_MANAGER]: [
    "dashboard:read",
    "attendance:self",
    "attendance:read_all",
    "attendance:punch",
    "attendance:manual",
    "attendance:edit_any",
    "attendance:kiosk",
    "attendance:face_placeholder",
    "history:read",
    "history:edit",
    "leave:apply",
    "leave:read_self",
    "leave:read_all",
    "leave:approve_manager",
    "export:read",
    "integrations:sync",
    "branches:read",
    "branches:write",
    "departments:read",
    "users:read",
    "users:update",
    "notices:read",
    "timings:read",
    "timings:write",
    "roles:read",
    "settings:read",
    "payroll:read_self",
    "documents:read_all",
    "documents:verify",
    "crm:read",
    "crm:write",
    "biometric:admin",
    "biometric:request_update",
  ],
  [ROLES.USER]: [
    "dashboard:read_self",
    "attendance:self",
    "attendance:punch",
    "attendance:kiosk",
    "attendance:face_placeholder",
    "history:read_self",
    "leave:apply",
    "leave:read_self",
    "export:read",
    "notices:read",
    "timings:read_self",
    "payroll:read_self",
    "biometric:request_update",
  ],
};

function listRolesMeta() {
  return [
    {
      id: ROLES.SUPER_ADMIN,
      label: "Super Admin",
      description: "Full control across modules, users, and configuration.",
    },
    {
      id: ROLES.ADMIN,
      label: "Admin",
      description: "HR administration: users, branches, attendance, leaves, payroll, documents.",
    },
    {
      id: ROLES.ATTENDANCE_MANAGER,
      label: "Attendance Manager",
      description:
        "View and manage attendance, manual entry, edit records, half/full day, kiosk.",
    },
    {
      id: ROLES.LOCATION_MANAGER,
      label: "Branch Manager",
      description:
        "Branches & GPS, create users, edit attendance, geo-fencing context.",
    },
    {
      id: ROLES.USER,
      label: "Staff",
      description: "Self-service attendance and personal history.",
    },
  ];
}

function can(user, permission) {
  if (!user || !user.role) return false;
  const extra = Array.isArray(user.custom_permissions) ? user.custom_permissions : [];
  if (extra.includes("*") || extra.includes(permission)) return true;
  const keys = ROLE_MATRIX[user.role];
  if (!keys) return false;
  if (keys.includes("*")) return true;
  return keys.includes(permission);
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function requirePerm(permission) {
  return (req, res, next) => {
    const user = req.currentUser;
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!can(user, permission)) {
      return res.status(403).json({ error: "Forbidden", permission });
    }
    next();
  };
}

module.exports = {
  ROLES,
  ROLE_MATRIX,
  listRolesMeta,
  can,
  requireAuth,
  requirePerm,
};
