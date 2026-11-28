import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  Camera, ScanLine, CircleCheck, CircleX, Info, CloudOff, Loader2, Moon,
} from 'lucide-react';
import Button from '../../components/ui/Button';
import CameraScanner from './CameraScanner';
import { inputCls, beep, unlockAudio } from './stationHelpers';
import { getTodayCount, sendScans } from '../../api/station.api';
import { keyError, articleLabel, packSizeLabel } from '../../utils/barcodeStation';
import { enqueue, nextBatch, removeSent, loadQueue, saveQueue } from '../../utils/scanQueue';
import { formatDate, formatDateTime } from '../../utils/formatters';

// The daily stock count on the public station (migrations 102, 103).
//
// THE COUNT IS THE DAY. There is no Start and no Close: pick the floor you are
// on and scan every pack -- with a scanner gun (it types into the scan box and
// presses Enter) or the phone's camera. The day's first scan creates today's
// count, every scan that day joins it (evening deliveries too), and at
// midnight IST the day is finished: a pack seen before and not scanned today
// is Out from tomorrow.
//
// Every scan goes through a queue kept in localStorage (utils/scanQueue.js)
// and is sent from there, so nothing is lost when the Wi-Fi drops or the page
// reloads. Re-sending is harmless: the server keeps one scan per sticker per
// day.
//
// LOCATION COMES FROM THE SCAN (client, 2026-11-27). An entry has no floor, so
// a pack has none until its first scan, which puts it on the floor picked
// here. ONE SCAN PER PACK PER DAY: the first stands, and every later scan that
// day is rejected (grey card, naming the floor it was counted on), on any
// floor. The card says counted (and where it moved from, when the pack was
// last on another floor) / already scanned today / not our sticker -- nothing
// is flagged. It never says a pack had been Out: missed scans are the
// scanner's mistakes, for Admin/Owner only.

const FLOOR_KEY = 'roms:barcodeStation:countFloor';
const RETRY_MS = 3000;
const PROGRESS_EVERY_MS = 4000;
const RECENT_MAX = 8;
const ARTICLES_SHOWN = 6;

function readFloor() {
  try { return Number(localStorage.getItem(FLOOR_KEY)) || ''; } catch { return ''; }
}
function writeFloor(id) {
  try {
    if (id) localStorage.setItem(FLOOR_KEY, String(id));
    else localStorage.removeItem(FLOOR_KEY);
  } catch { /* storage unavailable */ }
}

// A PC with a gun gets the cursor straight away. A phone does not: focusing
// the box would pop its keyboard over the camera.
const finePointer = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: fine)').matches;

const CARD_STYLE = {
  ok:    { cls: 'bg-green-50 border-green-300 text-green-900', Icon: CircleCheck },
  info:  { cls: 'bg-slate-50 border-slate-300 text-slate-800', Icon: Info },
  error: { cls: 'bg-red-50 border-red-300 text-red-900', Icon: CircleX },
  wait:  { cls: 'bg-white border-gray-200 text-gray-700', Icon: Loader2 },
};
const LOUDEST = ['error', 'ok', 'info'];

function cardFor(result) {
  if (result.status === 'unknown') {
    return { kind: 'error', title: 'Not one of our stickers', detail: `Key ${result.key} is on no label. Put this pack aside and tell an Admin.` };
  }
  const p = result.pack;
  const line = `${p.vendor_name} · ${articleLabel(p)} · pack of ${packSizeLabel(p)} · label ${p.label_no} of ${p.label_count}`;
  if (result.status === 'already_counted') {
    return {
      kind: 'info',
      title: `Already scanned today${result.counted_on ? ` on ${result.counted_on}` : ''} — not counted again`,
      detail: line,
    };
  }
  if (result.moved_from) {
    return { kind: 'ok', title: `Counted — moved here from ${result.moved_from}`, detail: line };
  }
  return { kind: 'ok', title: 'Counted', detail: line };
}

