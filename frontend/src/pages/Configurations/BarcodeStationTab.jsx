import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Copy, ExternalLink, KeyRound, LogOut, Ruler, ShieldAlert, Unlock } from 'lucide-react';
import Button from '../../components/ui/Button';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import { HistoryButton } from '../../components/shared/HistoryDrawer';
import { getBarcodeStationSettings, updateBarcodeStationSettings } from '../../api/barcodeStationSettings.api';
import { pinError, labelSizeError } from '../../utils/barcodeStation';
import { formatDateTime } from '../../utils/formatters';

const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30';
const panel = 'bg-white rounded-xl border border-gray-200 p-5';

// Admin -> Purchase Config -> Barcode Station (migration 098): the shared PIN
// that unlocks the public station page, its sign-in lock, and the sticker size
// the label sheet prints at. The PIN is write-only -- the server never sends it
// back, only whether one is set.
export default function BarcodeStationTab() {
  const [settings, setSettings] = useState(null);
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [pinMsg, setPinMsg] = useState('');
  const [size, setSize] = useState({ w: '', h: '' });
  const [sizeMsg, setSizeMsg] = useState('');
  const [saving, setSaving] = useState('');
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  const stationUrl = `${window.location.origin}/barcode-station`;

  const apply = (s) => {
    setSettings(s);
    setSize({ w: String(s.label_width_mm), h: String(s.label_height_mm) });
  };

  useEffect(() => {
    getBarcodeStationSettings()
      .then(apply)
      .catch((err) => toast.error(err.response?.data?.message || 'Failed to load Barcode Station settings'));
  }, []);

  const save = async (what, payload, okMessage) => {
    setSaving(what);
    try {
      apply(await updateBarcodeStationSettings(payload));
      toast.success(okMessage);
      return true;
    } catch (err) {
      toast.error(err.response?.data?.message || 'Save failed');
      return false;
    } finally {
      setSaving('');
    }
  };

  const savePin = async (e) => {
    e.preventDefault();
    const err = pinError(pin) || (pin !== pin2 ? 'The two PINs do not match' : null);
    if (err) { setPinMsg(err); return; }
    setPinMsg('');
    const ok = await save('pin', { pin }, settings?.pin_set ? 'PIN changed — every station device must enter it again' : 'PIN set — the station is open');
    if (ok) { setPin(''); setPin2(''); }
  };

  const saveSize = async (e) => {
    e.preventDefault();
    const err = labelSizeError(size.w, size.h);
    if (err) { setSizeMsg(err); return; }
    setSizeMsg('');
    await save('size', { label_width_mm: Number(size.w), label_height_mm: Number(size.h) }, 'Sticker size saved');
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(stationUrl);
      toast.success('Station link copied');
    } catch {
      toast.error('Could not copy — select the link and copy it by hand');
    }
  };

  if (!settings) {
    return <div className={`${panel} text-sm text-gray-500`}>Loading…</div>;
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* ---- PIN ---- */}
      <section className={panel}>
        <div className="flex items-start justify-between gap-3 mb-1">
          <h3 className="font-semibold text-[#003049] flex items-center gap-2"><KeyRound size={17} /> Station PIN</h3>
          <HistoryButton entityType="barcode_station" entityId={1} title="Barcode Station settings" />
        </div>
        <p className="text-sm text-gray-500 mb-4">
          {settings.pin_set
            ? 'A PIN is set. Changing it signs every station device out.'
            : 'No PIN yet — the station refuses every sign-in until one is set.'}
          {settings.updated_by_name && <> Last change by {settings.updated_by_name}, {formatDateTime(settings.updated_at)}.</>}
        </p>

        {settings.locked && (
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            <ShieldAlert size={16} />
            <span className="flex-1">
              New sign-ins are locked until {formatDateTime(settings.locked_until)} after {settings.failed_attempts} wrong PINs.
              Devices already signed in still work.
            </span>
            <Button size="sm" variant="outline" loading={saving === 'lock'} onClick={() => save('lock', { clear_lock: true }, 'Sign-in lock cleared')}>
              <Unlock size={14} /> Clear lock
            </Button>
          </div>
        )}
        {!settings.locked && settings.failed_attempts > 0 && (
          <p className="mb-4 text-xs text-amber-700">{settings.failed_attempts} wrong PIN{settings.failed_attempts !== 1 ? 's' : ''} since the last good sign-in.</p>
        )}

        <form onSubmit={savePin} className="space-y-3" noValidate>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-xs font-medium text-gray-600 mb-1">{settings.pin_set ? 'New PIN' : 'PIN'}</span>
              <input
                type="password" inputMode="numeric" autoComplete="new-password" maxLength={8}
                value={pin} onChange={(e) => { setPin(e.target.value.replace(/\D/g, '')); setPinMsg(''); }}
                className={`${inputCls} font-mono tracking-[0.3em]`} placeholder="4–8 digits"
              />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-gray-600 mb-1">Repeat PIN</span>
              <input
                type="password" inputMode="numeric" autoComplete="new-password" maxLength={8}
                value={pin2} onChange={(e) => { setPin2(e.target.value.replace(/\D/g, '')); setPinMsg(''); }}
                className={`${inputCls} font-mono tracking-[0.3em]`}
              />
            </label>
          </div>
          <p className="text-xs text-gray-500">Numbers only, 4 to 8 digits. Longer is safer — the station is reachable from the internet.</p>
          {pinMsg && <p className="text-sm text-[#c1121f]">{pinMsg}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={saving === 'pin'}>{settings.pin_set ? 'Change PIN' : 'Set PIN'}</Button>
            {settings.pin_set && (
              <Button type="button" variant="outline" onClick={() => setConfirmSignOut(true)}>
                <LogOut size={14} /> Sign out all devices
              </Button>
            )}
          </div>
        </form>
      </section>

      <div className="space-y-4">
        {/* ---- Link ---- */}
        <section className={panel}>
          <h3 className="font-semibold text-[#003049] mb-1">Station page</h3>
          <p className="text-sm text-gray-500 mb-3">
            Open this on the warehouse PC and bookmark it. It needs no portal login — only the PIN.
          </p>
          <div className="flex gap-2">
            <input readOnly value={stationUrl} className={`${inputCls} font-mono text-xs`} onFocus={(e) => e.target.select()} />
            <Button type="button" variant="outline" onClick={copyLink} title="Copy link"><Copy size={14} /></Button>
            <a
              href={stationUrl} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center justify-center px-3 rounded-lg border border-[#003049] text-[#003049] hover:bg-[#003049] hover:text-white"
              title="Open station"
            >
              <ExternalLink size={14} />
            </a>
          </div>
        </section>

        {/* ---- Sticker size ---- */}
        <section className={panel}>
          <h3 className="font-semibold text-[#003049] mb-1 flex items-center gap-2"><Ruler size={17} /> Sticker size</h3>
          <p className="text-sm text-gray-500 mb-3">
            The size of one sticker on the label printer, landscape. A 6 × 2 inch sticker is 152 × 51 mm.
          </p>
          <form onSubmit={saveSize} className="flex flex-wrap items-end gap-3" noValidate>
            <label className="block w-28">
              <span className="block text-xs font-medium text-gray-600 mb-1">Width (mm)</span>
              <input inputMode="numeric" value={size.w} onChange={(e) => { setSize((s) => ({ ...s, w: e.target.value.replace(/\D/g, '') })); setSizeMsg(''); }} className={inputCls} />
            </label>
            <label className="block w-28">
              <span className="block text-xs font-medium text-gray-600 mb-1">Height (mm)</span>
              <input inputMode="numeric" value={size.h} onChange={(e) => { setSize((s) => ({ ...s, h: e.target.value.replace(/\D/g, '') })); setSizeMsg(''); }} className={inputCls} />
            </label>
            <Button type="submit" variant="secondary" loading={saving === 'size'}>Save size</Button>
          </form>
          {sizeMsg && <p className="text-sm text-[#c1121f] mt-2">{sizeMsg}</p>}
        </section>
      </div>

      <ConfirmDialog
        isOpen={confirmSignOut}
        onClose={() => setConfirmSignOut(false)}
        onConfirm={async () => { if (await save('signout', { sign_out_all: true }, 'Every station device has been signed out')) setConfirmSignOut(false); }}
        loading={saving === 'signout'}
        title="Sign out all devices?"
        confirmLabel="Sign out all"
        message="Every PC using the Barcode Station will be asked for the PIN again. The PIN itself does not change."
      />
    </div>
  );
}
