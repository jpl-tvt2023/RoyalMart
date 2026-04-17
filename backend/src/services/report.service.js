const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const db = require('../config/db');
const { REPORT_OUTPUT_DIR } = require('../config/env');

async function generateDailyReport() {
  const date = new Date().toISOString().slice(0, 10);
  const outputDir = path.resolve(REPORT_OUTPUT_DIR);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Royal Mart ROMS';
  wb.created = new Date();

  // Sheet 1: Stock Snapshot
  const stockSheet = wb.addWorksheet('Stock Snapshot');
  stockSheet.columns = [
    { header: 'SKU Code',         key: 'sku_code',          width: 18 },
    { header: 'Name',             key: 'name',              width: 35 },
    { header: 'Color',            key: 'color',             width: 12 },
    { header: 'On Hand',          key: 'on_hand_qty',       width: 12 },
    { header: 'In Transit',       key: 'in_transit_qty',    width: 12 },
    { header: 'Committed',        key: 'committed_qty',     width: 12 },
    { header: 'Net Position',     key: 'net_position',      width: 14 },
    { header: 'Safety Threshold', key: 'safety_threshold',  width: 18 },
    { header: 'Status',           key: 'status',            width: 12 },
  ];
  stockSheet.getRow(1).font = { bold: true };

  const { rows: stockRows } = await db.execute(`
    SELECT p.sku_code, p.name, p.color, i.on_hand_qty, i.in_transit_qty, i.committed_qty,
           (i.on_hand_qty + i.in_transit_qty - i.committed_qty) AS net_position,
           p.safety_threshold
    FROM products p JOIN inventory i ON i.sku_id = p.id
    ORDER BY p.sku_code
  `);

  for (const row of stockRows) {
    const isCritical = parseInt(row.net_position) < parseInt(row.safety_threshold);
    const dataRow = stockSheet.addRow({ ...row, status: isCritical ? 'CRITICAL' : 'OK' });
    if (isCritical) {
      dataRow.getCell('status').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF4444' } };
      dataRow.getCell('net_position').font = { color: { argb: 'FFCC0000' }, bold: true };
    }
  }

  // Sheet 2: Critical Items
  const criticalSheet = wb.addWorksheet('Critical Items');
  criticalSheet.columns = stockSheet.columns;
  criticalSheet.getRow(1).font = { bold: true, color: { argb: 'FFCC0000' } };
  for (const row of stockRows) {
    if (parseInt(row.net_position) < parseInt(row.safety_threshold)) {
      criticalSheet.addRow({ ...row, status: 'CRITICAL' });
    }
  }

  // Sheet 3: Audit Log (today)
  const auditSheet = wb.addWorksheet('Audit Log');
  auditSheet.columns = [
    { header: 'Time',        key: 'timestamp',   width: 22 },
    { header: 'User',        key: 'user_name',   width: 20 },
    { header: 'Action',      key: 'action_type', width: 22 },
    { header: 'Entity',      key: 'entity_type', width: 15 },
    { header: 'Entity ID',   key: 'entity_id',   width: 10 },
    { header: 'Description', key: 'description', width: 60 },
  ];
  auditSheet.getRow(1).font = { bold: true };

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);

  const { rows: auditRows } = await db.execute({
    sql: `SELECT al.timestamp, u.name AS user_name, al.action_type, al.entity_type, al.entity_id, al.description
          FROM audit_logs al LEFT JOIN users u ON u.id = al.user_id
          WHERE al.timestamp >= ? AND al.timestamp < ?
          ORDER BY al.timestamp`,
    args: [todayStart.toISOString(), tomorrowStart.toISOString()],
  });

  for (const row of auditRows) {
    auditSheet.addRow({
      ...row,
      timestamp: new Date(row.timestamp).toLocaleString('en-IN'),
    });
  }

  const filePath = path.join(outputDir, `${date}_Daily_Snapshot.xlsx`);
  await wb.xlsx.writeFile(filePath);
  console.log(`Daily report saved: ${filePath}`);
  return filePath;
}

module.exports = { generateDailyReport };
