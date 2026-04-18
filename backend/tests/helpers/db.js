// Shared test DB handle — uses the same TURSO_DATABASE_URL as the app
const db = require('../../src/config/db');

async function resetTable(table) {
  await db.execute(`DELETE FROM ${table}`);
}

async function countRows(table) {
  const { rows } = await db.execute(`SELECT COUNT(*) as c FROM ${table}`);
  return Number(rows[0].c);
}

module.exports = { db, resetTable, countRows };
