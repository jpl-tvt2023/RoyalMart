const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');
const { barcodeStationUser } = require('../services/systemUser.service');
const { signStationToken, NOT_SET_UP_MESSAGE } = require('../middleware/stationAuth');
const { isValidDateString } = require('../utils/dateValidation');
const {
  KEY_MIN, KEY_MAX, batchFieldsError, normOperator, operatorError, keyError, pinError,
} = require('../services/barcodeStation.service');

// The public Barcode Station (migration 098) -- /api/station -- and its Admin
// side, /api/label-batches (labelBatches.routes.js).
//
// Every station route but POST /session sits behind stationAuth, which sets
// req.user to the barcode-station system user. The person at the PC is the
// `operator` named in each write, recorded on the row and in the audit
// description.
//
// A batch is the entry an operator fills in. A DRAFT can be edited or deleted.
// Generate turns it into N random 8-digit keys (one per sticker) in one
// transaction, and from then on the batch is FINAL -- never edited, never
// deleted (the schema enforces the second, migration 101).
//
// Only Admins see keys (client's rule). The station API returns keys in exactly
// one place: the logged print (POST /batches/:id/print), which the station
// renders off-screen straight to the printer. Viewing keys -- the list's key
// preview, a batch's key sheet -- is the Admin router's alone.

// The stored UTC generated_at as the IST calendar day the operator saw --
// shared with the stock counts (migration 102).
const { IST_DATE } = require('../services/stockCount.service');

const ALREADY_GENERATED = 'Keys have already been generated for this batch — it can no longer be changed';
const BATCH_NOT_FOUND = 'Label batch not found';
const LOCKED_MESSAGE = 'Too many wrong PINs — new sign-ins are locked for now. Try again later, or ask an Admin to clear the lock.';

// Every key is drawn at random. Inserts go in chunks, and a key that already
// exists is simply skipped by ON CONFLICT and redrawn on the next pass.
const KEY_INSERT_CHUNK = 500;
const KEY_MAX_PASSES = 6;

// Every 10th wrong PIN locks new sign-ins: 15 min, then 30, 60 ... capped at a
// day. failed_attempts is only reset by a correct PIN or an Admin, so the lock
// keeps escalating across windows. One statement, so concurrent wrong guesses
// cannot both read the same count.
const FAIL_SQL = `
  UPDATE barcode_station_settings
     SET failed_attempts = failed_attempts + 1,
         locked_until = CASE
           WHEN (failed_attempts + 1) % 10 = 0
           THEN datetime('now', '+' || MIN(1440, 15 * (1 << MIN(7, (failed_attempts + 1) / 10 - 1))) || ' minutes')
           ELSE locked_until END
   WHERE id = 1
   RETURNING failed_attempts, locked_until`;

// Every print writes one of these audit rows. print_count is derived from them
// at read time, never stored (idx_audit_entity serves the lookup).
const PRINT_ACTION = 'LABEL_BATCH_PRINT';

const BATCH_SELECT = `
  SELECT b.id, b.outbound_vendor_id, b.article_id, b.floor_id, b.pack_size, b.label_count,
         b.entered_by, b.generated_at, b.generated_by, b.created_at, b.updated_at, b.deleted_at,
         v.name AS vendor_name,
         prm.category, prm.item_name, NULLIF(prm.variant, '') AS variant, prm.unit_metric,
         f.name AS floor_name,
         (SELECT COUNT(*) FROM label_keys k WHERE k.batch_id = b.id) AS key_count,
         (SELECT COUNT(*) FROM audit_logs a
           WHERE a.entity_type = 'label_batch' AND a.entity_id = b.id
             AND a.action_type = '${PRINT_ACTION}') AS print_count
    FROM label_batches b
    JOIN outbound_vendors v        ON v.id = b.outbound_vendor_id
    JOIN packaging_raw_materials prm ON prm.id = b.article_id
    JOIN floors f                  ON f.id = b.floor_id`;

const articleLabel = (r) => `${r.category} · ${r.item_name}${r.variant ? ` · ${r.variant}` : ''}`;

function shapeBatch(r) {
  return {
    ...r,
    id: Number(r.id),
    outbound_vendor_id: Number(r.outbound_vendor_id),
    article_id: Number(r.article_id),
    floor_id: Number(r.floor_id),
    pack_size: Number(r.pack_size),
    label_count: Number(r.label_count),
    key_count: Number(r.key_count),
    print_count: Number(r.print_count),
    is_generated: r.generated_at != null,
  };
}

