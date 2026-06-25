const request = require('supertest');
const app = require('../app');

describe('Auth — login flow', () => {
  test('POST /api/auth/login — valid seeded admin returns token + user', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'RoyalMart#Admin' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('accessToken');
    expect(res.body.user).toMatchObject({
      username: 'admin',
      roles: expect.arrayContaining(['Admin']),
    });
    expect(res.body.user.is_first_login).toBeTruthy();
  });

  test('POST /api/auth/login — wrong password returns 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'wrong-password' });

    expect(res.status).toBe(401);
  });

  test('POST /api/auth/login — unknown user ID returns 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nobody', password: 'whatever' });

    expect(res.status).toBe(401);
  });

  test('GET /api/health returns ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
