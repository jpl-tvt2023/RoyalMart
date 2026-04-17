import { useEffect, useState } from 'react';
import { X, Clock } from 'lucide-react';
import { formatDateTime } from '../../utils/formatters';

export default function AuditDrawer({ isOpen, onClose, title, fetchFn }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen && fetchFn) {
      setLoading(true);
      fetchFn()
        .then(({ data }) => setLogs(data))
        .catch(() => setLogs([]))
        .finally(() => setLoading(false));
    }
  }, [isOpen, fetchFn]);

  return (
    <>
      {isOpen && <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />}
      <div className={`fixed top-0 right-0 h-full z-50 w-full max-w-sm bg-white shadow-2xl transform transition-transform duration-300 flex flex-col ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-[#003049]">
          <div className="flex items-center gap-2 text-white">
            <Clock size={18} />
            <h3 className="font-semibold text-sm">{title || 'Audit History'}</h3>
          </div>
          <button onClick={onClose} className="text-white/70 hover:text-white p-1">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {loading && (
            <div className="flex justify-center py-8">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[#c1121f]" />
            </div>
          )}
          {!loading && logs.length === 0 && (
            <p className="text-center text-gray-400 text-sm py-8">No history found</p>
          )}
          {!loading && logs.map((log, i) => (
            <div key={log.id || i} className="mb-4 pl-4 border-l-2 border-[#c1121f]/30 relative">
              <div className="absolute -left-[5px] top-1 w-2 h-2 rounded-full bg-[#c1121f]" />
              <p className="text-xs text-gray-400">{formatDateTime(log.timestamp)}</p>
              <p className="text-xs font-semibold text-[#003049] mt-0.5">{log.user_name || 'System'}</p>
              <p className="text-xs text-gray-500 mt-0.5">{log.description || log.action_type}</p>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
