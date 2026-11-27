import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Copy, ExternalLink, KeyRound, LogOut, Printer, Ruler, ShieldAlert, Unlock } from 'lucide-react';
import Button from '../../components/ui/Button';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import { HistoryButton } from '../../components/shared/HistoryDrawer';
import { getBarcodeStationSettings, updateBarcodeStationSettings } from '../../api/barcodeStationSettings.api';
import { pinError, labelSizeError, labelPageError, labelPageHeight } from '../../utils/barcodeStation';
import { formatDateTime } from '../../utils/formatters';

const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30';
const panel = 'bg-white rounded-xl border border-gray-200 p-5';

// The two shortcuts a station PC needs for kiosk printing (Chrome / Edge). A
// dedicated --user-data-dir makes it a separate browser instance, so its flags
// apply even while the normal browser is open, and it keeps its own remembered
// print settings. --app opens the station without an address bar.
const BROWSERS = {
  chrome: { label: 'Chrome', exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', dir: 'C:\\BarcodeStation\\Chrome' },
  edge: { label: 'Edge', exe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', dir: 'C:\\BarcodeStation\\Edge' },
};
const shortcutTarget = (b, url, kiosk) => `"${b.exe}"${kiosk ? ' --kiosk-printing' : ''} --user-data-dir="${b.dir}" --app=${url}`;

function CopyRow({ label, value }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied`);
    } catch {
      toast.error('Could not copy — select the text and copy it by hand');
    }
  };
  return (
    <div>
      <span className="block text-xs font-medium text-gray-600 mb-1">{label}</span>
      <div className="flex gap-2">
        <input readOnly value={value} className={`${inputCls} font-mono text-xs`} onFocus={(e) => e.target.select()} />
        <Button type="button" variant="outline" onClick={copy} title="Copy"><Copy size={14} /></Button>
      </div>
    </div>
  );
}

// Admin -> Purchase Config -> Barcode Station (migration 098): the shared PIN
// that unlocks the public station page, its sign-in lock, the label page the
// stickers print on -- one sticker's size and (104) how many share a printed
// page, as in the client's BarTender template -- and (migration 100) how the
// station prints: through the browser's print dialog, or straight to the
// printer on kiosk PCs. The PIN is write-only -- the server never sends it
// back, only whether one is set.

// The label page's fields: [state key, API field, caption, BarTender's name].
const PAGE_FIELDS = [
  ['w', 'label_width_mm', 'Sticker width (mm)', 'Template Size width'],
  ['h', 'label_height_mm', 'Sticker height (mm)', 'Template Size height'],
  ['n', 'labels_per_page', 'Stickers per page', 'Layout Rows'],
  ['gap', 'label_gap_mm', 'Gap between (mm)', 'Gap / Pitch vertical'],
  ['margin', 'page_margin_mm', 'Top / bottom margin (mm)', 'Margins top and bottom'],
];
const pageFormOf = (s) => Object.fromEntries(PAGE_FIELDS.map(([k, api]) => [k, String(s[api])]));
export default function BarcodeStationTab() {
  const [settings, setSettings] = useState(null);
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [pinMsg, setPinMsg] = useState('');
  const [size, setSize] = useState(() => Object.fromEntries(PAGE_FIELDS.map(([k]) => [k, ''])));
  const [sizeMsg, setSizeMsg] = useState('');
  const [saving, setSaving] = useState('');
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [browser, setBrowser] = useState('chrome');

  const stationUrl = `${window.location.origin}/barcode-station`;

  const apply = (s) => {
    setSettings(s);
    setSize(pageFormOf(s));
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
    const err = labelSizeError(size.w, size.h) || labelPageError(size.n, size.gap, size.margin, size.h);
    if (err) { setSizeMsg(err); return; }
    setSizeMsg('');
    await save('size', Object.fromEntries(PAGE_FIELDS.map(([k, api]) => [api, Number(size[k])])), 'Label page saved');
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

  // The page the form's values make (blank while they are invalid), and the
  // page saved now.
  const pagePreview = labelSizeError(size.w, size.h) || labelPageError(size.n, size.gap, size.margin, size.h)
    ? null
    : labelPageHeight(size.h, size.n, size.gap, size.margin);
  const savedPageHeight = labelPageHeight(settings.label_height_mm, settings.labels_per_page, settings.label_gap_mm, settings.page_margin_mm);

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

        {/* ---- Label page ---- */}
        <section className={panel}>
          <h3 className="font-semibold text-[#003049] mb-1 flex items-center gap-2"><Ruler size={17} /> Label page</h3>
          <p className="text-sm text-gray-500 mb-3">
            One sticker, landscape, and how many share a printed page — copy them from the roll&apos;s BarTender
            template (Page Setup → Layout). For example, the TSC TA210 roll: 150 × 48.2 mm, 2 per page, 4 mm gap, 1.3 mm margin.
          </p>
          <form onSubmit={saveSize} className="space-y-3" noValidate>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {PAGE_FIELDS.map(([k, , caption, bartender]) => (
                <label key={k} className="block" title={`BarTender: ${bartender}`}>
                  <span className="block text-xs font-medium text-gray-600 mb-1">{caption}</span>
                  <input
                    inputMode={k === 'n' ? 'numeric' : 'decimal'}
                    value={size[k]}
                    onChange={(e) => {
                      const v = e.target.value.replace(k === 'n' ? /\D/g : /[^\d.]/g, '');
                      setSize((s) => ({ ...s, [k]: v }));
                      setSizeMsg('');
                    }}
                    className={inputCls}
                  />
                </label>
              ))}
            </div>
            <p className="text-xs text-gray-600">
              Printer paper:{' '}
              <b>
                {pagePreview ? `${size.w} × ${pagePreview} mm, landscape` : '—'}
              </b>{' '}
              — the same as BarTender&apos;s page. Set the label printer&apos;s paper to this.
            </p>
            {sizeMsg && <p className="text-sm text-[#c1121f]">{sizeMsg}</p>}
            <Button type="submit" variant="secondary" loading={saving === 'size'}>Save label page</Button>
          </form>
        </section>

        {/* ---- Printing ---- */}
        <section className={panel}>
          <div className="flex items-start justify-between gap-3 mb-1">
            <h3 className="font-semibold text-[#003049] flex items-center gap-2"><Printer size={17} /> Printing</h3>
          </div>
          <p className="text-sm text-gray-500 mb-3">
            How the station prints. Warehouse staff never see the stickers on screen either way. Only Admins see keys.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {[
              ['dialog', 'Print dialog', "The browser's print dialog opens. It shows its own preview of the stickers."],
              ['direct', 'Direct (kiosk PCs)', 'Straight to the label printer: no dialog, no preview. Needs the kiosk shortcut below on every station PC.'],
            ].map(([value, title, hint]) => {
              const active = settings.print_mode === value;
              return (
                <button
                  key={value}
                  type="button"
                  disabled={saving === 'mode' || active}
                  onClick={() => save('mode', { print_mode: value }, value === 'direct' ? 'Printing set to direct (kiosk PCs)' : 'Printing set to the print dialog')}
                  className={`text-left rounded-lg border p-3 transition-colors ${active ? 'border-[#c1121f] bg-red-50/50' : 'border-gray-200 hover:border-[#003049]/40'}`}
                >
                  <span className="flex items-center gap-2 text-sm font-semibold text-[#003049]">
                    <span className={`h-3 w-3 rounded-full border-2 ${active ? 'border-[#c1121f] bg-[#c1121f]' : 'border-gray-300'}`} />
                    {title}
                  </span>
                  <span className="block text-xs text-gray-500 mt-1">{hint}</span>
                </button>
              );
            })}
          </div>
          {settings.print_mode === 'direct' && (
            <p className="text-xs text-amber-700 mt-2">
              A PC not opened from the kiosk shortcut will still show the print dialog — the browser decides that, not the portal.
            </p>
          )}
        </section>

        {/* ---- Kiosk setup ---- */}
        <section className={panel}>
          <h3 className="font-semibold text-[#003049] mb-1">Kiosk printing setup (each station PC)</h3>
          <ol className="list-decimal pl-5 text-sm text-gray-600 space-y-1 mb-3">
            <li>Install the label printer, set its paper to the label page ({settings.label_width_mm} × {savedPageHeight} mm, landscape), and make it the <b>Windows default printer</b>.</li>
            <li>Create a desktop shortcut with the <b>calibration</b> target below, open it, unlock the station and print one entry: choose the label printer, margins None, scale 100%, headers and footers off. The browser remembers these.</li>
            <li>Change the shortcut to the <b>kiosk</b> target and name it “Barcode Station”. From now on Print goes straight to the printer.</li>
            <li>When every station PC uses the kiosk shortcut, set Printing to <b>Direct</b> above.</li>
          </ol>
          <div className="flex gap-1 mb-3">
            {Object.entries(BROWSERS).map(([key, b]) => (
              <button
                key={key}
                type="button"
                onClick={() => setBrowser(key)}
                className={`px-3 py-1 rounded-md text-xs font-medium ${browser === key ? 'bg-[#003049] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
              >
                {b.label}
              </button>
            ))}
          </div>
          <div className="space-y-3">
            <CopyRow label="Calibration shortcut (once)" value={shortcutTarget(BROWSERS[browser], stationUrl, false)} />
            <CopyRow label="Kiosk shortcut (everyday)" value={shortcutTarget(BROWSERS[browser], stationUrl, true)} />
          </div>
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
