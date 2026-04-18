const MONTHS = {
  jan: '01', january: '01',
  feb: '02', february: '02',
  mar: '03', march: '03',
  apr: '04', april: '04',
  may: '05',
  jun: '06', june: '06',
  jul: '07', july: '07',
  aug: '08', august: '08',
  sep: '09', sept: '09', september: '09',
  oct: '10', october: '10',
  nov: '11', november: '11',
  dec: '12', december: '12',
};

function pad2(n) { return String(n).padStart(2, '0'); }

function parseIndianDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (m) {
    const mm = MONTHS[m[1].toLowerCase()];
    if (mm) return `${m[3]}-${mm}-${pad2(m[2])}`;
  }

  m = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (m) {
    const mm = MONTHS[m[2].toLowerCase()];
    if (mm) return `${m[3]}-${mm}-${pad2(m[1])}`;
  }

  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;

  return null;
}

module.exports = { parseIndianDate };
