const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { logAction, diffFields } = require('../services/auditLog.service');
const { pinError, labelSizeError } = require('../services/barcodeStation.service');

// Admin -> Purchase Config -> Barcode Station (migration 098). Admin/Owner only.
//
// The PIN is only ever written, never read back: GET says whether one is set.
// Setting a PIN, or "sign out all devices", bumps pin_version -- every station
// token carries the version it was issued under, so every device is asked for
// the (new) PIN on its next request. Both also clear the brute-force lock, as
// does "clear lock" on its own.

const BCRYPT_COST = 12;

async function readSettings() {
  const { rows } = await db.execute(
    `SELECT s.pin_hash IS NOT NULL AS pin_set, s.pin_version, s.failed_attempts, s.locked_until,
            (s.locked_until IS NOT NULL AND s.locked_until > datetime('now')) AS locked,
            s.label_width_mm, s.label_height_mm, s.updated_at, u.name AS updated_by_name
       FROM barcode_station_settings s
       LEFT JOIN users u ON u.id = s.updated_by
      WHERE s.id = 1`
  );
  const r = rows[0];
  if (!r) return null;
  return {
    pin_set: !!Number(r.pin_set),
    failed_attempts: Number(r.failed_attempts),
    locked: !!Number(r.locked),
    locked_until: r.locked_until,
    label_width_mm: Number(r.label_width_mm),
    label_height_mm: Number(r.label_height_mm),
    updated_at: r.updated_at,
    updated_by_name: r.updated_by_name,
  };
}

async function get(req, res, next) {
  try {
    const settings = await readSettings();
    if (!settings) return res.status(503).json({ message: 'Barcode Station settings are missing — apply migration 098' });
    res.json(settings);
  } catch (err) { next(err); }
}

// PUT { pin?, label_width_mm?, label_height_mm?, sign_out_all?, clear_lock? }
async function update(req, res, next) {
  try {
    const body = req.body || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined;
    const current = await readSettings();
    if (!current) return res.status(503).json({ message: 'Barcode Station settings are missing — apply migration 098' });

    const sets = [];
    const args = [];
    const actions = [];
    let changes = [];

    if (has('pin')) {
      const pin = body.pin == null ? '' : String(body.pin).trim();
      const err = pinError(pin);
      if (err) return res.status(400).json({ message: err });
      sets.push('pin_hash = ?', 'pin_version = pin_version + 1', 'failed_attempts = 0', 'locked_until = NULL');
      args.push(await bcrypt.hash(pin, BCRYPT_COST));
      actions.push(current.pin_set ? 'changed the PIN (every device signed out)' : 'set the PIN');
    } else if (body.sign_out_all) {
      if (!current.pin_set) return res.status(400).json({ message: 'Set a PIN first' });
      sets.push('pin_version = pin_version + 1');
      actions.push('signed out every device');
    }
    if (body.clear_lock && !has('pin')) {
      sets.push('failed_attempts = 0', 'locked_until = NULL');
      actions.push('cleared the sign-in lock');
    }
    if (has('label_width_mm') || has('label_height_mm')) {
      const width = has('label_width_mm') ? body.label_width_mm : current.label_width_mm;
      const height = has('label_height_mm') ? body.label_height_mm : current.label_height_mm;
      const err = labelSizeError(width, height);
      if (err) return res.status(400).json({ message: err });
      const size = { label_width_mm: Number(width), label_height_mm: Number(height) };
      changes = diffFields(current, size, ['label_width_mm', 'label_height_mm']);
      if (changes.length) {
        sets.push('label_width_mm = ?', 'label_height_mm = ?');
        args.push(size.label_width_mm, size.label_height_mm);
        actions.push(`set the sticker size to ${size.label_width_mm} × ${size.label_height_mm} mm`);
      }
    }
    if (!sets.length) {
      if (has('label_width_mm') || has('label_height_mm')) return res.json(current);
      return res.status(400).json({ message: 'Nothing to update' });
    }

    const tx = await db.transaction('write');
    try {
      await tx.execute({
        sql: `UPDATE barcode_station_settings
                 SET ${sets.join(', ')}, updated_by = ?, updated_at = datetime('now')
               WHERE id = 1`,
        args: [...args, req.user.id],
      });
      await logAction({
        client: tx,
        userId: req.user.id,
        actionType: 'BARCODE_STATION_SETTINGS_UPDATE',
        description: `${req.user.name || req.user.username} ${actions.join(', ')}`,
        entityType: 'barcode_station',
        entityId: 1,
        changes,
      });
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    }
    res.json(await readSettings());
  } catch (err) { next(err); }
}

module.exports = { get, update };
