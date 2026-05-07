/**
 * restorePg.js — No-op for PostgreSQL deployments.
 * PostgreSQL is the primary database; no restore chain needed.
 */
console.log("[restore] PostgreSQL mode — no restore needed.");
process.exit(0);
