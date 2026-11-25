import { useState } from 'react';
import { Eye, EyeOff, KeyRound } from 'lucide-react';
import { startStationSession } from '../../api/station.api';
import { pinError, operatorError, normOperator } from '../../utils/barcodeStation';
import { formatDateTime } from '../../utils/formatters';

const inputCls = 'w-full px-4 py-2.5 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#c1121f]/30 focus:border-[#c1121f] text-sm';

// The station's front door, in the Login page's look. One form asks for the
// shared PIN (when this device has no valid token) and the operator's name
// (remembered per device, changeable later from the header). `note` says why
// the device was signed out -- PIN changed, session expired.
export default function PinScreen({ needsPin, initialOperator, note, onDone }) {
  const [pin, setPin] = useState('');
  const [name, setName] = useState(initialOperator || '');
  const [showPin, setShowPin] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const err = (needsPin && pinError(pin)) || operatorError(name);
    if (err) { setError(err); return; }
    setError('');
    if (!needsPin) { onDone(normOperator(name)); return; }
    setBusy(true);
    try {
      await startStationSession(pin.trim());
      onDone(normOperator(name));
    } catch (ex) {
      const data = ex.response?.data || {};
      setError(data.locked_until
        ? `${data.message} (until ${formatDateTime(data.locked_until)})`
        : (data.message || 'Could not reach the server — check the connection and try again'));
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#fdf0d5] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img src="/logo-wordmark.png" alt="Royal Mart" className="h-16 w-auto object-contain mx-auto mb-4 rounded-lg shadow-lg" />
          <p className="text-[#003049]/60 mt-1">Barcode Station</p>
        </div>

        <div className="bg-white rounded-2xl shadow-xl p-8 border border-[#003049]/10">
          <h2 className="text-xl font-semibold text-[#003049] mb-1 flex items-center gap-2">
            <KeyRound size={20} /> {needsPin ? 'Unlock this station' : 'Who is using this PC?'}
          </h2>
          <p className="text-sm text-gray-500 mb-6">
            {needsPin
              ? 'Enter the station PIN once. This PC stays signed in until the PIN changes.'
              : 'Your name goes on every entry you make here.'}
          </p>

          {note && (
            <div className="mb-4 text-sm rounded-lg bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2">{note}</div>
          )}

          <form onSubmit={submit} className="space-y-4" noValidate>
            {needsPin && (
              <div>
                <label htmlFor="station-pin" className="block text-sm font-medium text-gray-700 mb-1">Station PIN</label>
                <div className="relative">
                  <input
                    id="station-pin"
                    type={showPin ? 'text' : 'password'}
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={8}
                    autoFocus
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                    className={`${inputCls} pr-10 tracking-[0.3em] font-mono`}
                    placeholder="••••"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPin((s) => !s)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
                  >
                    {showPin ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
            )}
            <div>
              <label htmlFor="station-operator" className="block text-sm font-medium text-gray-700 mb-1">Your name</label>
              <input
                id="station-operator"
                type="text"
                autoFocus={!needsPin}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={inputCls}
                placeholder="e.g. Ramesh"
              />
            </div>

            {error && <p className="text-sm text-[#c1121f]">{error}</p>}

            <button
              type="submit"
              disabled={busy}
              className="w-full bg-[#c1121f] text-white py-2.5 rounded-lg font-semibold hover:bg-[#a01019] transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
            >
              {busy && <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />}
              {needsPin ? (busy ? 'Checking…' : 'Unlock') : 'Continue'}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-[#003049]/40 mt-6">Royal Mart ROMS — Barcode Station</p>
      </div>
    </div>
  );
}
