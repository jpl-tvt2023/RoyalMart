const IST = 'Asia/Kolkata';

function parseAsUtc(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr);
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

export function formatDate(dateStr) {
  const d = parseAsUtc(dateStr);
  if (!d) return '—';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: IST });
}

export function formatDateTime(dateStr) {
  const d = parseAsUtc(dateStr);
  if (!d) return '—';
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: IST });
}

export function formatQty(qty) {
  if (qty === null || qty === undefined) return '0';
  return parseInt(qty).toLocaleString('en-IN');
}
