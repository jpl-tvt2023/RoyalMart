const bcrypt = require('bcryptjs');

async function seed(db) {
  const users = [
    { name: 'System Admin',      email: 'admin@royalmart.in',   password: 'RoyalMart#Admin', roles: ['Admin'] },
    { name: 'Keshav Lohia',      email: 'Keshav@royalmart.in',  password: 'RoyalMart#Owner', roles: ['Owner'] },
    { name: 'Royal Mart Owner',  email: 'owner@royalmart.in',   password: 'RoyalMart#Owner', roles: ['Owner'] },
  ];

  for (const u of users) {
    const hash = await bcrypt.hash(u.password, 10);
    await db.execute({
      sql: `INSERT INTO users (name, email, password_hash, is_first_login)
            VALUES (?, ?, ?, 1)
            ON CONFLICT (email) DO UPDATE SET
              name           = excluded.name,
              password_hash  = excluded.password_hash,
              is_first_login = 1`,
      args: [u.name, u.email, hash],
    });
    const { rows } = await db.execute({
      sql: 'SELECT id FROM users WHERE email = ?',
      args: [u.email],
    });
    const userId = rows[0].id;
    await db.execute({ sql: 'DELETE FROM user_roles WHERE user_id = ?', args: [userId] });
    for (const role of u.roles) {
      await db.execute({
        sql: 'INSERT INTO user_roles (user_id, role) VALUES (?, ?)',
        args: [userId, role],
      });
    }
    console.log(`  seeded user: ${u.email} (${u.roles.join(',')}) — password reset, is_first_login=1`);
  }
}

module.exports = seed;
