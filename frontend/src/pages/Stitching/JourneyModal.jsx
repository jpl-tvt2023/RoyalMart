import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import Modal from '../../components/ui/Modal';
import Badge from '../../components/ui/Badge';
import { getStitchingJourney } from '../../api/stitching.api';
import { STATUS_COLORS, fmtNum } from '../../utils/stitching';
import { formatDateTime } from '../../utils/formatters';

// A number that reads as a quantity, with the unit attached once.
const metres = (v) => `${fmtNum(v)} m`;

/**
 * The full lineage of a lot — the PO receipt it entered on, then every stage it
 * passed through, down to Packed.
 *
 * Rendered as a vertical timeline rather than a table on purpose. The question
 * this answers is "what happened to this material", which is a sequence, and a
 * table would scatter the arithmetic of each hop across columns instead of
 * putting it on the arrow where it belongs.
 */
export default function JourneyModal({ src, id, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getStitchingJourney(src, id)
      .then(d => { if (!cancelled) setData(d); })
      .catch(err => {
        if (cancelled) return;
        toast.error(err.response?.data?.message || 'Could not load the journey');
        onClose();
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, id]);

  const s = data?.summary;

  return (
    <Modal isOpen onClose={onClose} title="Journey" size="xl">
      {loading && (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => <div key={i} className="h-14 bg-gray-100 rounded animate-pulse" />)}
        </div>
      )}

      {!loading && data && (
        <>
          <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 mb-5">
            <div className="font-medium text-[#003049]">
              {s.article}{s.variant ? ` — ${s.variant}` : ''}
            </div>
            <div className="text-xs text-gray-500 mt-0.5">
              origin PO {s.po_order_no}
              {s.origin_incoming_no ? ` · ${s.origin_incoming_no}` : ''}
            </div>
          </div>

          <ol className="relative">
            {data.nodes.map((n, i) => {
              const prev = data.nodes[i - 1];
              // The connector belongs between two hops, and carries the
              // arithmetic of the move rather than burying it in a column.
              const showConnector = i > 0 && n.sent_qty != null;
              return (
                <li
                  key={n.lot_key}
                  style={{ marginLeft: `${n.depth * 20}px` }}
                  className={n.deleted ? 'opacity-60' : ''}
                >
                  {showConnector && (
                    <div className="flex items-center gap-2 py-1.5 pl-1 text-xs text-gray-500">
                      <span className="text-gray-300">│</span>
                      <span>sent <span className="font-medium text-gray-700">{metres(n.sent_qty)}</span></span>
                      <span className="text-gray-300">→</span>
                      <span>received <span className="font-medium text-gray-700">{metres(n.metre)}</span></span>
                      {/* Silent on a clean hop — only a real loss earns ink. */}
                      {n.loss > 0 && (
                        <span className="text-amber-600 font-medium">loss {metres(n.loss)}</span>
                      )}
                      {prev && prev.depth === n.depth && (
                        <span className="text-gray-400">· split from the same lot</span>
                      )}
                    </div>
                  )}

                  <div
                    className={`rounded-lg border px-4 py-3 ${
                      n.is_anchor ? 'border-[#c1121f] bg-[#c1121f]/[0.03]' : 'border-gray-200 bg-white'
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-3 flex-wrap">
                      <div className="flex items-baseline gap-2 min-w-0">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 w-20 shrink-0">
                          {n.stage}
                        </span>
                        <span className={`font-medium text-[#003049] truncate ${n.deleted ? 'line-through' : ''}`}>
                          {n.party_name}
                        </span>
                        {n.incoming_prefix || n.incoming_no ? (
                          <span className="font-mono text-[11px] text-gray-400">
                            {n.incoming_prefix || ''}{n.incoming_no || ''}
                          </span>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="font-semibold text-[#003049]">{metres(n.metre)}</span>
                        {n.deleted
                          ? <Badge color="gray">Removed</Badge>
                          : <Badge color={STATUS_COLORS[n.status] || 'gray'}>{n.status}</Badge>}
                      </div>
                    </div>

                    {n.deleted ? (
                      <div className="mt-1 text-[11px] text-gray-400">
                        removed by {n.deleted_by_name || 'unknown'} · {formatDateTime(n.deleted_at)}
                      </div>
                    ) : (
                      <div className="mt-1 flex items-center gap-3 flex-wrap text-[11px] text-gray-500">
                        {/* The rate arithmetic, spelled out rather than left for
                            the reader to work back from three columns. */}
                        <span>
                          {fmtNum(n.rate)}
                          {Number(n.process_rate) > 0 && <> + {fmtNum(n.process_rate)} process</>}
                          {' = '}
                          <span className="font-semibold text-[#003049]">{fmtNum(n.after_rate)}</span>
                        </span>
                        {n.bill_no && <span>bill {n.bill_no}</span>}
                        {n.challan_no && <span>challan {n.challan_no}</span>}
                        {n.checked_by_name && <span>checked by {n.checked_by_name}</span>}
                        {n.closed_at && (
                          <span className="text-gray-400">
                            closed by {n.closed_by_name || 'unknown'} · {formatDateTime(n.closed_at)}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>

          <div className="mt-5 pt-4 border-t border-gray-200 flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-600">
            <span>
              <span className="text-gray-400">in</span> {metres(s.origin_metre)}
              <span className="text-gray-300"> → </span>
              <span className="text-gray-400">packed</span> {metres(s.packed_metre)}
            </span>
            {s.total_loss > 0 && (
              <span className="text-amber-600 font-medium">total loss {metres(s.total_loss)}</span>
            )}
            {s.final_rate != null && (
              <span>
                <span className="text-gray-400">rate</span> {fmtNum(s.origin_rate)}
                <span className="text-gray-300"> → </span>
                <span className="font-semibold text-[#003049]">{fmtNum(s.final_rate)}</span>
              </span>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
