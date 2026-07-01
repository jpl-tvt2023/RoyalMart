const fs = require('fs');
const path = require('path');
const parseScootsy = require('./src/parsers/marketplacePO/scootsy');

(async () => {
  const pdfPath = path.join(__dirname, 'src/parsers/marketplacePO/samples/scootsy/exception/QLGRP0NZIALDDSA4DPXH_CREATE_OTB_PURCHASE_ORDER_d216565b-ed8f-4ed2-b118-65f1c0a85cbd.pdf');
  const buffer = fs.readFileSync(pdfPath);

  try {
    const result = await parseScootsy(buffer);
    console.log('Parser succeeded!');
    console.log('PO ID:', result.vendor_po_id);
    console.log('Lines extracted:', result.lines.length);
    result.lines.forEach(l => console.log(`  Sr=${l.line_no}, Code=${l.item_code}, Qty=${l.qty}`));
  } catch (err) {
    console.log('Parser failed:', err.message);
  }
})();
