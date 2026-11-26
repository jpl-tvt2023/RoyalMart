// Non-component helpers for the Stock pages (migration 102). Kept out of the
// .jsx files so those export only components (react-refresh).

export const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-IN'));

export const articleText = (r) => `${r.category} · ${r.item_name}${r.variant ? ` · ${r.variant}` : ''}`;

// "Batch #12 · label 4 of 50"
export const labelText = (p) => `Batch #${p.batch_id} · label ${p.label_no} of ${p.label_count}`;

export const packText = (p) => `${fmt(p.pack_size)}${p.unit_metric ? ` ${p.unit_metric}` : ''}`;

export const toastMessage = (err, fallback) => err.response?.data?.message || fallback;

// IST calendar dates, YYYY-MM-DD, for the cross-check's window inputs.
export function istDate(offsetDays = 0) {
  const d = new Date(Date.now() + (5.5 * 60 + offsetDays * 24 * 60) * 60 * 1000);
  return d.toISOString().slice(0, 10);
}
