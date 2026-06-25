const bcrypt = require('bcryptjs');

async function seed(db) {
  // Login is by `username`. `email` is retained as a vestigial NOT NULL UNIQUE column
  // (no longer used for login); seed it from the username so the constraint is satisfied.
  const users = [
    { name: 'System Admin',     username: 'admin',  password: 'RoyalMart#Admin', roles: ['Admin'] },
    { name: 'Keshav Lohia',     username: 'keshav', password: 'RoyalMart#Owner', roles: ['Owner'] },
    { name: 'Royal Mart Owner', username: 'owner',  password: 'RoyalMart#Owner', roles: ['Owner'] },
  ];

  for (const u of users) {
    const hash = await bcrypt.hash(u.password, 10);
    const email = `${u.username}@local`;
    await db.execute({
      sql: `INSERT INTO users (name, username, email, password_hash, is_first_login)
            VALUES (?, ?, ?, ?, 1)
            ON CONFLICT (username) DO UPDATE SET
              name           = excluded.name,
              password_hash  = excluded.password_hash,
              is_first_login = 1`,
      args: [u.name, u.username, email, hash],
    });
    const { rows } = await db.execute({
      sql: 'SELECT id FROM users WHERE username = ?',
      args: [u.username],
    });
    const userId = rows[0].id;
    await db.execute({ sql: 'DELETE FROM user_roles WHERE user_id = ?', args: [userId] });
    for (const role of u.roles) {
      await db.execute({
        sql: 'INSERT INTO user_roles (user_id, role) VALUES (?, ?)',
        args: [userId, role],
      });
    }
    console.log(`  seeded user: ${u.username} (${u.roles.join(',')}) — password reset, is_first_login=1`);
  }
}

module.exports = seed;
