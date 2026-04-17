async function seed(pool) {
  const products = [
    { sku_code: 'BND-RED-S1',  name: 'Red Bandana (Single)',     hsn_code: '6214', fabric_type: 'Cotton', gsm: 130, color: 'Red',   safety_threshold: 200 },
    { sku_code: 'BND-RED-P3',  name: 'Red Bandana (Pack of 3)',  hsn_code: '6214', fabric_type: 'Cotton', gsm: 130, color: 'Red',   safety_threshold: 100 },
    { sku_code: 'BND-BLK-S1',  name: 'Black Bandana (Single)',   hsn_code: '6214', fabric_type: 'Cotton', gsm: 130, color: 'Black', safety_threshold: 200 },
    { sku_code: 'BND-BLK-P3',  name: 'Black Bandana (Pack of 3)',hsn_code: '6214', fabric_type: 'Cotton', gsm: 130, color: 'Black', safety_threshold: 100 },
    { sku_code: 'FSK-WHT-P3',  name: 'Full Socks White (Pack of 3)', hsn_code: '6115', fabric_type: 'Cotton Rib', gsm: 180, color: 'White', safety_threshold: 150 },
    { sku_code: 'FSK-WHT-P6',  name: 'Full Socks White (Pack of 6)', hsn_code: '6115', fabric_type: 'Cotton Rib', gsm: 180, color: 'White', safety_threshold: 100 },
    { sku_code: 'FSK-WHT-P9',  name: 'Full Socks White (Pack of 9)', hsn_code: '6115', fabric_type: 'Cotton Rib', gsm: 180, color: 'White', safety_threshold:  75 },
    { sku_code: 'FSK-BLK-P3',  name: 'Full Socks Black (Pack of 3)', hsn_code: '6115', fabric_type: 'Cotton Rib', gsm: 180, color: 'Black', safety_threshold: 150 },
    { sku_code: 'FSK-BLK-P6',  name: 'Full Socks Black (Pack of 6)', hsn_code: '6115', fabric_type: 'Cotton Rib', gsm: 180, color: 'Black', safety_threshold: 100 },
    { sku_code: 'FSK-BLK-P9',  name: 'Full Socks Black (Pack of 9)', hsn_code: '6115', fabric_type: 'Cotton Rib', gsm: 180, color: 'Black', safety_threshold:  75 },
    { sku_code: 'HKF-WHT-S1',  name: 'White Handkerchief (Single)',  hsn_code: '6213', fabric_type: 'Cotton', gsm: 90, color: 'White', safety_threshold: 500 },
    { sku_code: 'HKF-WHT-P6',  name: 'White Handkerchief (Pack of 6)',hsn_code: '6213', fabric_type: 'Cotton', gsm: 90, color: 'White', safety_threshold: 200 },
    { sku_code: 'HKF-CHK-S1',  name: 'Checked Handkerchief (Single)',  hsn_code: '6213', fabric_type: 'Cotton', gsm: 90, color: 'Multi', safety_threshold: 500 },
    { sku_code: 'HKF-CHK-P6',  name: 'Checked Handkerchief (Pack of 6)',hsn_code: '6213', fabric_type: 'Cotton', gsm: 90, color: 'Multi', safety_threshold: 200 },
  ];

  for (const p of products) {
    const { rows } = await pool.query(
      `INSERT INTO products (sku_code, name, hsn_code, fabric_type, gsm, color, safety_threshold)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (sku_code) DO NOTHING
       RETURNING id`,
      [p.sku_code, p.name, p.hsn_code, p.fabric_type, p.gsm, p.color, p.safety_threshold]
    );
    if (rows.length > 0) {
      await pool.query(
        `INSERT INTO inventory (sku_id) VALUES ($1) ON CONFLICT (sku_id) DO NOTHING`,
        [rows[0].id]
      );
      console.log(`  seeded product: ${p.sku_code}`);
    }
  }

  const packaging = [
    { name: 'Poly Bags (Small)',  unit: 'pcs',  on_hand_qty: 0, safety_threshold: 500 },
    { name: 'Poly Bags (Large)',  unit: 'pcs',  on_hand_qty: 0, safety_threshold: 300 },
    { name: 'Cardboard Boxes',    unit: 'pcs',  on_hand_qty: 0, safety_threshold: 100 },
    { name: 'Product Labels',     unit: 'rolls', on_hand_qty: 0, safety_threshold: 10  },
  ];

  for (const pkg of packaging) {
    await pool.query(
      `INSERT INTO packaging_materials (name, unit, on_hand_qty, safety_threshold)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT DO NOTHING`,
      [pkg.name, pkg.unit, pkg.on_hand_qty, pkg.safety_threshold]
    );
    console.log(`  seeded packaging: ${pkg.name}`);
  }
}

module.exports = seed;
