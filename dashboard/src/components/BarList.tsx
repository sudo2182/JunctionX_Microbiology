/** Horizontal bars for a small categorical breakdown; labels and values in ink, bar carries magnitude only. */
export function BarList({ items, total }: { items: [string, number][]; total?: number }) {
  const max = Math.max(1, ...items.map(([, v]) => v));
  const sum = total ?? items.reduce((a, [, v]) => a + v, 0);
  return (
    <ul className="space-y-1.5">
      {items.map(([label, v]) => (
        <li key={label} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-xs">
          <span className="truncate text-ink-2" title={label}>
            {label}
          </span>
          <span className="h-2.5 rounded-r bg-[#2a78d6]" style={{ width: `${(v / max) * 100}%` }} />
          <span className="num text-ink">
            {v} <span className="text-muted">({Math.round((v / sum) * 100)}%)</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
