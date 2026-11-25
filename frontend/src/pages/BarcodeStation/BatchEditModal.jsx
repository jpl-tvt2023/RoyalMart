import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import { updateLabelBatch } from '../../api/station.api';
import { batchFieldsError, articleLabel } from '../../utils/barcodeStation';
import { sortByText } from '../../utils/sort';
import { inputCls, fieldsOf } from './stationHelpers';

// The five things an operator fills in, in grid order -- shared by the add row
// on the station page and the edit-draft modal below. Article options are the
// picked vendor's mapped articles. `fallback` names a saved value that is no
// longer offered (vendor deactivated, mapping removed, floor retired), so an
// old draft still shows what it holds -- the server refuses it on save.
export function BatchFields({ value, onChange, options, fallback, layout = 'row' }) {
  const vendors = useMemo(() => sortByText(options?.vendors || [], (v) => v.name), [options]);
  const floors = useMemo(() => sortByText(options?.floors || [], (f) => f.name), [options]);
  const vendor = vendors.find((v) => String(v.id) === String(value.outbound_vendor_id));
  const articles = useMemo(() => sortByText(vendor?.articles || [], articleLabel), [vendor]);
  const article = articles.find((a) => String(a.id) === String(value.article_id));

  const set = (patch) => onChange({ ...value, ...patch });
  const pickVendor = (id) => {
    const next = vendors.find((v) => String(v.id) === String(id));
    // Keep the article only if the new vendor also supplies it.
    const keep = next?.articles.some((a) => String(a.id) === String(value.article_id));
    set({ outbound_vendor_id: id, article_id: keep ? value.article_id : '' });
  };

  const missing = (list, id) => id !== '' && id != null && !list.some((x) => String(x.id) === String(id));
  const grid = layout === 'row'
    ? 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-[1.2fr_2fr_0.8fr_1fr_0.9fr] gap-3'
    : 'grid grid-cols-1 gap-4';

  return (
    <div className={grid}>
      <label className="block">
        <span className="block text-xs font-medium text-gray-600 mb-1">Vendor Name</span>
        <select value={value.outbound_vendor_id} onChange={(e) => pickVendor(e.target.value)} className={inputCls}>
          <option value="">Select vendor…</option>
          {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          {missing(vendors, value.outbound_vendor_id) && (
            <option value={value.outbound_vendor_id}>{fallback?.vendor || 'Unknown vendor'} (no longer available)</option>
          )}
        </select>
      </label>

      <label className="block">
        <span className="block text-xs font-medium text-gray-600 mb-1">Article</span>
        <select
          value={value.article_id}
          onChange={(e) => set({ article_id: e.target.value })}
          className={inputCls}
          disabled={!value.outbound_vendor_id}
        >
          <option value="">{value.outbound_vendor_id ? 'Select article…' : 'Pick a vendor first'}</option>
          {articles.map((a) => <option key={a.id} value={a.id}>{articleLabel(a)}</option>)}
          {value.outbound_vendor_id && missing(articles, value.article_id) && (
            <option value={value.article_id}>{fallback?.article || 'Unknown article'} (no longer mapped)</option>
          )}
        </select>
      </label>

      <label className="block">
        <span className="block text-xs font-medium text-gray-600 mb-1">
          Pack Size{article?.unit_metric ? ` (${article.unit_metric})` : ''}
        </span>
        <input
          type="text"
          inputMode="numeric"
          value={value.pack_size}
          onChange={(e) => set({ pack_size: e.target.value })}
          className={inputCls}
          placeholder="e.g. 300"
        />
      </label>

      <label className="block">
        <span className="block text-xs font-medium text-gray-600 mb-1">Floor</span>
        <select value={value.floor_id} onChange={(e) => set({ floor_id: e.target.value })} className={inputCls}>
          <option value="">Select floor…</option>
          {floors.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          {missing(floors, value.floor_id) && (
            <option value={value.floor_id}>{fallback?.floor || 'Unknown floor'} (no longer available)</option>
          )}
        </select>
      </label>

      <label className="block">
        <span className="block text-xs font-medium text-gray-600 mb-1">Number of Barcodes</span>
        <input
          type="text"
          inputMode="numeric"
          value={value.label_count}
          onChange={(e) => set({ label_count: e.target.value })}
          className={inputCls}
          placeholder="e.g. 180"
        />
      </label>
    </div>
  );
}

// Edit a draft (no keys yet). Generated batches never open this.
export default function BatchEditModal({ batch, options, operator, onClose, onSaved }) {
  const [value, setValue] = useState(() => fieldsOf(batch));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    const err = batchFieldsError(value);
    if (err) { setError(err); return; }
    setSaving(true);
    try {
      const saved = await updateLabelBatch(batch.id, { ...value, operator });
      toast.success(`Batch #${batch.id} updated`);
      onSaved(saved);
    } catch (ex) {
      const status = ex.response?.status;
      const message = ex.response?.data?.message || 'Save failed';
      if (status === 400 || status === 409) setError(message);
      else toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`Edit batch #${batch.id}`} size="md">
      <form onSubmit={save} className="space-y-4" noValidate>
        <BatchFields
          value={value}
          onChange={setValue}
          options={options}
          layout="stack"
          fallback={{ vendor: batch.vendor_name, article: articleLabel(batch), floor: batch.floor_name }}
        />
        {error && <p className="text-sm text-[#c1121f]">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" loading={saving}>Save</Button>
        </div>
      </form>
    </Modal>
  );
}
