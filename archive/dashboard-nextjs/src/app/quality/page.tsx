import { PageTitle, Section } from "@/components/Section";
import { getData } from "@/lib/data";
import { shortOrganism, SPECIMEN_LABEL } from "@/lib/format";
import type { Specimen } from "@/lib/data/types";

export const dynamic = "force-dynamic";

const STATUS_STYLE = {
  pass: { icon: "✓", cls: "text-good" },
  warn: { icon: "!", cls: "text-[#9a6700]" },
  fail: { icon: "✕", cls: "text-critical" },
};

export default async function QualityPage() {
  const data = getData();
  const runs = await data.dataQuality(12);
  const latest = runs[0];

  return (
    <>
      <PageTitle title="Data quality">
        What each weekly replay run released, what the cleaning rules excluded, and whether the validation checks
        passed. A hard failure stops the run before aggregation.
      </PageTitle>

      {latest && (
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="Cultures released" value={latest.cultures_released} note={latest.week_label} />
          <Stat label="Isolates released" value={latest.isolates_released} />
          <Stat label="AST results" value={latest.ast_released} />
          <Stat label="Rows rejected" value={latest.rows_rejected} note="unknown organism or code" />
          <Stat label="Intrinsic R flagged" value={latest.intrinsic_excluded} note="excluded from rates (R1)" />
          <Stat label="Non-reportable" value={latest.non_reportable} note="urine-only agent, other specimen (R2)" />
        </div>
      )}

      <Section title="Runs" subtitle="Most recent first">
        <div className="overflow-x-auto">
          <table className="num w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="py-1.5 pr-3 font-medium">Week</th>
                <th className="py-1.5 pr-3 font-medium">Cultures</th>
                <th className="py-1.5 pr-3 font-medium">Isolates</th>
                <th className="py-1.5 pr-3 font-medium">AST</th>
                <th className="py-1.5 pr-3 font-medium">Rejected</th>
                <th className="py-1.5 pr-3 font-medium">Intrinsic</th>
                <th className="py-1.5 pr-3 font-medium">Checks</th>
                <th className="py-1.5 pr-3 font-medium">Run</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.run_id} className="border-t border-line align-top">
                  <td className="py-1.5 pr-3 font-medium">{r.week_label}</td>
                  <td className="py-1.5 pr-3">{r.cultures_released}</td>
                  <td className="py-1.5 pr-3">{r.isolates_released}</td>
                  <td className="py-1.5 pr-3">{r.ast_released}</td>
                  <td className="py-1.5 pr-3">{r.rows_rejected}</td>
                  <td className="py-1.5 pr-3">{r.intrinsic_excluded}</td>
                  <td className="py-1.5 pr-3">
                    <ul className="space-y-0.5 text-xs">
                      {r.checks.map((c) => (
                        <li key={c.name} title={c.detail}>
                          <span className={`mr-1 font-bold ${STATUS_STYLE[c.status].cls}`}>{STATUS_STYLE[c.status].icon}</span>
                          {c.name}
                          {c.value != null && <span className="text-muted"> ({c.value})</span>}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="py-1.5 pr-3 text-xs">
                    {r.run_url ? (
                      <a href={r.run_url} className="text-accent hover:underline">
                        GitHub run
                      </a>
                    ) : (
                      <span className="text-muted">{r.duration_s != null ? `${r.duration_s}s` : "–"}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {latest && Object.keys(latest.dedup_52w).length > 0 && (
        <Section
          title="First-isolate de-duplication"
          subtitle={`Last 52 weeks to ${latest.week_label}: repeat isolates from the same patient, organism and specimen are removed before any rate (CLSI M39).`}
        >
          <table className="num w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="py-1 font-medium">Organism</th>
                <th className="py-1 font-medium">Specimen</th>
                <th className="py-1 font-medium">All isolates</th>
                <th className="py-1 font-medium">First isolates</th>
                <th className="py-1 font-medium">Removed</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(latest.dedup_52w)
                .sort((a, b) => b[1][0] - a[1][0])
                .map(([k, [all, first]]) => {
                  const [org, spec] = k.split("|");
                  return (
                    <tr key={k} className="border-t border-line">
                      <td className="py-1.5 italic">{shortOrganism(org)}</td>
                      <td>{SPECIMEN_LABEL[spec as Specimen] ?? spec}</td>
                      <td>{all}</td>
                      <td>{first}</td>
                      <td>
                        {all - first} <span className="text-xs text-muted">({Math.round(((all - first) / all) * 100)}%)</span>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </Section>
      )}
    </>
  );
}

function Stat({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="text-xs text-ink-2">{label}</div>
      <div className="num text-2xl font-semibold">{value.toLocaleString("en-GB")}</div>
      {note && <div className="text-xs text-muted">{note}</div>}
    </div>
  );
}