async function fetchBatch(id, client = db) {
  const { rows } = await client.execute({ sql: `${BATCH_SELECT} WHERE b.id = ?`, args: [id] });
  return rows.length ? shapeBatch(rows[0]) : null;
}

const parseId = (v) => (/^\d+$/.test(String(v)) ? Number(v) : null);

// The five operator fields, coerced. batchFieldsError has already passed.
function batchFields(src) {
  return {
    outbound_vendor_id: Number(src.outbound_vendor_id),
    article_id: Number(src.article_id),
    floor_id: Number(src.floor_id),
    pack_size: Number(String(src.pack_size).trim()),
    label_count: Number(String(src.label_count).trim()),
  };
}

// The picked vendor, article and floor must still be live, and the article
// must be one the vendor is mapped to (outbound_vendor_articles holds the
// mapping as a value triple, matched to the catalog the way
// outboundVendors.controller.js#list does). Returns { error } or the names,
// which the audit diff shows instead of bare ids.
async function checkReferences(f) {
  const { rows } = await db.execute({
    sql: `SELECT
            (SELECT name      FROM outbound_vendors WHERE id = ?) AS vendor_name,
            (SELECT is_active FROM outbound_vendors WHERE id = ?) AS vendor_active,
            (SELECT category || ' · ' || item_name || CASE WHEN variant <> '' THEN ' · ' || variant ELSE '' END
               FROM packaging_raw_materials WHERE id = ?) AS article_label,
            (SELECT 1 FROM outbound_vendor_articles a
               JOIN packaging_raw_materials prm
                 ON prm.category = a.category AND prm.item_name = a.item_name
                AND prm.variant = COALESCE(a.variant, '')
              WHERE a.vendor_id = ? AND prm.id = ? LIMIT 1) AS article_mapped,
            (SELECT name      FROM floors WHERE id = ?) AS floor_name,
            (SELECT is_active FROM floors WHERE id = ?) AS floor_active`,
    args: [f.outbound_vendor_id, f.outbound_vendor_id, f.article_id, f.outbound_vendor_id, f.article_id, f.floor_id, f.floor_id],
  });
  const r = rows[0];
  if (r.vendor_name == null) return { error: 'Vendor not found' };
  if (!Number(r.vendor_active)) return { error: `${r.vendor_name} is no longer active — pick another vendor` };
  if (r.article_label == null) return { error: 'Article not found' };
  if (!r.article_mapped) return { error: `${r.article_label} is not mapped to ${r.vendor_name} — pick one of its articles` };
  if (r.floor_name == null) return { error: 'Floor not found' };
  if (!Number(r.floor_active)) return { error: `${r.floor_name} is no longer active — pick another floor` };
  return { names: { vendor: r.vendor_name, article: r.article_label, floor: r.floor_name } };
}

// The fields the history drawer diffs, by name rather than id.
const auditView = (f, names) => ({
  vendor: names.vendor,
  article: names.article,
  pack_size: f.pack_size,
  floor: names.floor,
  label_count: f.label_count,
});
const AUDIT_FIELDS = ['vendor', 'article', 'pack_size', 'floor', 'label_count'];

function buildPagination(query) {
  const rawPage = query.page;
  const rawSize = query.page_size;
  if (rawSize === 'all' || (rawPage == null && rawSize == null)) {
    return { paginated: false };
  }
  const page = Math.max(1, parseInt(rawPage, 10) || 1);
  const allowed = [10, 25, 50, 100];
  const requested = parseInt(rawSize, 10);
  const page_size = allowed.includes(requested) ? requested : 25;
  return { paginated: true, page, page_size, offset: (page - 1) * page_size };
}

async function loadSettings() {
  const { rows } = await db.execute(
    `SELECT pin_hash, pin_version, failed_attempts, locked_until,
            (locked_until IS NOT NULL AND locked_until > datetime('now')) AS locked
       FROM barcode_station_settings WHERE id = 1`
  );
  return rows[0] || null;
}

