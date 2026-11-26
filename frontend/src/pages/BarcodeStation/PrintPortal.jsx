import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import Sticker from './Sticker';
import { layoutFor } from './stationHelpers';

const ROOT_ID = 'station-print-root';

// Prints a job's stickers WITHOUT EVER SHOWING THEM (client's rule: only Admins
// see keys). They render into a portal on <body> that is display:none on
// screen. Print CSS shows that portal alone -- everything else on the page is
// hidden on paper -- at the sticker's @page size.
//
// On a kiosk PC (Chrome/Edge started with --kiosk-printing) window.print() goes
// straight to the default printer: no dialog, no preview. In a plain browser
// the print dialog still opens with its own preview -- that is the "dialog"
// print mode, which the app cannot suppress.
//
// `job` = { batch, labels: [{ label_no, label_key, bits }], widthMm, heightMm }.
// `onDone` runs once the print has been handed off, and the parent clears the
// job, which unmounts the stickers again.
export default function PrintPortal({ job, onDone }) {
  // A fresh onDone each parent render must not restart the effect below --
  // that would print the job a second time.
  const onDoneRef = useRef(onDone);
  useEffect(() => { onDoneRef.current = onDone; });

  useEffect(() => {
    if (!job) return undefined;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      onDoneRef.current?.();
    };
    window.addEventListener('afterprint', finish);
    // One tick for the stickers to render, then print. A cleared timeout, not a
    // flag, so StrictMode's double effect still prints exactly once.
    const t = setTimeout(() => {
      window.print();
      // print() returns once the job is sent (kiosk) or the dialog is closed.
      // afterprint normally fires first; this only covers a browser that skips it.
      setTimeout(finish, 500);
    }, 100);
    return () => {
      clearTimeout(t);
      window.removeEventListener('afterprint', finish);
    };
  }, [job]);

  if (!job) return null;
  const layout = layoutFor(job.widthMm, job.heightMm, job.labels[0]?.bits.length || 79);
  return createPortal(
    <div id={ROOT_ID} aria-hidden="true">
      <style>{`
        @media screen { #${ROOT_ID} { display: none !important; } }
        @media print {
          @page { size: ${job.widthMm}mm ${job.heightMm}mm; margin: 0; }
          html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
          body > *:not(#${ROOT_ID}) { display: none !important; }
          #${ROOT_ID} { display: block !important; }
        }
      `}</style>
      {job.labels.map((l, i) => (
        <Sticker
          key={l.label_key}
          batch={job.batch}
          label={l}
          bits={l.bits}
          widthMm={job.widthMm}
          heightMm={job.heightMm}
          layout={layout}
          last={i === job.labels.length - 1}
        />
      ))}
    </div>,
    document.body,
  );
}
