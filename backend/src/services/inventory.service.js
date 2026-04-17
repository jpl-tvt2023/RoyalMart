const { logAction } = require('./auditLog.service');

const STATUS_FLOW = {
  'Ordered':    'In-Transit',
  'In-Transit': 'Arrived',
  'Arrived':    'Received',
};

async function applyPOStatusChange(db, poId, newStatus, actingUserId) {
  const tx = await db.transaction('write');
  try {
    const { rows: poRows } = await tx.execute({
      sql: 'SELECT * FROM supplier_pos WHERE id = ?',
      args: [poId],
    });
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
      await tx.execute({
        sql: 'UPDATE inventory SET in_transit_qty = in_transit_qty + ?, updated_at = datetime(\'now\') WHERE sku_id = ?',
        args: [po.quantity, po.sku_id],
      });
      inventoryDelta = { in_transit_qty: `+${po.quantity}` };
    } else if (newStatus === 'Received') {
      await tx.execute({
        sql: `UPDATE inventory SET
                in_transit_qty = MAX(in_transit_qty - ?, 0),
                on_hand_qty = on_hand_qty + ?,
                updated_at = datetime('now')
              WHERE sku_id = ?`,
        args: [po.quantity, po.quantity, po.sku_id],
      });
      inventoryDelta = { in_transit_qty: `-${po.quantity}`, on_hand_qty: `+${po.quantity}` };
    }

    const { rows: updatedPO } = await tx.execute({
      sql: 'UPDATE supplier_pos SET status = ?, updated_at = datetime(\'now\') WHERE id = ? RETURNING *',
      args: [newStatus, poId],
    });

    await logAction({
      client: tx,
      userId: actingUserId,
      actionType: 'PO_STATUS_CHANGE',
      description: `PO #${poId} status changed: ${po.status} → ${newStatus} (SKU ID: ${po.sku_id}, Qty: ${po.quantity})`,
      entityType: 'supplier_po',
      entityId: poId,
    });

    if (Object.keys(inventoryDelta).length > 0) {
      await logAction({
        client: tx,
        userId: actingUserId,
        actionType: 'INVENTORY_UPDATE',
        description: `Inventory updated via PO #${poId}: ${JSON.stringify(inventoryDelta)}`,
        entityType: 'inventory',
        entityId: po.sku_id,
      });
    }

    await tx.commit();
    return { po: updatedPO[0], inventoryDelta };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

module.exports = { applyPOStatusChange };