// POST /session { pin } -- the only unauthenticated route.
async function createSession(req, res, next) {
  try {
    const pin = req.body?.pin == null ? '' : String(req.body.pin).trim();
    const pinErr = pinError(pin);
    if (pinErr) return res.status(400).json({ message: pinErr });

    const settings = await loadSettings();
    if (!settings || !settings.pin_hash) return res.status(503).json({ message: NOT_SET_UP_MESSAGE });
    if (Number(settings.locked)) return res.status(429).json({ message: LOCKED_MESSAGE, locked_until: settings.locked_until });

    const stationUser = await barcodeStationUser();
    if (!stationUser) return res.status(503).json({ message: 'The barcode-station user is missing — apply migration 098' });

    const ok = await bcrypt.compare(pin, settings.pin_hash);
    if (!ok) {
      const { rows } = await db.execute(FAIL_SQL);
      const after = rows[0];
      const justLocked = Number(after.failed_attempts) % 10 === 0;
      await logAction({
        userId: stationUser.id,
        actionType: 'BARCODE_STATION_PIN_FAILED',
        description: `Wrong Barcode Station PIN from ${req.ip}`
          + (justLocked ? ` — ${after.failed_attempts} in a row, new sign-ins locked until ${after.locked_until} UTC` : ''),
        entityType: 'barcode_station',
        entityId: 1,
      });
      if (justLocked) return res.status(429).json({ message: LOCKED_MESSAGE, locked_until: after.locked_until });
      return res.status(401).json({ message: 'Incorrect PIN' });
    }

    await db.execute(
      `UPDATE barcode_station_settings SET failed_attempts = 0, locked_until = NULL
        WHERE id = 1 AND (failed_attempts <> 0 OR locked_until IS NOT NULL)`
    );
    await logAction({
      userId: stationUser.id,
      actionType: 'BARCODE_STATION_SIGN_IN',
      description: `A device signed in to the Barcode Station from ${req.ip}`,
      entityType: 'barcode_station',
      entityId: 1,
    });
    res.json({ token: signStationToken(settings.pin_version) });
  } catch (err) { next(err); }
}

// GET /options -- what the add-row form needs: active vendors with the
// articles each is mapped to (resolved to catalog ids), active floors, the
// label page. Also hands back a fresh token, so a device in daily use never
// reaches the 90-day expiry.
async function options(req, res, next) {
  try {
    const [articles, floors, settings] = await Promise.all([
      db.execute(
        `SELECT DISTINCT v.id AS vendor_id, v.name AS vendor_name,
                prm.id AS article_id, prm.category, prm.item_name,
                NULLIF(prm.variant, '') AS variant, prm.unit_metric
           FROM outbound_vendors v
           JOIN outbound_vendor_articles a ON a.vendor_id = v.id
           JOIN packaging_raw_materials prm
             ON prm.category = a.category AND prm.item_name = a.item_name
            AND prm.variant = COALESCE(a.variant, '')
          WHERE v.is_active = 1
          ORDER BY v.name COLLATE NOCASE, prm.category COLLATE NOCASE,
                   prm.item_name COLLATE NOCASE, prm.variant COLLATE NOCASE`
      ),
      db.execute('SELECT id, name FROM floors WHERE is_active = 1 ORDER BY name COLLATE NOCASE'),
      db.execute('SELECT print_mode FROM barcode_station_settings WHERE id = 1'),
    ]);

    const vendors = new Map();
    for (const r of articles.rows) {
      const id = Number(r.vendor_id);
      if (!vendors.has(id)) vendors.set(id, { id, name: r.vendor_name, articles: [] });
      vendors.get(id).articles.push({
        id: Number(r.article_id), category: r.category, item_name: r.item_name,
        variant: r.variant, unit_metric: r.unit_metric,
      });
    }

    const s = settings.rows[0] || {};
    res.json({
      vendors: Array.from(vendors.values()),
      floors: floors.rows.map(f => ({ id: Number(f.id), name: f.name })),
      label: await labelSize(),
      print_mode: s.print_mode || 'dialog',
      token: signStationToken(req.stationPinVersion),
    });
  } catch (err) { next(err); }
}

