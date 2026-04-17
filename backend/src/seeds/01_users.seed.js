const bcrypt = require('bcryptjs');

async function seed(pool) {
  const users = [
    { name: 'System Admin', email: 'admin@royalmart.in', password: 'RoyalMart#Admin', role: 'Admin' },
    { name: 'Keshav Lohia', email: 'Keshav@royalmart.in', password: 'RoyalMart#Owner', role: 'Owner' },
  ];

  for (const u of users) {
    const hash = await bcrypt.hash(u.password, 10);
    await pool.query(
      `INSERT INTO users (name, email, password_hash, role, is_first_login)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (email) DO NOTHING`,
      [u.name, u.email, hash, u.role]
    );
    console.log(`  seeded user: ${u.email} (${u.role})`);
  }
}

module.exports = seed;
