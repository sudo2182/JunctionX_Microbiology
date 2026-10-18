import Link from "next/link";

import type { CurrentVsBaseline } from "@/lib/data/types";
import { fmtCi, fmtPct, PHENOTYPE_LABEL, shortOrganism, SPECIMEN_LABEL } from "@/lib/format";
import { filtersToQuery } from "@/lib/filters";

/** 4-week vs 52-week tile. The arrow is coloured only when the two 95% CIs do not overlap. */
export function KpiTile({ row, abxName }: { row: CurrentVsBaseline; abxName: string }) {
  const marker = PHENOTYPE_LABEL[row.antibiotic_code] ?? `${abxName} R`;
  const href = `/${filtersToQuery({
    organism: row.organism,
    abx: row.antibiotic_code,
    specimen: row.specimen === "all" ? undefined : row.specimen,
    scope: row,
  })}#trend`;
  const up = (row.delta_pp ?? 0) > 0;
  const arrowColor = row.ci_separated ? (up ? "text-critical" : "text-good") : "text-muted";

  return (
    <Link href={href} className="block rounded-lg border border-line bg-surface p-4 hover:border-axis">
      <div className="text-xs text-ink-2">
        {shortOrganism(row.organism)} · {SPECIMEN_LABEL[row.specimen]}
      </div>
      <div className="mb-2 text-sm font-medium">{marker}</div>
      {row.reportable_cur ? (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold">{fmtPct(row.pct_cur)}</span>
            {row.delta_pp != null && row.reportable_base && (
              <span className={`text-sm font-medium ${arrowColor}`} title={row.ci_separated ? "Confidence intervals do not overlap" : "Within the confidence intervals"}>
                {up ? "▲" : "▼"} {Math.abs(row.delta_pp).toFixed(1)} pp
              </span>
            )}
          </div>
          <div className="num text-xs text-muted">
            last {row.window_weeks} wk · {row.x_cur}/{row.n_cur} · CI {fmtCi(row.ci_cur_low, row.ci_cur_high)}
          </div>
        </>
      ) : (
        <div>
          <div className="text-base font-semibold text-ink-2">
            n = {row.n_cur}, too few for a %
          </div>
          <div className="text-xs text-muted">
            {row.x_cur} resistant in the last {row.window_weeks} weeks
          </div>
        </div>
      )}
      <div className="num mt-2 border-t border-line pt-2 text-xs text-ink-2">
        {row.reportable_base ? (
          <>
            52-wk baseline {fmtPct(row.pct_base)} ({row.x_base}/{row.n_base})
          </>
        ) : (
          <>52-wk baseline: n = {row.n_base}, too few for a %</>
        )}
      </div>
    </Link>
  );
}