// The grid: drafts first (they still need a Generate), then newest. The
// station's list carries no keys at all. The Admin's adds each generated row's
// first three keys as a preview.
const makeList = ({ withKeyPreview }) => async function list(req, res, next) {
  try {
    const q = req.query || {};
    const conditions = ['b.deleted_at IS NULL'];
    const args = [];

    for (const [param, col] of [['id', 'b.id'], ['vendor_id', 'b.outbound_vendor_id'], ['floor_id', 'b.floor_id']]) {
      if (q[param] == null || q[param] === '') continue;
      const n = parseId(q[param]);
      if (n == null) return res.status(400).json({ message: `${param} must be a number` });
      conditions.push(`${col} = ?`);
      args.push(n);
    }
    if (q.date_from) {
      if (!isValidDateString(q.date_from)) return res.status(400).json({ message: 'date_from must be a valid date (YYYY-MM-DD)' });
      conditions.push(`${IST_DATE('b.generated_at')} >= ?`);
      args.push(q.date_from);
    }
    if (q.date_to) {
      if (!isValidDateString(q.date_to)) return res.status(400).json({ message: 'date_to must be a valid date (YYYY-MM-DD)' });
      conditions.push(`${IST_DATE('b.generated_at')} <= ?`);
      args.push(q.date_to);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const order = 'ORDER BY (b.generated_at IS NOT NULL) ASC, b.id DESC';
    const pag = buildPagination(q);

    let rows;
    let total;
    if (pag.paginated) {
      const [page, count] = await Promise.all([
        db.execute({ sql: `${BATCH_SELECT} ${where} ${order} LIMIT ? OFFSET ?`, args: [...args, pag.page_size, pag.offset] }),
        db.execute({ sql: `SELECT COUNT(*) AS c FROM label_batches b ${where}`, args }),
      ]);
      rows = page.rows.map(shapeBatch);
      total = Number(count.rows[0].c);
    } else {
      rows = (await db.execute({ sql: `${BATCH_SELECT} ${where} ${order}`, args })).rows.map(shapeBatch);
      total = rows.length;
    }

    if (withKeyPreview) {
      const generatedIds = rows.filter(r => r.is_generated).map(r => r.id);
      const byBatch = new Map();
      if (generatedIds.length) {
        const { rows: preview } = await db.execute({
          sql: `SELECT batch_id, label_key FROM label_keys
                 WHERE label_no <= 3 AND batch_id IN (${generatedIds.map(() => '?').join(',')})
                 ORDER BY batch_id, label_no`,
          args: generatedIds,
        });
        for (const p of preview) {
          const id = Number(p.batch_id);
          if (!byBatch.has(id)) byBatch.set(id, []);
          byBatch.get(id).push(Number(p.label_key));
        }
      }
      for (const r of rows) r.key_preview = byBatch.get(r.id) || [];
    }

    if (!pag.paginated) return res.json({ rows, total, page: 1, page_size: rows.length });
    res.json({ rows, total, page: pag.page, page_size: pag.page_size });
  } catch (err) { next(err); }
};

// GET /api/station/batches -- no keys.
const list = makeList({ withKeyPreview: false });
// GET /api/label-batches -- Admin only, with the key preview.
const adminList = makeList({ withKeyPreview: true });

// POST /batches -- a new draft. No keys yet.
async function create(req, res, next) {
  try {
    const body = req.body || {};
    const err = batchFieldsError(body) || operatorError(body.operator);
    if (err) return res.status(400).json({ message: err });

    const f = batchFields(body);
    const ref = await checkReferences(f);
    if (ref.error) return res.status(400).json({ message: ref.error });
    const operator = normOperator(body.operator);

    let id;
    const tx = await db.transaction('write');
    try {
      const { rows } = await tx.execute({
        sql: `INSERT INTO label_batches (outbound_vendor_id, article_id, floor_id, pack_size, label_count, entered_by)
              VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
        args: [f.outbound_vendor_id, f.article_id, f.floor_id, f.pack_size, f.label_count, operator],
      });
      id = Number(rows[0].id);
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'LABEL_BATCH_CREATE',
        description: `${operator} added label batch #${id}: ${ref.names.vendor}, ${ref.names.article}, pack of ${f.pack_size}, ${ref.names.floor}, ${f.label_count} labels`,
        entityType: 'label_batch',
        entityId: id,
      });
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    }
    res.status(201).json(await fetchBatch(id));
  } catch (err) { next(err); }
}

// The row a write is about to touch: 404 if missing or deleted, 409 once its
// keys exist. Read outside the transaction -- the write itself re-checks with
// its WHERE clause, which is what actually decides a race.
async function loadDraft(id, res) {
  const batch = id == null ? null : await fetchBatch(id);
  if (!batch || batch.deleted_at) { res.status(404).json({ message: BATCH_NOT_FOUND }); return null; }
  if (batch.is_generated) { res.status(409).json({ message: ALREADY_GENERATED }); return null; }
  return batch;
}

// PATCH /batches/:id -- edit a draft. Any of the five fields, plus operator.
async function update(req, res, next) {
  try {
    const id = parseId(req.params.id);
    const current = await loadDraft(id, res);
    if (!current) return;

    const body = req.body || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    const merged = {};
    for (const k of ['outbound_vendor_id', 'article_id', 'pack_size', 'floor_id', 'label_count']) {
      merged[k] = has(k) ? body[k] : current[k];
    }
    const err = batchFieldsError(merged) || operatorError(body.operator);
    if (err) return res.status(400).json({ message: err });

    const f = batchFields(merged);
    const ref = await checkReferences(f);
    if (ref.error) return res.status(400).json({ message: ref.error });
    const operator = normOperator(body.operator);

    const before = auditView(current, { vendor: current.vendor_name, article: articleLabel(current), floor: current.floor_name });
    const changes = diffFields(before, auditView(f, ref.names), AUDIT_FIELDS);

    const tx = await db.transaction('write');
    let updated;
    try {
      const { rows } = await tx.execute({
        sql: `UPDATE label_batches
                 SET outbound_vendor_id = ?, article_id = ?, floor_id = ?, pack_size = ?, label_count = ?,
                     updated_at = datetime('now')
               WHERE id = ? AND generated_at IS NULL AND deleted_at IS NULL
               RETURNING id`,
        args: [f.outbound_vendor_id, f.article_id, f.floor_id, f.pack_size, f.label_count, id],
      });
      updated = rows.length > 0;
      if (updated && changes.length) {
        await logAction({
          client: tx,
          userId: req.user.id,
          actionType: 'LABEL_BATCH_UPDATE',
          description: `${operator} edited label batch #${id}`,
          entityType: 'label_batch',
          entityId: id,
          changes,
        });
      }
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    }
    // Generated or deleted between the read above and the write.
    if (!updated) return res.status(409).json({ message: ALREADY_GENERATED });
    res.json(await fetchBatch(id));
  } catch (err) { next(err); }
}

// DELETE /batches/:id { operator } -- soft-deletes a DRAFT. A generated batch
// is final: its keys exist and its stickers may be on boxes, so it is never
// deleted (409 here, and the schema's CHECK behind it since migration 101).
async function remove(req, res, next) {
  try {
    const id = parseId(req.params.id);
    const current = await loadDraft(id, res);
    if (!current) return;

    const opErr = operatorError(req.body?.operator);
    if (opErr) return res.status(400).json({ message: opErr });
    const operator = normOperator(req.body.operator);

    const tx = await db.transaction('write');
    let deleted;
    try {
      const { rows } = await tx.execute({
        sql: `UPDATE label_batches
                 SET deleted_at = datetime('now'), deleted_by = ?, updated_at = datetime('now')
               WHERE id = ? AND generated_at IS NULL AND deleted_at IS NULL RETURNING id`,
        args: [operator, id],
      });
      deleted = rows.length > 0;
      if (deleted) {
        await logAction({
          client: tx,
          userId: req.user.id,
          actionType: 'LABEL_BATCH_DELETE',
          description: `${operator} deleted draft label batch #${id} (${current.vendor_name}, ${articleLabel(current)}, ${current.label_count} labels)`,
          entityType: 'label_batch',
          entityId: id,
        });
      }
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    }
    // Generated, or deleted, between the read above and the write.
    if (!deleted) {
      const now = await fetchBatch(id);
      if (!now || now.deleted_at) return res.status(404).json({ message: BATCH_NOT_FOUND });
      return res.status(409).json({ message: ALREADY_GENERATED });
    }
    res.json({ deleted: true });
  } catch (err) { next(err); }
}

const drawKey = () => crypto.randomInt(KEY_MIN, KEY_MAX + 1);

// Writes one random key per label_no 1..count for a batch, inside the caller's
// transaction. Each pass draws a distinct key per still-unfilled label and
// inserts with ON CONFLICT DO NOTHING -- a key some other batch already owns
// (rare: 90 million to choose from) is skipped, comes back missing from
// RETURNING, and is redrawn on the next pass. The write transaction holds the
// database's write lock, so no other batch can take a key mid-way.
async function insertRandomKeys(tx, batchId, count) {
  let pending = Array.from({ length: count }, (_, i) => i + 1);
  for (let pass = 0; pass < KEY_MAX_PASSES && pending.length; pass++) {
    const drawn = new Set();
    const assignments = pending.map((labelNo) => {
      let key;
      do { key = drawKey(); } while (drawn.has(key));
      drawn.add(key);
      return [labelNo, key];
    });
    const missed = [];
    for (let i = 0; i < assignments.length; i += KEY_INSERT_CHUNK) {
      const chunk = assignments.slice(i, i + KEY_INSERT_CHUNK);
      const { rows } = await tx.execute({
        sql: `INSERT INTO label_keys (label_key, batch_id, label_no)
              VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')}
              ON CONFLICT(label_key) DO NOTHING
              RETURNING label_no`,
        args: chunk.flatMap(([labelNo, key]) => [key, batchId, labelNo]),
      });
      const inserted = new Set(rows.map(r => Number(r.label_no)));
      for (const [labelNo] of chunk) if (!inserted.has(labelNo)) missed.push(labelNo);
    }
    pending = missed;
  }
  if (pending.length) {
    throw Object.assign(new Error('Could not draw enough unique keys — please press Generate again'), { status: 503 });
  }
}

// POST /batches/:id/generate { operator } -- the step that cannot be undone.
async function generate(req, res, next) {
  try {
    const id = parseId(req.params.id);
    const current = await loadDraft(id, res);
    if (!current) return;

    const opErr = operatorError(req.body?.operator);
    if (opErr) return res.status(400).json({ message: opErr });
    const operator = normOperator(req.body.operator);

    // Re-checked here, not just on save: the vendor, article mapping or floor
    // may have been retired since the draft was written, and after this the
    // batch can never be corrected.
    const ref = await checkReferences(current);
    if (ref.error) return res.status(400).json({ message: ref.error });

    const tx = await db.transaction('write');
    let claimed;
    try {
      // Compare-and-set: only the request that flips generated_at from NULL
      // writes keys. A second click (or a second PC) updates nothing.
      const { rows } = await tx.execute({
        sql: `UPDATE label_batches
                 SET generated_at = datetime('now'), generated_by = ?, updated_at = datetime('now')
               WHERE id = ? AND generated_at IS NULL AND deleted_at IS NULL
               RETURNING label_count`,
        args: [operator, id],
      });
      claimed = rows.length > 0;
      if (claimed) {
        const count = Number(rows[0].label_count);
        await insertRandomKeys(tx, id, count);
        await logAction({
          client: tx,
          userId: req.user.id,
          actionType: 'LABEL_BATCH_GENERATE',
          description: `${operator} generated ${count} key${count !== 1 ? 's' : ''} for label batch #${id} (${current.vendor_name}, ${articleLabel(current)}, ${current.floor_name})`,
          entityType: 'label_batch',
          entityId: id,
        });
        await tx.commit();
      } else {
        await tx.rollback();
      }
    } catch (e) {
      await tx.rollback();
      throw e;
    }
    if (!claimed) return res.status(409).json({ message: ALREADY_GENERATED });
    res.json(await fetchBatch(id));
  } catch (err) { next(err); }
}

// The label page every print sheet is laid out at (098, 104): one sticker's
// size, and how many share a printed page -- with the gap between them and the
// margin above and below. The client renders the page from these.
async function labelSize() {
  const { rows } = await db.execute(
    `SELECT label_width_mm, label_height_mm, labels_per_page, label_gap_mm, page_margin_mm
       FROM barcode_station_settings WHERE id = 1`
  );
  const s = rows[0] || {};
  return {
    width_mm: Number(s.label_width_mm) || 152,
    height_mm: Number(s.label_height_mm) || 51,
    per_page: Number(s.labels_per_page) || 1,
    gap_mm: Number(s.label_gap_mm) || 0,
    margin_mm: Number(s.page_margin_mm) || 0,
  };
}

// A generated batch and the slice of its keys from..to (label numbers, both
// optional: the whole batch by default). Returns { status, message } on a bad
// request, so the view and the print routes answer alike.
async function loadKeySlice(rawId, rawFrom, rawTo) {
  const id = parseId(rawId);
  const batch = id == null ? null : await fetchBatch(id);
  if (!batch || batch.deleted_at) return { status: 404, message: BATCH_NOT_FOUND };
  if (!batch.is_generated) return { status: 409, message: 'Generate the keys for this batch first' };

  const n = batch.label_count;
  const blank = (v) => v == null || v === '';
  const from = blank(rawFrom) ? 1 : parseId(rawFrom);
  const to = blank(rawTo) ? n : parseId(rawTo);
  if (from == null || to == null || from < 1 || to > n || from > to) {
    return { status: 400, message: `Labels must be a range within 1 to ${n}` };
  }

  const { rows } = await db.execute({
    sql: `SELECT label_no, label_key FROM label_keys
           WHERE batch_id = ? AND label_no BETWEEN ? AND ? ORDER BY label_no`,
    args: [id, from, to],
  });
  return {
    batch,
    from,
    to,
    keys: rows.map(r => ({ label_no: Number(r.label_no), label_key: Number(r.label_key) })),
  };
}

// GET /api/label-batches/:id/keys?from=&to= -- ADMIN ONLY. Every key of a
// batch (or a slice), with the batch and the label page, for the Admin's key
// list and print preview. Viewing is not a print, so it is not logged.
async function keys(req, res, next) {
  try {
    const slice = await loadKeySlice(req.params.id, req.query?.from, req.query?.to);
    if (slice.status) return res.status(slice.status).json({ message: slice.message });
    res.json({ batch: slice.batch, keys: slice.keys, label: await labelSize() });
  } catch (err) { next(err); }
}

// POST .../batches/:id/print { from?, to? } -- the keys to print, and the log
// entry that says they were printed. EVERY print goes through here and writes a
// LABEL_BATCH_PRINT audit row -- logged before the keys are handed over, so
// there is no print without a record. Reprints are allowed, any number of times.
//
// `operatorOf(req)` names who printed: on the station the typed operator name
// (validated), for an Admin their portal name. The audit user_id is req.user:
// the barcode-station system user, or the Admin.
const makePrint = (operatorOf) => async function print(req, res, next) {
  try {
    const who = operatorOf(req);
    if (who.error) return res.status(400).json({ message: who.error });

    const body = req.body || {};
    const slice = await loadKeySlice(req.params.id, body.from, body.to);
    if (slice.status) return res.status(slice.status).json({ message: slice.message });

    const { batch, from, to } = slice;
    const which = from === 1 && to === batch.label_count
      ? `all ${batch.label_count} label${batch.label_count !== 1 ? 's' : ''}`
      : `labels ${from}–${to} of ${batch.label_count}`;
    await logAction({
      userId: req.user.id,
      actionType: PRINT_ACTION,
      description: `${who.name} printed ${which} of label batch #${batch.id} (${batch.vendor_name}, ${articleLabel(batch)}, ${batch.floor_name})`,
      entityType: 'label_batch',
      entityId: batch.id,
    });
    res.json({
      batch: { ...batch, print_count: batch.print_count + 1 },
      keys: slice.keys,
      label: await labelSize(),
    });
  } catch (err) { next(err); }
};

// POST /api/station/batches/:id/print { operator, from?, to? }
const print = makePrint((req) => {
  const error = operatorError(req.body?.operator);
  return error ? { error } : { name: normOperator(req.body.operator) };
});

// POST /api/label-batches/:id/print { from?, to? } -- ADMIN ONLY.
const adminPrint = makePrint((req) => ({ name: req.user.name || req.user.username }));

// GET /keys/:key -- which entry a scanned or typed key belongs to. Shows the
// entry for a sticker the person already holds -- never any other key.
async function findKey(req, res, next) {
  try {
    const raw = String(req.params.key || '').trim();
    const err = keyError(raw);
    if (err) return res.status(400).json({ message: err });

    const { rows } = await db.execute({
      sql: 'SELECT batch_id, label_no FROM label_keys WHERE label_key = ?',
      args: [Number(raw)],
    });
    if (!rows.length) return res.status(404).json({ message: `No label has the key ${raw}` });
    const batch = await fetchBatch(Number(rows[0].batch_id));
    res.json({ label_key: Number(raw), label_no: Number(rows[0].label_no), batch });
  } catch (err) { next(err); }
}

module.exports = {
  // station (stationAuth)
  createSession, options, list, create, update, remove, generate, print, findKey,
  // Admin (auth + ADMIN_ROLES)
  adminList, keys, adminPrint,
  // exported for the tests
  insertRandomKeys,
};
