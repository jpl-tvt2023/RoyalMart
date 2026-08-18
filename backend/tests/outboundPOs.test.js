const request = require('supertest');
const app = require('../app');
const { db, resetTable } = require('./helpers/db');

let token;
let adminUserId;
let activeCompanyId;
let inactiveCompanyId;
let warehousePocId;
let uidCounter = 0;
const uid = () => `${Date.now()}-${uidCounter++}`;

const DEFAULT_ARTICLES = [{ category: 'Raw Material', item_name: 'Caps' }];

function createVendor(articles = DEFAULT_ARTICLES, overrides = {}) {
  return request(app)
    .post('/api/outbound-vendors')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: overrides.name || `Vendor ${uid()}`, articles });
}

function deactivateVendor(id) {
  return request(app).delete(`/api/outbound-vendors/${id}`).set('Authorization', `Bearer ${token}`);
}

// Turns a vendor's article record ({category, item_name, variant}) into a
// valid PO line payload, overridable per test. Received/short are no longer
// part of this payload — Short is edited via PATCH .../lines/:lineId, and
// Received is a computed sum of receipts (POST .../lines/:lineId/receipts).
function lineFor(article, overrides = {}) {
  return {
    category: article.category,
    item_name: article.item_name,
    variant: article.variant || null,
    qty: 1,
    rate: 10,
    ...overrides,
  };
}

// Billed Rate and Checked By are mandatory on every receipt, so default both in
// unless a test is specifically exercising their validation.
function receiptBody(overrides = {}) {
  return { received_qty: 1, received_rate: 10, checked_by: warehousePocId, ...overrides };
}

function postReceipt(poId, lineId, body) {
  return request(app)
    .post(`/api/outbound-pos/${poId}/lines/${lineId}/receipts`)
    .set('Authorization', `Bearer ${token}`)
    .send(receiptBody(body));
}

function createPO(body) {
  return request(app).post('/api/outbound-pos').set('Authorization', `Bearer ${token}`).send(body);
}

function patchPO(id, body) {
  return request(app).patch(`/api/outbound-pos/${id}`).set('Authorization', `Bearer ${token}`).send(body);
}

function auditFor(entityType, entityId) {
  return request(app)
    .get('/api/audit-logs')
    .query({ entity_type: entityType, entity_id: entityId })
    .set('Authorization', `Bearer ${token}`);
}

// Convenience: create a vendor with one mapping, then a PO with one line
// against it. Returns { vendor, po, article }. Approval Date is mandatory
// alongside Approved By, so default one in whenever a test sets approved_by
// without also specifying approval_date.
async function createVendorAndPO(poOverrides = {}) {
  const vendor = await createVendor();
  const article = vendor.body.articles[0];
  const body = {
    vendor_id: vendor.body.id,
    lines: [lineFor(article)],
    ...poOverrides,
  };
  if (body.approved_by && !body.approval_date) body.approval_date = '2026-01-01';
  const po = await createPO(body);
  return { vendor, po, article };
}

// Fetch a PO and return its (active) line ids in line_no order.
async function lineIdsOf(poId) {
  const res = await request(app).get(`/api/outbound-pos/${poId}`).set('Authorization', `Bearer ${token}`);
  return res.body.lines.map(l => l.id);
}

beforeAll(async () => {
  const login = await request(app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'RoyalMart#Admin' });
  token = login.body.accessToken;
  adminUserId = login.body.user.id;

  // checked_by must be a user actually TAGGED Warehouse_POC — userHasRole is
  // strict, so being Admin is not enough. Tag the seeded admin rather than
  // minting a user, to avoid coupling these tests to the users table schema.
  await db.execute({
    sql: "INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, 'Warehouse_POC')",
    args: [adminUserId],
  });
  warehousePocId = adminUserId;

  const active = await request(app)
    .post('/api/configurations/companies')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: `Active Co ${uid()}` });
  activeCompanyId = active.body.id;

  const inactive = await request(app)
    .post('/api/configurations/companies')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: `Inactive Co ${uid()}` });
  inactiveCompanyId = inactive.body.id;
  await request(app)
    .delete(`/api/configurations/companies/${inactiveCompanyId}`)
    .set('Authorization', `Bearer ${token}`);
});

// Same FK-ordered reset as outboundVendors.test.js — outbound_pos must be
// cleared before outbound_vendors (no ON DELETE CASCADE on outbound_pos.vendor_id),
// and this exact order is kept identical across both test files regardless of
// which one Jest runs first within the same suite run. companies is
// intentionally never reset here: nothing in this file mutates the two
// fixture companies created above, so they don't need per-test isolation.
beforeEach(async () => {
  await resetTable('outbound_pos');
  await resetTable('outbound_po_lines');
  await resetTable('outbound_vendors');
  await resetTable('outbound_vendor_articles');
});

