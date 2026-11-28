import { useState } from 'react';
import toast from 'react-hot-toast';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
import PartyNameInput from '../../components/ui/PartyNameInput';
import { createBalajiBuilty } from '../../api/balajiBuilty.api';
import { FIELDS, LABELS, DATE_FIELDS, SUGGESTIONS, MONO_FIELDS, entryFieldsError, emptyEntry } from '../../utils/balajiBuilty';

// Add a Balaji Builty entry. Every field is typed by hand, in the grid's column
// order; the id (P001, P002 ...) is assigned by the server on save. Vendor,
// Party Name, City and Courier suggest values used before, but take any text.
// Opened on a vendor tab, the form starts with that vendor filled in, and
// Order Date always starts on today.

const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30';

// Today, local time, as YYYY-MM-DD -- Order Date starts on it (it can be changed or cleared).
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function BalajiBuiltyFormModal({ defaultVendor, options, onClose, onSaved }) {
  const [value, setValue] = useState(() => ({ ...emptyEntry(), po_date: today(), vendor: defaultVendor || '' }));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const set = (key, v) => setValue((prev) => ({ ...prev, [key]: v }));

  const save = async (e) => {
    e.preventDefault();
    const err = entryFieldsError(value);
    if (err) { setError(err); return; }
    setSaving(true);
    try {
      const saved = await createBalajiBuilty(value);
      toast.success(`Saved ${saved.po_id}`);
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
    <Modal isOpen onClose={onClose} title="Add Balaji Builty entry" size="lg">
      <form onSubmit={save} className="space-y-4" noValidate>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {FIELDS.map((key) => (
            <label key={key} className="block">
              <span className="block text-xs font-medium text-gray-600 mb-1">
                {LABELS[key]}{key === 'vendor' && <span className="text-[#c1121f]"> *</span>}
              </span>
              {SUGGESTIONS[key] ? (
                <PartyNameInput
                  value={value[key]}
                  options={options?.[SUGGESTIONS[key]] || []}
                  onChange={(v) => set(key, v)}
                  placeholder=""
                  className={inputCls}
                />
              ) : (
                <input
                  type={DATE_FIELDS.includes(key) ? 'date' : 'text'}
                  inputMode={key === 'qty' ? 'numeric' : undefined}
                  value={value[key]}
                  onChange={(e) => set(key, e.target.value)}
                  className={`${inputCls} ${MONO_FIELDS.includes(key) ? 'font-mono' : ''}`}
                />
              )}
            </label>
          ))}
        </div>
        {error && <p className="text-sm text-[#c1121f]">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" loading={saving}>Save</Button>
        </div>
      </form>
    </Modal>
  );
}