export default function StockCountPanel({ operator, floors }) {
  const [data, setData] = useState(null); // { today, count, progress, last_finished }
  const [loading, setLoading] = useState(true);
  const [floorId, setFloorId] = useState(readFloor);
  const [keyInput, setKeyInput] = useState('');
  const [card, setCard] = useState(null);
  const [recent, setRecent] = useState([]);
  const [pending, setPending] = useState(() => loadQueue().length);
  const [offline, setOffline] = useState(false);
  const [camera, setCamera] = useState(false);
  const [allArticles, setAllArticles] = useState(false);

  const queueRef = useRef(null);
  const sendingRef = useRef(false);
  const lastProgressRef = useRef(0);
  const progressTimerRef = useRef(null);
  const inputRef = useRef(null);
  const flushRef = useRef(() => {});

  const floor = floors.find((f) => f.id === Number(floorId)) || null;
  const count = data?.count || null;

  const setQueue = (next) => {
    queueRef.current = next;
    saveQueue(next);
    setPending(next.length);
  };

  const load = useCallback(() => getTodayCount()
    .then((d) => { setData(d); lastProgressRef.current = Date.now(); })
    .catch((err) => { if (err.response?.status !== 401) toast.error(err.response?.data?.message || 'Could not load the stock count'); })
    .finally(() => setLoading(false)), []);

  // Progress is a heavier read than a scan: refresh it at most every few
  // seconds while scans stream in.
  const refreshSoon = useCallback(() => {
    if (progressTimerRef.current) return;
    const wait = Math.max(0, PROGRESS_EVERY_MS - (Date.now() - lastProgressRef.current));
    progressTimerRef.current = setTimeout(() => { progressTimerRef.current = null; load(); }, wait);
  }, [load]);

  // Send the next group from the queue, then keep going until it is empty.
  const flush = async () => {
    if (sendingRef.current) return;
    const batch = nextBatch(queueRef.current);
    if (!batch) return;
    sendingRef.current = true;
    let again = false;
    try {
      const res = await sendScans(batch);
      setQueue(removeSent(queueRef.current, batch));
      setOffline(false);
      const stamp = Date.now();
      const cards = res.results.map((r) => ({ ...cardFor(r), id: `${r.key}:${stamp}` }));
      if (cards.length) {
        setCard(cards[cards.length - 1]);
        setRecent((prev) => [...cards.slice().reverse(), ...prev].slice(0, RECENT_MAX));
        beep(LOUDEST.find((k) => cards.some((c) => c.kind === k)));
      }
      // The day's first scan creates today's count -- show it at once.
      setData((d) => (d ? {
        ...d,
        count: res.count || d.count,
        progress: d.progress ? { ...d.progress, scanned: res.scanned } : d.progress,
      } : d));
      refreshSoon();
      again = queueRef.current.length > 0;
    } catch (err) {
      const status = err.response?.status;
      if (!err.response) {
        setOffline(true); // retried on the timer
      } else if (status === 400) {
        setQueue(removeSent(queueRef.current, batch));
        toast.error(err.response.data?.message || 'Some scans were refused');
        again = queueRef.current.length > 0;
      }
      // 401: the station signs out and shows the PIN screen. The queue waits in
      // storage and is sent once the device is unlocked again. 5xx: retried.
    } finally {
      sendingRef.current = false;
    }
    if (again) flushRef.current();
  };

  useEffect(() => { flushRef.current = flush; });

  useEffect(() => {
    queueRef.current = loadQueue();
    load();
    const timer = setInterval(() => flushRef.current(), RETRY_MS);
    flushRef.current();
    return () => { clearInterval(timer); clearTimeout(progressTimerRef.current); };
  }, [load]);

  // Once, when the panel is ready -- progress reloads every few seconds must
  // not pull the cursor out of the floor picker.
  useEffect(() => {
    if (!loading && finePointer()) inputRef.current?.focus();
  }, [loading]);

  // A gun types like a keyboard. If the cursor has wandered off (a click on the
  // page, the camera button), its digits would land nowhere, so a digit typed
  // while no field is focused moves the cursor back to the scan box first --
  // the keystroke then lands in it.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || !/^[0-9]$/.test(e.key)) return;
      const el = document.activeElement;
      if (el && (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) || el.isContentEditable)) return;
      inputRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const handleKey = (raw) => {
    const key = String(raw || '').trim();
    if (!key) return;
    if (!floor) {
      setCard({ kind: 'error', title: 'Pick your floor first', detail: 'Choose the floor you are scanning on, then scan again.' });
      beep('error');
      return;
    }
    const err = keyError(key);
    if (err) {
      setCard({ kind: 'error', title: 'Not a sticker key', detail: `${err} — the scanner read “${key.slice(0, 24)}”.` });
      beep('error');
      return;
    }
    const { queue, added } = enqueue(queueRef.current, { floor_id: floor.id, operator, key });
    if (!added) {
      setCard({ kind: 'info', title: 'Already scanned', detail: `Key ${key} is waiting to be sent.` });
      beep('info');
      return;
    }
    setQueue(queue);
    setCard({ kind: 'wait', title: 'Sending…', detail: `Key ${key}` });
    flushRef.current();
  };

  const onSubmitKey = (e) => {
    e.preventDefault();
    unlockAudio(); // the first Enter is a user gesture: sound can start
    const v = keyInput;
    setKeyInput('');
    handleKey(v);
    inputRef.current?.focus();
  };

  // The floor is required: a scan with none is refused here and by the server.
  // Clearing it also closes the camera, which would otherwise keep reading
  // stickers only to refuse them.
  const pickFloor = (v) => {
    unlockAudio();
    const id = v ? Number(v) : '';
    setFloorId(id);
    writeFloor(id);
    if (!id) setCamera(false);
  };

  if (loading) {
    return <section className="bg-white rounded-xl border border-gray-200 p-6 text-sm text-gray-500">Loading the stock count…</section>;
  }

  const p = data?.progress || { scanned: 0, expected: 0, found: 0, to_go: 0, by_floor: [], by_article: [] };
  const articlesToGo = p.by_article.filter((a) => a.to_go > 0);
  const style = card ? CARD_STYLE[card.kind] : null;
  const CardIcon = style?.Icon;
  const todayLabel = data?.today ? formatDate(data.today) : 'Today';

  return (
    <div className="space-y-4">
      <section className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold text-[#003049]">Today’s count · {todayLabel}</h2>
          <p className="text-xs text-gray-500">
            {count
              ? `Started ${formatDateTime(count.started_at)} by ${count.started_by}`
              : 'Scan any pack to start today’s count'}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-end">
          <label className="block">
            <span className="block text-xs font-medium text-gray-600 mb-1">
              I am scanning on <span className="text-[#c1121f]" aria-hidden="true">*</span>
            </span>
            <select
              value={floor ? floor.id : ''}
              onChange={(e) => pickFloor(e.target.value)}
              required
              className={`${inputCls} min-h-[44px] ${floor ? '' : 'border-[#c1121f]'}`}
            >
              <option value="">Pick your floor…</option>
              {floors.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </label>

          <form onSubmit={onSubmitKey} className="block">
            <span className="block text-xs font-medium text-gray-600 mb-1">Scan a sticker (or type its 8 digits and press Enter)</span>
            <div className="relative">
              <ScanLine size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                ref={inputRef}
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value.slice(0, 40))}
                inputMode="numeric"
                autoComplete="off"
                placeholder="Scan here"
                className={`${inputCls} min-h-[44px] pl-10 font-mono text-base`}
              />
            </div>
          </form>

          {/* The scan box above stays enabled with no floor: a gun types into it,
              and a disabled box would drop its digits silently. handleKey's
              "Pick your floor first" card and beep are the gun's feedback. The
              camera, though, waits for a floor (an open one can still close). */}
          <Button
            type="button"
            variant={camera ? 'secondary' : 'outline'}
            onClick={() => { unlockAudio(); setCamera((c) => !c); }}
            disabled={!floor && !camera}
            title={!floor && !camera ? 'Pick your floor first' : undefined}
            className="min-h-[44px]"
          >
            <Camera size={18} /> {camera ? 'Close camera' : 'Scan with camera'}
          </Button>
        </div>

        {camera && <CameraScanner onKey={handleKey} onClose={() => setCamera(false)} />}

        {card && (
          <div className={`flex items-start gap-3 rounded-xl border-2 p-4 ${style.cls}`} role="status" aria-live="polite">
            <CardIcon size={28} className={`shrink-0 ${card.kind === 'wait' ? 'animate-spin' : ''}`} />
            <div className="min-w-0">
              <p className="text-lg font-semibold leading-tight">{card.title}</p>
              <p className="text-sm mt-1 break-words">{card.detail}</p>
            </div>
          </div>
        )}

        {(pending > 0 || offline) && (
          <div className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${offline ? 'bg-amber-50 text-amber-800' : 'bg-gray-50 text-gray-600'}`}>
            {offline ? <CloudOff size={16} /> : <Loader2 size={16} className="animate-spin" />}
            {offline
              ? `No connection — ${pending} scan${pending !== 1 ? 's' : ''} waiting. Keep scanning: they are saved on this device and will be sent when the connection is back.`
              : `${pending} waiting to send…`}
          </div>
        )}

        <p className="flex items-start gap-2 text-xs text-gray-500">
          <Moon size={14} className="mt-0.5 shrink-0" />
          <span>
            Scan any time — goods that arrive in the evening join today’s count. The count finishes at midnight:
            a pack not scanned today shows as Out tomorrow.
          </span>
        </p>
      </section>

      {/* ---- Progress ---- */}
      <section className="bg-white rounded-xl border border-gray-200 p-4 space-y-4">
        <div className="grid grid-cols-3 gap-2 text-center">
          <Stat label="Scanned today" value={p.scanned} />
          <Stat label="Expected" value={p.expected} hint="in stock or new" />
          <Stat label="To go" value={p.to_go} strong={p.to_go > 0} />
        </div>

        {p.by_floor.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">
                <tr>
                  <th className="px-3 py-2">Floor</th>
                  <th className="px-3 py-2 text-right">Expected</th>
                  <th className="px-3 py-2 text-right">Found</th>
                  <th className="px-3 py-2 text-right">To go</th>
                </tr>
              </thead>
              <tbody>
                {p.by_floor.map((f) => (
                  <tr key={f.floor_id ?? 'none'} className={`border-b border-gray-100 ${floor?.id === f.floor_id ? 'bg-[#fdf0d5]/60' : ''}`}>
                    <td className="px-3 py-2">
                      {f.floor_id == null ? (
                        <span className="font-medium text-gray-500" title="Packs never scanned have no floor yet — their first scan places them">Not scanned yet</span>
                      ) : (
                        <span className="font-medium text-[#003049]">{f.floor_name}</span>
                      )}
                      {f.floor_id != null && f.expected > 0 && f.scanned_here === 0 && (
                        <span className="ml-2 inline-block rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">
                          nothing scanned yet
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{f.expected}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{f.found}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${f.to_go > 0 ? 'font-semibold text-[#c1121f]' : 'text-green-700'}`}>{f.to_go}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {articlesToGo.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">Still to find today</p>
            <ul className="divide-y divide-gray-100 text-sm">
              {(allArticles ? articlesToGo : articlesToGo.slice(0, ARTICLES_SHOWN)).map((a) => (
                <li key={a.article_id} className="flex justify-between gap-3 py-1.5">
                  <span className="text-gray-700 min-w-0 break-words">{a.article}</span>
                  <span className="tabular-nums text-[#c1121f] font-medium whitespace-nowrap">{a.to_go} of {a.expected}</span>
                </li>
              ))}
            </ul>
            {articlesToGo.length > ARTICLES_SHOWN && (
              <button type="button" onClick={() => setAllArticles((v) => !v)} className="mt-1 text-xs font-medium text-[#003049] hover:underline">
                {allArticles ? 'Show fewer' : `Show all ${articlesToGo.length}`}
              </button>
            )}
          </div>
        )}

        {data?.last_finished && (
          <p className="text-xs text-gray-500">Last finished count: {formatDate(data.last_finished.count_date)}.</p>
        )}
      </section>

      {recent.length > 0 && (
        <section className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">Last scans</p>
          <ul className="space-y-1.5 text-sm">
            {recent.map((r) => {
              const RowIcon = CARD_STYLE[r.kind].Icon;
              return (
                <li key={r.id} className="flex items-start gap-2">
                  <RowIcon size={16} className={`mt-0.5 shrink-0 ${r.kind === 'ok' ? 'text-green-600' : r.kind === 'error' ? 'text-red-600' : 'text-slate-500'}`} />
                  <span className="min-w-0 break-words"><span className="font-medium">{r.title}</span> <span className="text-gray-500">· {r.detail}</span></span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, hint, strong }) {
  return (
    <div className="rounded-lg bg-gray-50 px-2 py-3">
      <p className={`text-2xl sm:text-3xl font-bold tabular-nums ${strong ? 'text-[#c1121f]' : 'text-[#003049]'}`}>{value}</p>
      <p className="text-xs text-gray-600">{label}</p>
      {hint && <p className="text-[11px] text-gray-400">{hint}</p>}
    </div>
  );
}
