export function DowntimeTypeBadge({ type }: { type: string | null }) {
  if (!type) return <span className="text-slate-400">—</span>;
  const lower = type.toLowerCase();
  let cls = 'bg-slate-100 text-slate-700';
  if (lower === 'unplanned') cls = 'bg-red-100 text-red-700';
  else if (lower === 'planned') cls = 'bg-blue-100 text-blue-700';
  else if (lower === 'setup') cls = 'bg-yellow-100 text-yellow-700';
  else if (lower === 'running_slow') cls = 'bg-lime-200 text-lime-900';
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-bold ${cls}`}>
      {type}
    </span>
  );
}