describe('Outbound POs API', () => {
  describe('POST /api/outbound-pos — create', () => {
    test('creates a PO with a valid vendor and one valid line', async () => {
      const vendor = await createVendor();
      const res = await createPO({ vendor_id: vendor.body.id, lines: [lineFor(vendor.body.articles[0])] });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: 'Open' });
      expect(res.body.order_no).toMatch(/^\d{3,}$/);
    });

    test('rejects an unknown vendor_id', async () => {
      const res = await createPO({ vendor_id: 999999, lines: [lineFor(DEFAULT_ARTICLES[0])] });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Vendor not found/);
    });

    test('rejects an inactive vendor', async () => {
      const vendor = await createVendor();
      await deactivateVendor(vendor.body.id);
      const res = await createPO({ vendor_id: vendor.body.id, lines: [lineFor(vendor.body.articles[0])] });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/is inactive/);
    });

    test('accepts a valid, active company_id', async () => {
      const vendor = await createVendor();
      const res = await createPO({
        vendor_id: vendor.body.id,
        company_id: activeCompanyId,
        lines: [lineFor(vendor.body.articles[0])],
      });
      expect(res.status).toBe(201);
    });

    test('rejects an unknown company_id', async () => {
      const vendor = await createVendor();
      const res = await createPO({
        vendor_id: vendor.body.id,
        company_id: 999999,
        lines: [lineFor(vendor.body.articles[0])],
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Company not found/);
    });

    test('rejects an inactive company_id', async () => {
      const vendor = await createVendor();
      const res = await createPO({
        vendor_id: vendor.body.id,
        company_id: inactiveCompanyId,
        lines: [lineFor(vendor.body.articles[0])],
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Company is inactive/);
    });

    test('allows an omitted approved_by (optional at creation)', async () => {
      const vendor = await createVendor();
      const res = await createPO({ vendor_id: vendor.body.id, lines: [lineFor(vendor.body.articles[0])] });
      expect(res.status).toBe(201);
      const fetched = await request(app).get(`/api/outbound-pos/${res.body.id}`).set('Authorization', `Bearer ${token}`);
      expect(fetched.body.approved_by).toBeNull();
    });

    test('rejects an approved_by that does not resolve to a real user', async () => {
      const vendor = await createVendor();
      const res = await createPO({
        vendor_id: vendor.body.id,
        approved_by: 999999,
        lines: [lineFor(vendor.body.articles[0])],
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/user not found/);
    });

    test('rejects an empty lines array', async () => {
      const vendor = await createVendor();
      const res = await createPO({ vendor_id: vendor.body.id, lines: [] });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/At least one line item is required/);
    });

    test('rejects a line tuple not in the vendor\'s article mappings', async () => {
      const vendor = await createVendor();
      const res = await createPO({
        vendor_id: vendor.body.id,
        lines: [lineFor({ category: 'Packaging', item_name: 'One Ply' })],
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/is not in the vendor's article mappings/);
    });

    test.each([
      ['qty', 0, /qty must be a number/],
      ['qty', -5, /qty must be a number/],
      ['rate', -1, /rate must be a number/],
    ])('rejects an invalid line field: %s=%p', async (field, value, expectedMessage) => {
      const vendor = await createVendor();
      const res = await createPO({
        vendor_id: vendor.body.id,
        lines: [lineFor(vendor.body.articles[0], { [field]: value })],
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(expectedMessage);
    });

    test('accepts a decimal qty', async () => {
      const vendor = await createVendor();
      const res = await createPO({ vendor_id: vendor.body.id, lines: [lineFor(vendor.body.articles[0], { qty: 2.5 })] });
      expect(res.status).toBe(201);
      const fetched = await request(app).get(`/api/outbound-pos/${res.body.id}`).set('Authorization', `Bearer ${token}`);
      expect(fetched.body.lines[0].qty).toBe(2.5);
    });

    test('ignores a client-supplied status and always derives it server-side', async () => {
      const vendor = await createVendor();
      const res = await createPO({
        vendor_id: vendor.body.id,
        status: 'Closed',
        lines: [lineFor(vendor.body.articles[0])],
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('Open');
    });

    test('received/short in the create payload are ignored — every new line starts unreceived, so status is always Open', async () => {
      const vendor = await createVendor();
      const res = await createPO({
        vendor_id: vendor.body.id,
        lines: [lineFor(vendor.body.articles[0], { qty: 3, received: 2, short: 1 })],
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('Open');
      const fetched = await request(app).get(`/api/outbound-pos/${res.body.id}`).set('Authorization', `Bearer ${token}`);
      expect(fetched.body.lines[0].received).toBe(0);
      expect(fetched.body.lines[0].short).toBe(0);
    });

    describe('Approval Date — mandatory alongside Approved By', () => {
      test('rejects an approver without an approval_date', async () => {
        const vendor = await createVendor();
        const res = await createPO({
          vendor_id: vendor.body.id, approved_by: adminUserId,
          lines: [lineFor(vendor.body.articles[0])],
        });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/Approval Date is required/);
      });

      test('accepts an approver with an approval_date', async () => {
        const vendor = await createVendor();
        const res = await createPO({
          vendor_id: vendor.body.id, approved_by: adminUserId, approval_date: '2026-01-01',
          lines: [lineFor(vendor.body.articles[0])],
        });
        expect(res.status).toBe(201);
      });

      test('no approver means no approval_date is required', async () => {
        const vendor = await createVendor();
        const res = await createPO({ vendor_id: vendor.body.id, lines: [lineFor(vendor.body.articles[0])] });
        expect(res.status).toBe(201);
      });
    });
  });

  describe('GET /api/outbound-pos — list', () => {
    test('default view excludes Deleted POs', async () => {
      const { po: keep } = await createVendorAndPO();
      const { po: deleted } = await createVendorAndPO();
      await request(app).delete(`/api/outbound-pos/${deleted.body.id}`).set('Authorization', `Bearer ${token}`);

      const res = await request(app).get('/api/outbound-pos').set('Authorization', `Bearer ${token}`);
      const ids = res.body.rows.map(r => r.id);
      expect(ids).toContain(keep.body.id);
      expect(ids).not.toContain(deleted.body.id);
    });

    test('status=Deleted returns only Deleted POs', async () => {
      const { po: kept } = await createVendorAndPO();
      const { po: deleted } = await createVendorAndPO();
      await request(app).delete(`/api/outbound-pos/${deleted.body.id}`).set('Authorization', `Bearer ${token}`);

      const res = await request(app).get('/api/outbound-pos').query({ status: 'Deleted' }).set('Authorization', `Bearer ${token}`);
      const ids = res.body.rows.map(r => r.id);
      expect(ids).toContain(deleted.body.id);
      expect(ids).not.toContain(kept.body.id);
    });

    test('order_no filter strips leading zeros and matches by id', async () => {
      const { po } = await createVendorAndPO();
      const res = await request(app)
        .get('/api/outbound-pos')
        .query({ order_no: `0${po.body.order_no}` }) // extra leading zero on top of the padded order_no
        .set('Authorization', `Bearer ${token}`);
      expect(res.body.rows.map(r => r.id)).toEqual([po.body.id]);
    });

    test('a non-numeric order_no returns zero rows, not a 400', async () => {
      await createVendorAndPO();
      const res = await request(app).get('/api/outbound-pos').query({ order_no: 'abc' }).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.rows).toHaveLength(0);
    });

    test('vendor_id filter narrows to that vendor\'s POs', async () => {
      const { vendor: v1, po: po1 } = await createVendorAndPO();
      await createVendorAndPO();
      const res = await request(app).get('/api/outbound-pos').query({ vendor_id: v1.body.id }).set('Authorization', `Bearer ${token}`);
      expect(res.body.rows.map(r => r.id)).toEqual([po1.body.id]);
    });

    test('an invalid page_size falls back to 25', async () => {
      await createVendorAndPO();
      const res = await request(app).get('/api/outbound-pos').query({ page: 1, page_size: 999 }).set('Authorization', `Bearer ${token}`);
      expect(res.body.page_size).toBe(25);
    });

    test('omitting page and page_size returns everything unpaginated', async () => {
      await createVendorAndPO();
      await createVendorAndPO();
      const res = await request(app).get('/api/outbound-pos').set('Authorization', `Bearer ${token}`);
      expect(res.body.rows.length).toBe(res.body.total);
      expect(res.body.total).toBeGreaterThanOrEqual(2);
    });
  });

  // Builds a vendor with the given articles + one PO covering all of them,
  // bypassing createVendorAndPO (which always seeds a single 'Caps' article).
  async function createPOWithItems(items) {
    const vendor = await createVendor(items);
    const po = await createPO({
      vendor_id: vendor.body.id,
      lines: vendor.body.articles.map(a => lineFor(a)),
    });
    expect(po.status).toBe(201);
    return { vendor, po };
  }

  describe('GET /api/outbound-pos — item_name filter and item-name-counts', () => {
    test('item_name filter narrows to POs with a matching line', async () => {
      const { po: capsPO } = await createPOWithItems([{ category: 'Raw Material', item_name: 'Caps' }]);
      await createPOWithItems([{ category: 'Raw Material', item_name: 'Handkerchief' }]);

      const res = await request(app).get('/api/outbound-pos').query({ item_name: 'Caps' }).set('Authorization', `Bearer ${token}`);
      const ids = res.body.rows.map(r => r.id);
      expect(ids).toContain(capsPO.body.id);
      expect(ids.length).toBe(res.body.total);
    });

    test('filters POs, not lines — a matching PO still returns all its lines', async () => {
      const vendor = await createVendor([
        { category: 'Raw Material', item_name: 'Caps' },
        { category: 'Raw Material', item_name: 'Handkerchief' },
      ]);
      const po = await createPO({
        vendor_id: vendor.body.id,
        lines: [lineFor(vendor.body.articles[0]), lineFor(vendor.body.articles[1])],
      });
      expect(po.status).toBe(201);

      const res = await request(app).get('/api/outbound-pos').query({ item_name: 'Caps' }).set('Authorization', `Bearer ${token}`);
      const row = res.body.rows.find(r => r.id === po.body.id);
      expect(row).toBeDefined();
      expect(row.lines.map(l => l.item_name).sort()).toEqual(['Caps', 'Handkerchief']);
    });

    test('item-name-counts: per-item counts and the All total', async () => {
      const before = await request(app).get('/api/outbound-pos').set('Authorization', `Bearer ${token}`);
      const totalBefore = before.body.total;

      await createPOWithItems([{ category: 'Raw Material', item_name: 'Socks' }]);

      const counts = await request(app).get('/api/outbound-pos/item-name-counts').set('Authorization', `Bearer ${token}`);
      expect(counts.status).toBe(200);
      expect(counts.body.counts.Socks).toBeGreaterThanOrEqual(1);
      expect(counts.body.counts.All).toBe(totalBefore + 1);
    });

    test('item-name-counts respects other active filters', async () => {
      const { po } = await createPOWithItems([{ category: 'Raw Material', item_name: 'Bandana' }]);
      await request(app).delete(`/api/outbound-pos/${po.body.id}`).set('Authorization', `Bearer ${token}`);

      const counts = await request(app).get('/api/outbound-pos/item-name-counts').query({ status: 'Deleted' }).set('Authorization', `Bearer ${token}`);
      expect(counts.status).toBe(200);
      expect(counts.body.counts.Bandana).toBeGreaterThanOrEqual(1);

      const activeCounts = await request(app).get('/api/outbound-pos/item-name-counts').set('Authorization', `Bearer ${token}`);
      // The just-deleted PO's item shouldn't inflate the default (non-deleted) view.
      const deletedContribution = activeCounts.body.counts.Bandana || 0;
      expect(deletedContribution).toBeLessThan(counts.body.counts.Bandana);
    });
  });

  describe('GET /api/outbound-pos/:id — getOne', () => {
    test('returns the full PO with order_no and lines', async () => {
      const { po } = await createVendorAndPO();
      const res = await request(app).get(`/api/outbound-pos/${po.body.id}`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.order_no).toBe(po.body.order_no);
      expect(res.body.lines).toHaveLength(1);
    });

    test('404 for an unknown id', async () => {
      const res = await request(app).get('/api/outbound-pos/999999').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/outbound-pos/:id — update', () => {
    test('404 for an unknown id', async () => {
      const res = await patchPO(999999, { po_date: '2026-01-01' });
      expect(res.status).toBe(404);
    });

    test('mandatory-approver gate: an edit that omits approved_by 400s while it is still unset', async () => {
      const { po } = await createVendorAndPO(); // no approved_by set
      const blocked = await patchPO(po.body.id, { po_date: '2026-01-05' });
      expect(blocked.status).toBe(400);
      expect(blocked.body.message).toMatch(/Approved By is required/);

      const approved = await patchPO(po.body.id, { po_date: '2026-01-05', approved_by: adminUserId, approval_date: '2026-01-05' });
      expect(approved.status).toBe(200);
      expect(approved.body.po_date).toBe('2026-01-05');
    });

    test('once approved, a later edit that omits approved_by from the body still succeeds', async () => {
      const { po } = await createVendorAndPO({ approved_by: adminUserId });
      const res = await patchPO(po.body.id, { po_date: '2026-02-02' });
      expect(res.status).toBe(200);
      expect(res.body.approved_by).toBe(adminUserId);
    });

    test('explicitly clearing approved_by on an already-approved PO is rejected', async () => {
      const { po } = await createVendorAndPO({ approved_by: adminUserId });
      const res = await patchPO(po.body.id, { approved_by: '' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Approved By is required/);
    });

    test('received/short in a lines-replace payload are ignored — status stays derived from actual receipts/short', async () => {
      const { po, article } = await createVendorAndPO({ approved_by: adminUserId });
      const res = await patchPO(po.body.id, {
        lines: [lineFor(article, { qty: 2, received: 2 })],
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('Open'); // received:2 in the payload is not read; nothing has actually been received
    });

    test('ignores a client-supplied status on update the same way create does', async () => {
      const { po } = await createVendorAndPO({ approved_by: adminUserId });
      const res = await patchPO(po.body.id, { status: 'Closed' });
      expect(res.status).toBe(200);
      // status is always recomputed from the PO's actual lines (never taken
      // from the client) — here it recomputes to the same value since nothing
      // about the underlying lines changed.
      expect(res.body.status).toBe('Open');
    });

    describe('Approval Date — mandatory alongside Approved By on change', () => {
      test('rejects setting the approver for the first time without approval_date', async () => {
        const { po } = await createVendorAndPO();
        const res = await patchPO(po.body.id, { approved_by: adminUserId });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/Approval Date is required/);
      });

      test('accepts setting the approver with approval_date', async () => {
        const { po } = await createVendorAndPO();
        const res = await patchPO(po.body.id, { approved_by: adminUserId, approval_date: '2026-02-02' });
        expect(res.status).toBe(200);
        expect(res.body.approval_date).toBe('2026-02-02');
      });

      test('leaves approval_date untouched when the approver is not changed', async () => {
        const { po } = await createVendorAndPO({ approved_by: adminUserId }); // defaults approval_date to 2026-01-01
        const res = await patchPO(po.body.id, { po_date: '2026-05-05' });
        expect(res.status).toBe(200);
        expect(res.body.approval_date).toBe('2026-01-01');
      });
    });

    describe('Line identity across edits — lines are upserted by id, not wiped and recreated', () => {
      test('resubmitting a line with its id updates in place; omitting a previously-existing line soft-deletes it', async () => {
        const vendor = await createVendor([
          { category: 'Raw Material', item_name: 'Caps' },
          { category: 'Packaging', item_name: 'Corrugated' },
        ]);
        const [articleA, articleB] = vendor.body.articles;
        const created = await createPO({
          vendor_id: vendor.body.id, approved_by: adminUserId, approval_date: '2026-01-01',
          lines: [lineFor(articleA), lineFor(articleB)],
        });
        const before = await request(app).get(`/api/outbound-pos/${created.body.id}`).set('Authorization', `Bearer ${token}`);
        const [lineA, lineB] = before.body.lines;

        const updated = await patchPO(created.body.id, {
          lines: [{ id: lineA.id, line_no: 1, category: lineA.category, item_name: lineA.item_name, variant: lineA.variant, qty: 9, rate: lineA.rate }],
        });
        expect(updated.status).toBe(200);
        expect(updated.body.lines).toHaveLength(1);
        expect(updated.body.lines[0]).toMatchObject({ id: lineA.id, qty: 9 });

        const withDeleted = await request(app)
          .get(`/api/outbound-pos/${created.body.id}`).query({ include_deleted: 1 }).set('Authorization', `Bearer ${token}`);
        const droppedLine = withDeleted.body.lines.find(l => l.id === lineB.id);
        expect(droppedLine).toBeTruthy();
        expect(droppedLine.deleted_at).toBeTruthy();
      });
    });

    test('a company_id in the body is validated for existence but NOT for is_active (looser than create)', async () => {
      // Documents an asymmetry found while reading the controller: create()
      // checks both existence and is_active for company_id, update() only
      // checks existence. This locks in current behavior rather than assuming
      // it — flag to the team if this asymmetry isn't intentional.
      const { po } = await createVendorAndPO({ approved_by: adminUserId });
      const res = await patchPO(po.body.id, { company_id: inactiveCompanyId });
      expect(res.status).toBe(200);
      expect(res.body.company_id).toBe(inactiveCompanyId);
    });

    test('vendor_id in the body is silently ignored (server-side vendor lock)', async () => {
      const { po, vendor: originalVendor } = await createVendorAndPO({ approved_by: adminUserId });
      const otherVendor = await createVendor();
      const res = await patchPO(po.body.id, { vendor_id: otherVendor.body.id });
      expect(res.status).toBe(200);
      expect(res.body.vendor_id).toBe(originalVendor.body.id);
    });

    test('blocked entirely once status is Deleted', async () => {
      const { po } = await createVendorAndPO({ approved_by: adminUserId });
      await request(app).delete(`/api/outbound-pos/${po.body.id}`).set('Authorization', `Bearer ${token}`);
      const res = await patchPO(po.body.id, { po_date: '2026-03-03' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/PO is deleted; restore it first/);
    });
  });

  describe('Update grandfathering (regression) — protects existing lines from vendor config edits', () => {
    test('a pre-existing line survives its mapping being removed from the vendor, but a new tuple is still rejected', async () => {
      const vendor = await createVendor([{ category: 'Raw Material', item_name: 'Caps' }]);
      const articleA = vendor.body.articles[0];
      const po = await createPO({
        vendor_id: vendor.body.id,
        approved_by: adminUserId,
        approval_date: '2026-01-01',
        lines: [lineFor(articleA)],
      });
      expect(po.status).toBe(201);

      // Replace the vendor's articles so mapping A no longer exists.
      const vendorUpdate = await request(app)
        .patch(`/api/outbound-vendors/${vendor.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ articles: [{ category: 'Packaging', item_name: 'Corrugated' }] });
      expect(vendorUpdate.status).toBe(200);

      // Resubmitting the PO's existing line A unchanged must still succeed.
      const resubmit = await patchPO(po.body.id, { lines: [lineFor(articleA)] });
      expect(resubmit.status).toBe(200);
      expect(resubmit.body.lines[0]).toMatchObject({ category: 'Raw Material', item_name: 'Caps' });

      // Adding a brand-new tuple that was never mapped for this vendor is still rejected.
      const addNew = await patchPO(po.body.id, {
        lines: [lineFor(articleA), lineFor({ category: 'Others', item_name: 'Never Mapped' })],
      });
      expect(addNew.status).toBe(400);
      expect(addNew.body.message).toMatch(/is not in the vendor's article mappings/);
    });
  });

  describe('DELETE /api/outbound-pos/:id — soft delete', () => {
    test('404 for an unknown id', async () => {
      const res = await request(app).delete('/api/outbound-pos/999999').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    });

    test('soft-deletes: status becomes Deleted, row still fetchable', async () => {
      const { po } = await createVendorAndPO();
      const res = await request(app).delete(`/api/outbound-pos/${po.body.id}`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('Deleted');
      const fetched = await request(app).get(`/api/outbound-pos/${po.body.id}`).set('Authorization', `Bearer ${token}`);
      expect(fetched.status).toBe(200);
      expect(fetched.body.status).toBe('Deleted');
    });

    test('deleting an already-deleted PO is rejected', async () => {
      const { po } = await createVendorAndPO();
      await request(app).delete(`/api/outbound-pos/${po.body.id}`).set('Authorization', `Bearer ${token}`);
      const res = await request(app).delete(`/api/outbound-pos/${po.body.id}`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/PO is already deleted/);
    });
  });

  describe('POST /api/outbound-pos/:id/restore', () => {
    test('404 for an unknown id', async () => {
      const res = await request(app).post('/api/outbound-pos/999999/restore').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    });

    test('rejects restoring a PO that is not deleted', async () => {
      const { po } = await createVendorAndPO();
      const res = await request(app).post(`/api/outbound-pos/${po.body.id}/restore`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/PO is not deleted/);
    });

    test('restoring a fully-received PO re-derives Closed, not a blind reset to Open', async () => {
      const vendor = await createVendor();
      const closedPo = await createPO({
        vendor_id: vendor.body.id,
        lines: [lineFor(vendor.body.articles[0], { qty: 2 })],
      });
      const [lineId] = await lineIdsOf(closedPo.body.id);
      await postReceipt(closedPo.body.id, lineId, { received_qty: 2 });
      const midway = await request(app).get(`/api/outbound-pos/${closedPo.body.id}`).set('Authorization', `Bearer ${token}`);
      expect(midway.body.status).toBe('Closed');
      await request(app).delete(`/api/outbound-pos/${closedPo.body.id}`).set('Authorization', `Bearer ${token}`);

      const res = await request(app).post(`/api/outbound-pos/${closedPo.body.id}/restore`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('Closed');
    });

    test('restoring a PO whose lines are all untouched re-derives Open', async () => {
      const { po } = await createVendorAndPO();
      await request(app).delete(`/api/outbound-pos/${po.body.id}`).set('Authorization', `Bearer ${token}`);
      const res = await request(app).post(`/api/outbound-pos/${po.body.id}/restore`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('Open');
    });
  });

  describe('PATCH /api/outbound-pos/:id/lines/:lineId — update Short', () => {
    test('updates short and recomputes the PO header status', async () => {
      const vendor = await createVendor();
      const created = await createPO({ vendor_id: vendor.body.id, lines: [lineFor(vendor.body.articles[0], { qty: 2 })] });
      const [lineId] = await lineIdsOf(created.body.id);

      const res = await request(app)
        .patch(`/api/outbound-pos/${created.body.id}/lines/${lineId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ short: 2 });
      expect(res.status).toBe(200);
      expect(res.body.line.short).toBe(2);

      const after = await request(app).get(`/api/outbound-pos/${created.body.id}`).set('Authorization', `Bearer ${token}`);
      expect(after.body.status).toBe('Closed');
    });

    test('rejects a negative short', async () => {
      const vendor = await createVendor();
      const created = await createPO({ vendor_id: vendor.body.id, lines: [lineFor(vendor.body.articles[0])] });
      const [lineId] = await lineIdsOf(created.body.id);
      const res = await request(app)
        .patch(`/api/outbound-pos/${created.body.id}/lines/${lineId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ short: -1 });
      expect(res.status).toBe(400);
    });

    test('404 for a line that does not belong to this PO', async () => {
      const v1 = await createVendor();
      const p1 = await createPO({ vendor_id: v1.body.id, lines: [lineFor(v1.body.articles[0])] });
      const v2 = await createVendor();
      const p2 = await createPO({ vendor_id: v2.body.id, lines: [lineFor(v2.body.articles[0])] });
      const [otherLineId] = await lineIdsOf(p2.body.id);

      const res = await request(app)
        .patch(`/api/outbound-pos/${p1.body.id}/lines/${otherLineId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ short: 1 });
      expect(res.status).toBe(404);
    });
  });

  describe('Receipts — multi-bill receiving per line', () => {
    async function setupLine(qty = 5) {
      const vendor = await createVendor();
      const created = await createPO({ vendor_id: vendor.body.id, lines: [lineFor(vendor.body.articles[0], { qty })] });
      const [lineId] = await lineIdsOf(created.body.id);
      return { poId: created.body.id, lineId };
    }

    test('adding two receipts sums into the line\'s received total and can close the line', async () => {
      const { poId, lineId } = await setupLine(5);
      await postReceipt(poId, lineId, { received_qty: 2, received_rate: 60, bill_no: 'B-1' });
      await postReceipt(poId, lineId, { received_qty: 3, received_rate: 65, bill_no: 'B-2' });
      const fetched = await request(app).get(`/api/outbound-pos/${poId}`).set('Authorization', `Bearer ${token}`);
      expect(fetched.body.lines[0].received).toBe(5);
      expect(fetched.body.status).toBe('Closed');
    });

    test('rejects a received_qty <= 0', async () => {
      const { poId, lineId } = await setupLine();
      const res = await postReceipt(poId, lineId, { received_qty: 0 });
      expect(res.status).toBe(400);
    });

    test('updating a receipt recomputes the line total', async () => {
      const { poId, lineId } = await setupLine(5);
      const created = await postReceipt(poId, lineId, { received_qty: 2 });
      await request(app).patch(`/api/outbound-pos/${poId}/lines/${lineId}/receipts/${created.body.id}`).set('Authorization', `Bearer ${token}`).send({ received_qty: 4 });
      const fetched = await request(app).get(`/api/outbound-pos/${poId}`).set('Authorization', `Bearer ${token}`);
      expect(fetched.body.lines[0].received).toBe(4);
    });

    test('deleting a receipt excludes it from the sum; restoring brings it back', async () => {
      const { poId, lineId } = await setupLine(5);
      const created = await postReceipt(poId, lineId, { received_qty: 3 });

      let fetched = await request(app).get(`/api/outbound-pos/${poId}`).set('Authorization', `Bearer ${token}`);
      expect(fetched.body.lines[0].received).toBe(3);

      const del = await request(app).delete(`/api/outbound-pos/${poId}/lines/${lineId}/receipts/${created.body.id}`).set('Authorization', `Bearer ${token}`);
      expect(del.status).toBe(200);
      fetched = await request(app).get(`/api/outbound-pos/${poId}`).set('Authorization', `Bearer ${token}`);
      expect(fetched.body.lines[0].received).toBe(0);

      const restore = await request(app).post(`/api/outbound-pos/${poId}/lines/${lineId}/receipts/${created.body.id}/restore`).set('Authorization', `Bearer ${token}`);
      expect(restore.status).toBe(200);
      fetched = await request(app).get(`/api/outbound-pos/${poId}`).set('Authorization', `Bearer ${token}`);
      expect(fetched.body.lines[0].received).toBe(3);
    });

    test('line and receipt actions are all logged under entityType outbound_po_line for one unified history', async () => {
      const { poId, lineId } = await setupLine(5);
      await postReceipt(poId, lineId, { received_qty: 2, bill_no: 'B-99' });
      await request(app).patch(`/api/outbound-pos/${poId}/lines/${lineId}`).set('Authorization', `Bearer ${token}`).send({ short: 1 });
      const res = await auditFor('outbound_po_line', lineId);
      const types = res.body.map(e => e.action_type);
      expect(types).toContain('OUTBOUND_PO_LINE_CREATE');
      expect(types).toContain('OUTBOUND_PO_LINE_RECEIPT_CREATE');
      expect(types).toContain('OUTBOUND_PO_LINE_SHORT_UPDATE');
    });

    test('a status transition triggered by a receipt is also logged on the PO\'s own audit trail', async () => {
      const { poId, lineId } = await setupLine(2);
      await postReceipt(poId, lineId, { received_qty: 2 });
      const res = await auditFor('outbound_po', poId);
      const entry = res.body.find(e => e.action_type === 'OUTBOUND_PO_STATUS_UPDATE');
      expect(entry).toBeTruthy();
      expect(entry.changes.find(c => c.field === 'status')).toMatchObject({ old: 'Open', new: 'Closed' });
    });
  });

  describe('Receipt field validation', () => {
    async function setupLine(qty = 5) {
      const vendor = await createVendor();
      const created = await createPO({ vendor_id: vendor.body.id, lines: [lineFor(vendor.body.articles[0], { qty })] });
      const [lineId] = await lineIdsOf(created.body.id);
      return { poId: created.body.id, lineId };
    }
    const rawPost = (poId, lineId, body) => request(app)
      .post(`/api/outbound-pos/${poId}/lines/${lineId}/receipts`)
      .set('Authorization', `Bearer ${token}`).send(body);

    test.each([
      ['omitted', {}],
      ['empty string', { received_rate: '' }],
      ['null', { received_rate: null }],
    ])('rejects a receipt whose billed rate is %s', async (_label, patch) => {
      const { poId, lineId } = await setupLine();
      const res = await rawPost(poId, lineId, { received_qty: 1, checked_by: warehousePocId, ...patch });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Billed Rate is required/);
    });

    test('rejects a negative billed rate', async () => {
      const { poId, lineId } = await setupLine();
      const res = await rawPost(poId, lineId, { received_qty: 1, received_rate: -1, checked_by: warehousePocId });
      expect(res.status).toBe(400);
    });

    test('rejects a receipt with no checked_by', async () => {
      const { poId, lineId } = await setupLine();
      const res = await rawPost(poId, lineId, { received_qty: 1, received_rate: 10 });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Checked By is required/);
    });

    // The highest-value case: Admin/Owner must NOT implicitly qualify. This
    // pins userHasRole (strict) rather than userQualifiesAs.
    test('rejects a checked_by that is a real user without the Warehouse_POC tag', async () => {
      const { poId, lineId } = await setupLine();
      const { rows } = await db.execute({
        sql: `INSERT INTO users (name, username, email, password_hash, is_first_login)
              VALUES (?, ?, ?, 'x', 0) RETURNING id`,
        args: [`Untagged ${uid()}`, `untagged-${uid()}`, `untagged-${uid()}@x.com`],
      });
      const res = await rawPost(poId, lineId, { received_qty: 1, received_rate: 10, checked_by: rows[0].id });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Warehouse_POC/);
    });

    test('rejects a checked_by that resolves to no user', async () => {
      const { poId, lineId } = await setupLine();
      const res = await rawPost(poId, lineId, { received_qty: 1, received_rate: 10, checked_by: 99999 });
      expect(res.status).toBe(400);
    });

    test('accepts a receipt with no incoming_no — it is optional by design', async () => {
      const { poId, lineId } = await setupLine();
      const res = await postReceipt(poId, lineId, { received_qty: 1 });
      expect(res.status).toBe(201);
    });

    test.each([[1.5], ['abc'], [0], [-1]])('rejects incoming_no %p', async (value) => {
      const { poId, lineId } = await setupLine();
      const res = await postReceipt(poId, lineId, { received_qty: 1, incoming_no: value });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Incoming No/);
    });

    test('PATCH cannot clear an existing billed rate', async () => {
      const { poId, lineId } = await setupLine();
      const created = await postReceipt(poId, lineId, { received_qty: 1 });
      const res = await request(app)
        .patch(`/api/outbound-pos/${poId}/lines/${lineId}/receipts/${created.body.id}`)
        .set('Authorization', `Bearer ${token}`).send({ received_rate: null });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Billed Rate is required/);
    });

    test('PATCH that touches only bill_no does not force the other fields', async () => {
      const { poId, lineId } = await setupLine();
      const created = await postReceipt(poId, lineId, { received_qty: 1 });
      const res = await request(app)
        .patch(`/api/outbound-pos/${poId}/lines/${lineId}/receipts/${created.body.id}`)
        .set('Authorization', `Bearer ${token}`).send({ bill_no: 'B-EDIT' });
      expect(res.status).toBe(200);
    });
  });

  describe('Closed-line receipt gate', () => {
    async function setupLine(qty = 5) {
      const vendor = await createVendor();
      const created = await createPO({ vendor_id: vendor.body.id, lines: [lineFor(vendor.body.articles[0], { qty })] });
      const [lineId] = await lineIdsOf(created.body.id);
      return { poId: created.body.id, lineId };
    }

    test('a line closed by receipts refuses a further receipt', async () => {
      const { poId, lineId } = await setupLine(5);
      expect((await postReceipt(poId, lineId, { received_qty: 5 })).status).toBe(201);
      const res = await postReceipt(poId, lineId, { received_qty: 1 });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/already Closed/);
    });

    test('a line closed purely by short refuses a receipt', async () => {
      const { poId, lineId } = await setupLine(5);
      await request(app).patch(`/api/outbound-pos/${poId}/lines/${lineId}`)
        .set('Authorization', `Bearer ${token}`).send({ short: 5 });
      const res = await postReceipt(poId, lineId, { received_qty: 1 });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/already Closed/);
    });

    test('a partially received line still accepts more receipts', async () => {
      const { poId, lineId } = await setupLine(5);
      expect((await postReceipt(poId, lineId, { received_qty: 2 })).status).toBe(201);
      expect((await postReceipt(poId, lineId, { received_qty: 2 })).status).toBe(201);
    });
  });

  describe('Exception flags', () => {
    // `approved` matters since not_approved became a flag: a PO created without
    // an approver is never "clean", so any test about clean POs must opt in.
    async function setupLine({ qty = 5, rate = 10, approved = false } = {}) {
      const vendor = await createVendor();
      const body = { vendor_id: vendor.body.id, lines: [lineFor(vendor.body.articles[0], { qty, rate })] };
      if (approved) { body.approved_by = adminUserId; body.approval_date = '2026-01-01'; }
      const created = await createPO(body);
      const [lineId] = await lineIdsOf(created.body.id);
      return { poId: created.body.id, lineId };
    }
    const getPO = (poId) => request(app).get(`/api/outbound-pos/${poId}`).set('Authorization', `Bearer ${token}`);
    const listPOs = (query) => request(app).get('/api/outbound-pos').query(query).set('Authorization', `Bearer ${token}`);

    test('a billed rate differing from the agreed rate flags the line and the PO', async () => {
      const { poId, lineId } = await setupLine({ rate: 10 });
      await postReceipt(poId, lineId, { received_qty: 1, received_rate: 12, incoming_no: 1 });
      const detail = await getPO(poId);
      expect(detail.body.lines[0].flags).toContain('rate_mismatch');
      const list = await listPOs({ order_no: String(poId) });
      expect(list.body.rows[0].flags).toContain('rate_mismatch');
    });

    test('a matching billed rate raises no flag', async () => {
      const { poId, lineId } = await setupLine({ rate: 10 });
      await postReceipt(poId, lineId, { received_qty: 1, received_rate: 10, incoming_no: 1 });
      const detail = await getPO(poId);
      expect(detail.body.lines[0].flags).toEqual([]);
    });

    // Pins "only meaningful when the agreed rate is present" — a blank agreed
    // rate is stored as 0 and must never raise a mismatch.
    test('a blank agreed rate never raises a rate mismatch', async () => {
      const { poId, lineId } = await setupLine({ rate: 0 });
      await postReceipt(poId, lineId, { received_qty: 1, received_rate: 12, incoming_no: 1 });
      const detail = await getPO(poId);
      expect(detail.body.lines[0].flags).not.toContain('rate_mismatch');
    });

    test('float round-trip noise does not raise a mismatch', async () => {
      const { poId, lineId } = await setupLine({ rate: 10.1 });
      await postReceipt(poId, lineId, { received_qty: 1, received_rate: 10.1, incoming_no: 1 });
      const detail = await getPO(poId);
      expect(detail.body.lines[0].flags).not.toContain('rate_mismatch');
    });

    test('a receipt with no incoming number flags the line and the PO', async () => {
      const { poId, lineId } = await setupLine();
      await postReceipt(poId, lineId, { received_qty: 1 });
      const detail = await getPO(poId);
      expect(detail.body.lines[0].flags).toContain('missing_incoming_no');
      expect(detail.body.lines[0].receipts[0].flags).toContain('missing_incoming_no');
    });

    // The test that would catch a regression from derived to stored flags.
    test('soft-deleting a flagged receipt clears the flag; restoring brings it back', async () => {
      const { poId, lineId } = await setupLine();
      const created = await postReceipt(poId, lineId, { received_qty: 1 });
      expect((await getPO(poId)).body.lines[0].flags).toContain('missing_incoming_no');

      await request(app).delete(`/api/outbound-pos/${poId}/lines/${lineId}/receipts/${created.body.id}`)
        .set('Authorization', `Bearer ${token}`);
      expect((await getPO(poId)).body.lines[0].flags).toEqual([]);

      await request(app).post(`/api/outbound-pos/${poId}/lines/${lineId}/receipts/${created.body.id}/restore`)
        .set('Authorization', `Bearer ${token}`);
      expect((await getPO(poId)).body.lines[0].flags).toContain('missing_incoming_no');
    });

    test('filtering by flag returns only matching POs, and ?flag=none only clean ones', async () => {
      const dirty = await setupLine();
      await postReceipt(dirty.poId, dirty.lineId, { received_qty: 1 }); // no incoming_no
      const clean = await setupLine({ approved: true });
      await postReceipt(clean.poId, clean.lineId, { received_qty: 1, incoming_no: 7 });

      const flagged = await listPOs({ flag: 'missing_incoming_no', page_size: 'all' });
      const flaggedIds = flagged.body.rows.map(r => r.id);
      expect(flaggedIds).toContain(dirty.poId);
      expect(flaggedIds).not.toContain(clean.poId);

      const none = await listPOs({ flag: 'none', page_size: 'all' });
      const noneIds = none.body.rows.map(r => r.id);
      expect(noneIds).toContain(clean.poId);
      expect(noneIds).not.toContain(dirty.poId);
    });

    test('an empty flag filter behaves as no filter at all', async () => {
      const { poId, lineId } = await setupLine();
      await postReceipt(poId, lineId, { received_qty: 1 });
      const res = await listPOs({ flag: '', page_size: 'all' });
      expect(res.body.rows.map(r => r.id)).toContain(poId);
    });

    // Guards the WHERE clause drifting between the page query and the COUNT
    // query, which would make `total` disagree with the rows returned.
    test('paginated total matches the number of rows across pages when filtering by flag', async () => {
      for (let i = 0; i < 3; i++) {
        const s = await setupLine();
        await postReceipt(s.poId, s.lineId, { received_qty: 1 });
      }
      const paged = await listPOs({ flag: 'missing_incoming_no', page: 1, page_size: 10 });
      const all = await listPOs({ flag: 'missing_incoming_no', page_size: 'all' });
      expect(paged.body.total).toBe(all.body.rows.length);
    });

    test('a PO with no approver is flagged Not Approved, one with an approver is not', async () => {
      const unapproved = await setupLine();
      const approved = await setupLine({ approved: true });
      const list = await listPOs({ page_size: 'all' });
      const rowFor = (id) => list.body.rows.find(r => r.id === id);
      expect(rowFor(unapproved.poId).flags).toContain('not_approved');
      expect(rowFor(approved.poId).flags).not.toContain('not_approved');
    });

    // The reason not_approved is NOT wrapped in the receipt EXISTS: a PO with no
    // receipts at all would otherwise never flag, which is the exact case an
    // unapproved PO is most likely to be in.
    test('a PO with no receipts at all is still flagged Not Approved', async () => {
      const { poId } = await setupLine();
      const list = await listPOs({ order_no: String(poId) });
      expect(list.body.rows[0].flags).toEqual(['not_approved']);
    });

    test('Not Approved is PO-scoped — it never appears on a line or a receipt', async () => {
      const { poId, lineId } = await setupLine();
      await postReceipt(poId, lineId, { received_qty: 1, received_rate: 10, incoming_no: 1 });
      const detail = await getPO(poId);
      expect(detail.body.flags).toContain('not_approved');
      expect(detail.body.lines[0].flags).not.toContain('not_approved');
      expect(detail.body.lines[0].receipts[0].flags).not.toContain('not_approved');
    });

    test('?flag=not_approved returns only POs missing an approver', async () => {
      const unapproved = await setupLine();
      const approved = await setupLine({ approved: true });
      const res = await listPOs({ flag: 'not_approved', page_size: 'all' });
      const ids = res.body.rows.map(r => r.id);
      expect(ids).toContain(unapproved.poId);
      expect(ids).not.toContain(approved.poId);
    });
  });

  // The SQL predicates and their JS twins in outboundPOFlags.js are duplicated
  // on purpose; this pins them together so they cannot drift. Only receipt-
  // scoped flags have a JS twin — PO-scoped ones are covered by the
  // 'Exception flags' cases above instead.
  describe('Flag SQL/JS parity', () => {
    const { FLAGS, RECEIPT_FLAG_KEYS } = require('../src/services/outboundPOFlags');

    test('every receipt-scoped flag has a JS predicate, and no PO-scoped flag does', () => {
      const { FLAG_KEYS } = require('../src/services/outboundPOFlags');
      for (const k of FLAG_KEYS) {
        const hasJs = typeof FLAGS[k].js === 'function';
        expect(hasJs).toBe(RECEIPT_FLAG_KEYS.includes(k));
      }
    });

    test.each([
      [{ received_rate: 12, incoming_no: 1 }, { rate: 10 }, ['rate_mismatch']],
      [{ received_rate: 10, incoming_no: 1 }, { rate: 10 }, []],
      [{ received_rate: 12, incoming_no: 1 }, { rate: 0 }, []],
      [{ received_rate: 10, incoming_no: null }, { rate: 10 }, ['missing_incoming_no']],
      [{ received_rate: 12, incoming_no: null }, { rate: 10 }, ['rate_mismatch', 'missing_incoming_no']],
      [{ received_rate: null, incoming_no: 1 }, { rate: 10 }, []],
    ])('receipt %j against line %j yields %j', (receipt, line, expected) => {
      const actual = RECEIPT_FLAG_KEYS.filter(k => FLAGS[k].js(receipt, line));
      expect(actual.sort()).toEqual([...expected].sort());
    });
  });

  describe('Audit logging spot-checks', () => {
    test('create writes an OUTBOUND_PO_CREATE entry', async () => {
      const { po } = await createVendorAndPO();
      const res = await auditFor('outbound_po', po.body.id);
      expect(res.body.some(e => e.action_type === 'OUTBOUND_PO_CREATE')).toBe(true);
    });

    test('update writes an OUTBOUND_PO_UPDATE entry with a non-empty changes diff', async () => {
      const { po } = await createVendorAndPO({ approved_by: adminUserId });
      await patchPO(po.body.id, { po_date: '2026-04-04' });
      const res = await auditFor('outbound_po', po.body.id);
      const entry = res.body.find(e => e.action_type === 'OUTBOUND_PO_UPDATE');
      expect(entry).toBeTruthy();
      expect(entry.changes.length).toBeGreaterThan(0);
    });

    test('delete writes an OUTBOUND_PO_DELETE entry', async () => {
      const { po } = await createVendorAndPO();
      await request(app).delete(`/api/outbound-pos/${po.body.id}`).set('Authorization', `Bearer ${token}`);
      const res = await auditFor('outbound_po', po.body.id);
      expect(res.body.some(e => e.action_type === 'OUTBOUND_PO_DELETE')).toBe(true);
    });

    test('restore writes an OUTBOUND_PO_RESTORE entry', async () => {
      const { po } = await createVendorAndPO();
      await request(app).delete(`/api/outbound-pos/${po.body.id}`).set('Authorization', `Bearer ${token}`);
      await request(app).post(`/api/outbound-pos/${po.body.id}/restore`).set('Authorization', `Bearer ${token}`);
      const res = await auditFor('outbound_po', po.body.id);
      expect(res.body.some(e => e.action_type === 'OUTBOUND_PO_RESTORE')).toBe(true);
    });
  });
});
