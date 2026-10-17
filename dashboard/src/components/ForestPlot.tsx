import type { WardComparisonRow } from "@/lib/data/types";
import { C } from "@/lib/theme";

/** One row per ward: %R with Wilson CI, vertical line at the hospital rate. Wards under n = 30 show counts only. */
export function ForestPlot({ rows }: { rows: WardComparisonRow[] }) {
  const ok = rows.filter((r) => r.reportable).sort((a, b) => (b.pct_r ?? 0) - (a.pct_r ?? 0));
  const small = rows.filter((r) => !r.reportable && r.n_tested > 0);
  const none = rows.filter((r) => r.n_tested === 0);
  const hosp = rows[0]?.hospital_pct_r ?? null;
  const max = Math.max(10, ...ok.map((r) => r.wilson_high ?? 0), hosp ?? 0);
  const niceMax = Math.ceil(max / 5) * 5;
  const W = 640;
  const L = 170;
  const R = 110;
  const rowH = 28;
  const H = ok.length * rowH + 34;
  const x = (v: number) => L + ((W - L - R) * v) / niceMax;
  const ticks = Array.from({ length: 6 }, (_, i) => (niceMax / 5) * i);

  return (
    <div>
      {ok.length > 0 ? (
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Forest plot of percent resistant by ward">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={8} y2={H - 22} stroke={C.grid} />
              <text x={x(t)} y={H - 6} textAnchor="middle" fontSize={11} fill={C.muted}>
                {t}%
              </text>
            </g>
          ))}
          {hosp != null && (
            <g>
              <line x1={x(hosp)} x2={x(hosp)} y1={4} y2={H - 22} stroke={C.ink2} strokeDasharray="4 3" strokeWidth={1.5} />
              <text x={x(hosp) + 4} y={12} fontSize={10} fill={C.ink2}>
                hospital {hosp.toFixed(1)}%
              </text>
            </g>
          )}
          {ok.map((r, i) => {
            const y = 26 + i * rowH;
            return (
              <g key={r.ward_code}>
                <title>{`${r.ward_name}: ${r.pct_r!.toFixed(1)}% (${r.n_resistant} of ${r.n_tested}), 95% CI ${r.wilson_low!.toFixed(1)}–${r.wilson_high!.toFixed(1)}%`}</title>
                <rect x={0} y={y - rowH / 2} width={W} height={rowH} fill="transparent" />
                <text x={L - 10} y={y + 4} textAnchor="end" fontSize={12} fill={C.ink}>
                  {r.ward_name}
                </text>
                <line x1={x(r.wilson_low!)} x2={x(r.wilson_high!)} y1={y} y2={y} stroke={C.series1} strokeWidth={2} strokeLinecap="round" />
                <circle cx={x(r.pct_r!)} cy={y} r={5} fill={C.series1} stroke={C.surface} strokeWidth={2} />
                <text x={W - R + 8} y={y + 4} fontSize={11} fill={C.ink2} className="num">
                  {r.pct_r!.toFixed(1)}% · n={r.n_tested}
                </text>
              </g>
            );
          })}
        </svg>
      ) : (
        <p className="text-sm text-muted">No ward reaches 30 isolates in this window. Try a longer window.</p>
      )}
      {small.length > 0 && (
        <p className="mt-2 text-xs text-ink-2">
          <span className="text-muted">Too few for a % (n &lt; 30): </span>
          {small.map((r) => `${r.ward_name} ${r.n_resistant}/${r.n_tested}`).join(" · ")}
        </p>
      )}
      {none.length > 0 && <p className="mt-1 text-xs text-muted">No isolates: {none.map((r) => r.ward_name).join(", ")}</p>}
    </div>
  );
}
