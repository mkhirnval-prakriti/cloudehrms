/**
 * pgBackup.js — No-op for PostgreSQL deployments.
 * With Neon/Supabase, the database is already cloud-persistent.
 * No blob backup needed — the PostgreSQL service handles durability.
 */

async function saveToPostgres() { return true; }
async function loadFromPostgres() { return false; }

module.exports = { saveToPostgres, loadFromPostgres };
