const { logAction } = require('./auditLog.service');

const STATUS_FLOW = {
  'Ordered':    'In-Transit',
  'In-Transit': 'Arrived',
  'Arrived':    'Received',
};

async function applyPOStatusChange(pool, poId, newStatus, actingUserId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: poRows } = await client.query(
      'SELECT * FROM supplier_pos WHERE id = $1 FOR UPDATE',
      [poId]
    );
    const po = poRows[0];
    if (!po) throw Object.assign(new Error('PO not found'), { status: 404 });

    const expectedNext = STATUS_FLOW[po.status];
    if (!expectedNext) throw Object.assign(new Error(`PO is already in final status: ${po.status}`), { status: 400 });
    if (newStatus !== expectedNext) {
      throw Object.assign(
        new Error(`Invalid transition: ${po.status} → ${newStatus}. Expected: ${expectedNext}`),
        { status: 400 }
      );
    }

    let inventoryDelta = {};
    if (newStatus === 'In-Transit') {
      await client.query(
        'UPDATE inventory SET in_transit_qty = in_transit_qty + $1, updated_at = NOW() WHERE sku_id = $2',
        [po.quantity, po.sku_id]
      );
      inventoryDelta = { in_transit_qty: `+${po.quantity}` };
    } else if (newStatus === 'Received') {
      await client.query(
        `UPDATE inventory SET
          in_transit_qty = GREATEST(in_transit_qty - $1, 0),
          on_hand_qty = on_hand_qty + $1,
          updated_at = NOW()
         WHERE sku_id = $2`,
        [po.quantity, po.sku_id]
      );
      inventoryDelta = { in_transit_qty: `-${po.quantity}`, on_hand_qty: `+${po.quantity}` };
    }

    const { rows: updatedPO } = await client.query(
      'UPDATE supplier_pos SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [newStatus, poId]
    );

    await logAction({
      client,
      userId: actingUserId,
      actionType: 'PO_STATUS_CHANGE',
      description: `PO #${poId} status changed: ${po.status} → ${newStatus} (SKU ID: ${po.sku_id}, Qty: ${po.quantity})`,
      entityType: 'supplier_po',
      entityId: poId,
    });

    if (Object.keys(inventoryDelta).length > 0) {
      await logAction({
        client,
        userId: actingUserId,
        actionType: 'INVENTORY_UPDATE',
        description: `Inventory updated via PO #${poId}: ${JSON.stringify(inventoryDelta)}`,
        entityType: 'inventory',
        entityId: po.sku_id,
      });
    }

    await client.query('COMMIT');
    return { po: updatedPO[0], inventoryDelta };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { applyPOStatusChange };
