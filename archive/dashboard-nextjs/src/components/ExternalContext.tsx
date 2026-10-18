import type { ExternalContextRow } from "@/lib/data/types";

const SPECIMEN_TITLE: Record<string, string> = {
  blood_csf: "Invasive (blood / CSF)",
  carriage: "Carriage (screening)",
};
const GEOS = [
  { name: "Finland", label: "Finland" },
  { name: "Southwest Finland wellbeing services county", label: "Southwest Finland (TYKS area)" },
];

/**
 * THL national register, notified cases and incidence per 100,000 for one phenotype marker.
 * These are case counts, not the share of isolates that are resistant, so they sit beside the
 * hospital rates and are never plotted on the same axis.
 */
export function ExternalContext({ rows }: { rows: ExternalContextRow[] }) {
  if (rows.length === 0) {
    return <p className="text-xs text-muted">No THL register data loaded for this marker.</p>;
  }
  const groups = new Map<string, ExternalContextRow[]>();
  for (const r of rows) {
    const key = `${r.organism}|${r.specimen}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const value = (g: ExternalContextRow[], geo: string, year: number, indicator: string) =>
    g.find((r) => r.geo_name === geo && r.year === year && r.indicator === indicator)?.value;
  const first = rows[0];

  return (
    <div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {[...groups.entries()].map(([key, g]) => {
          const years = [...new Set(g.map((r) => r.year))].sort((a, b) => b - a);
          return (
            <div key={key}>
              <h3 className="mb-1 text-sm font-medium">
                <i>{g[0].organism}</i> · {SPECIMEN_TITLE[g[0].specimen] ?? g[0].specimen}
              </h3>
              <table className="num w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted">
                    <th className="py-1 font-medium">Year</th>
                    {GEOS.map((geo) => (
                      <th key={geo.name} className="py-1 font-medium">
                        {geo.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {years.map((y) => (
                    <tr key={y} className="border-t border-line">
                      <td className="py-1.5">{y}</td>
                      {GEOS.map((geo) => {
                        const cases = value(g, geo.name, y, "cases");
                        const inc = value(g, geo.name, y, "incidence_per_100k");
                        return (
                          <td key={geo.name}>
                            <span className="font-medium">{cases ?? "–"}</span>
                            <span className="text-xs text-ink-2">
                              {" "}
                              cases{inc != null ? ` · ${inc.toFixed(1)} per 100k` : ""}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-ink-2">
        Notified cases, whole calendar years, from the national register. This is not a % resistant, so it is not
        comparable with the hospital rates above. {first.attribution} Licence: {first.licence}. Retrieved{" "}
        {first.retrieved_at.slice(0, 10)}.
      </p>
    </div>
  );
}
