require('../config/env');
const pool = require('../config/db');
const seed01 = require('./01_users.seed');
const seed02 = require('./02_products.seed');

async function run() {
  try {
    console.log('Running seeds...');
    await seed01(pool);
    await seed02(pool);
    console.log('Seeds complete.');
  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
