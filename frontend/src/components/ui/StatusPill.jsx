export default function StatusPill({ isCritical }) {
  if (isCritical) {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-700 border border-red-300 animate-pulse">
        <span className="w-1.5 h-1.5 rounded-full bg-red-500 inline-block" />
        CRITICAL
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-green-100 text-green-700 border border-green-300">
      <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
      OK
    </span>
  );
}
