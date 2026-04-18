# Backend Tests

Integration tests using **Jest + Supertest** against a local SQLite file DB (via `@libsql/client`).

## Running

```bash
npm install          # first time — installs jest + supertest
npm test             # run all tests
npm run test:watch   # watch mode
```

## How it works

- `.env.test` points `TURSO_DATABASE_URL` to a disposable SQLite file at `tests/.tmp/test.db`.
- `jest.config.js` runs `tests/helpers/globalSetup.js` once before all tests — it wipes `tests/.tmp/`, runs every `src/migrations/*.sql`, and seeds the initial users.
- `globalTeardown.js` cleans up the tmp DB after the suite.
- Each test imports the real `app.js` and exercises routes via Supertest.

## Adding tests

Create a file under `tests/` ending in `.test.js`. See `auth.test.js` for the pattern.

For tests that mutate state (create SKUs, POs, etc.), reset the affected tables at the top of each `describe` block:

```js
const { resetTable } = require('./helpers/db');

beforeEach(async () => {
  await resetTable('supplier_pos');
  await resetTable('inventory');
  await resetTable('products');
});
```

## Recommended suites to add (regression coverage)

See the plan file (`plans/royal-mart-roms-resource-cuddly-seal.md`) — test suites TS-3 through TS-10. One `.test.js` per feature area:

- `users.test.js`
- `teams.test.js`
- `skus.test.js`
- `inventory.test.js`
- `supplierPO.test.js`  ← most important for regression (PO lifecycle + inventory math)
- `packaging.test.js`
- `audit.test.js`
