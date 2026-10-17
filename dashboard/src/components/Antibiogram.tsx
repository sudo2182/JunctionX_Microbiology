import Link from "next/link";

import type { Antibiotic, AntibiogramRow, Scope } from "@/lib/data/types";
import { shortOrganism } from "@/lib/format";
import { filtersToQuery } from "@/lib/filters";
import { MIN_N } from "@/lib/stats";

/** Organism rows x antibiotic columns; last 4 weeks with the 12-month value beneath. */
export function Antibiogram({
  rows,
  antibiotics,
  measure,
  scope,
}: {
  rows: AntibiogramRow[];
  antibiotics: Antibiotic[];
  measure: "s" | "r";
  scope: Scope;
}) {
  const codes = antibiotics.map((a) => a.antibiotic_code).filter((c) => rows.some((r) => r.antibiotic_code === c));
  const organisms = [...new Set(rows.map((r) => r.organism))].sort(
    (a, b) => total(rows, b) - total(rows, a),
  );
  const cell = (o: string, c: string) => rows.find((r) => r.organism === o && r.antibiotic_code === c);
  const v = (n: number, s: number) => (measure === "s" ? (s / n) * 100 : ((n - s) / n) * 100);

  if (!rows.length) return <p className="text-sm text-muted">No isolates for this selection.</p>;

  return (
    <div className="overflow-x-auto">
      <table className="num w-full border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            <th className="sticky left-0 bg-surface px-2 py-2 text-left text-xs font-medium text-muted">
              Organism (12-mo n)
            </th>
            {codes.map((c) => (
              <th key={c} className="px-2 py-2 text-center text-xs font-medium text-ink-2" title={antibiotics.find((a) => a.antibiotic_code === c)?.antibiotic}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {organisms.map((o) => (
            <tr key={o}>
              <td className="sticky left-0 border-t border-line bg-surface px-2 py-1.5 italic">
                {shortOrganism(o)} <span className="not-italic text-xs text-muted">({total(rows, o)})</span>
              </td>
              {codes.map((c) => {
                const r = cell(o, c);
                if (!r) return <td key={c} className="border-t border-line px-2 text-center text-muted">—</td>;
                if (r.is_intrinsic)
                  return (
                    <td key={c} className="border-t border-line bg-black/[0.04] px-2 text-center text-xs text-muted" title="Intrinsic resistance: excluded from rates">
                      IR
                    </td>
                  );
                const small = r.n_4w < MIN_N;
                const href = `/explore${filtersToQuery({ organism: o, abx: c, specimen: r.specimen, scope })}`;
                return (
                  <td key={c} className={`border-t border-line px-2 py-1.5 text-center ${small ? "bg-black/[0.03]" : ""}`}>
                    <Link href={href} className="block hover:underline">
                      {small ? (
                        <span className="text-xs text-muted" title="Fewer than 30 isolates in the last 4 weeks">
                          n={r.n_4w}
                        </span>
                      ) : (
                        <span className="font-medium">{Math.round(v(r.n_4w, r.s_4w))}</span>
                      )}
                      <span className="block text-[11px] text-muted">
                        {r.n_52w >= MIN_N ? Math.round(v(r.n_52w, r.s_52w)) : `n=${r.n_52w}`}
                      </span>
                    </Link>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted">
        Cells show {measure === "s" ? "% susceptible" : "% resistant"}: last 4 weeks, with the 12-month value beneath.
        Grey cells have fewer than 30 isolates and show the count instead. IR = intrinsic resistance, excluded.
      </p>
    </div>
  );
}

function total(rows: AntibiogramRow[], organism: string) {
  return Math.max(0, ...rows.filter((r) => r.organism === organism).map((r) => r.n_52w));
}
