import { FilterBar } from "@/components/FilterBar";
import { ExternalContext } from "@/components/ExternalContext";
import { ForestPlot } from "@/components/ForestPlot";
import { Heatmap } from "@/components/Heatmap";
import { PageTitle, Section } from "@/components/Section";
import { TrendChart } from "@/components/TrendChart";
import { getData } from "@/lib/data";
import { PHENOTYPE_CODES, type Combo, type RateRow, type Scope, type Specimen } from "@/lib/data/types";
import { fmtCi, fmtPct, ONSET_LABEL, PHENOTYPE_LABEL, scopeLabel, SETTING_LABEL, shortOrganism, SPECIMEN_LABEL } from "@/lib/format";
import { parseFilters, SPECIMENS, type SearchParams } from "@/lib/filters";
import { MIN_N } from "@/lib/stats";

export const dynamic = "force-dynamic";

export default async function ExplorePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const data = getData();
  const [ref, status] = await Promise.all([data.ref(), data.replayStatus()]);
  const f = parseFilters(sp, ref.organisms);
  const combo: Combo = { organism: f.organism, antibiotic_code: f.abx, specimen: f.specimen };
  const abxName = (c: string) => ref.antibiotics.find((a) => a.antibiotic_code === c)?.antibiotic ?? c;
  const markerName = PHENOTYPE_LABEL[f.abx] ?? `${abxName(f.abx)} resistance`;
  const where = scopeLabel(f.scope, ref.wards);
  const smallWindow = Math.max(f.window, 13);

  const splitScopes: Scope[] = [
    ...Object.keys(SETTING_LABEL).map((v) => ({ scope_type: "setting" as const, scope_value: v })),
    ...Object.keys(ONSET_LABEL).map((v) => ({ scope_type: "onset" as const, scope_value: v })),
  ];
  const hasRegister = (PHENOTYPE_CODES as readonly string[]).includes(f.abx);
  const [cells, wards, trend, bySpecimen, yearly, splits, register] = await Promise.all([
    data.heatmap(f.specimen, f.scope, f.window),
    data.wardComparison(combo, f.window),
    data.rateSeries(combo, f.scope, f.window),
    Promise.all(
      SPECIMENS.map((s) => data.rateSeries({ ...combo, specimen: s as Specimen }, f.scope, smallWindow)),
    ),
    data.rateSeries(combo, f.scope, 52),
    Promise.all(splitScopes.map((s) => data.rateSeries(combo, s, 52).then((r) => r.at(-1)))),
    hasRegister ? data.externalContext(f.abx, 2019) : Promise.resolve([]),
  ]);

  // Codes in the reference order; urine-only agents only for urine.
  const codes = ref.antibiotics
    .filter((a) => f.specimen === "urine" || a.reported_for === "all")
    .map((a) => a.antibiotic_code)
    .filter((c) => cells.some((x) => x.antibiotic_code === c));

  // Annual first-isolate rates: 52-week windows ending at each anniversary of the dataset start.
  const years = [52, 104, 156]
    .filter((w) => w <= status.cursor_week_idx)
    .map((w, i) => ({ name: `Year ${i + 1}`, row: yearly[w - 1] }));
  if (status.cursor_week_idx % 52 !== 0) years.push({ name: "Last 52 weeks", row: yearly.at(-1)! });

  return (
    <>
      <PageTitle title="Resistance exploration">
        Compare organisms, antibiotics, wards and specimens. Click a heatmap cell to drill into that combination.
      </PageTitle>
      <FilterBar
        filters={f}
        wards={ref.wards}
        organisms={ref.organisms}
        antibiotics={ref.antibiotics}
        phenotypes={ref.phenotypes}
      />

      <Section
        title={`Organism × antibiotic · ${where} · ${SPECIMEN_LABEL[f.specimen]} · last ${f.window} weeks`}
        subtitle="% resistant among first isolates. Grey cells have fewer than 30 isolates and show the count; IR is intrinsic resistance, excluded from every rate."
      >
        <Heatmap cells={cells} codes={codes} selected={[f.organism, f.abx]} />
      </Section>

      <div id="drill" className="mb-3 mt-8 text-sm font-medium text-ink-2">
        Drill-down: <i>{shortOrganism(f.organism)}</i> · {markerName} · {SPECIMEN_LABEL[f.specimen]}
      </div>

      <div className="grid grid-cols-1 gap-x-6 xl:grid-cols-2">
        <Section
          title="Ward comparison"
          subtitle={`Last ${f.window} weeks, ${SPECIMEN_LABEL[f.specimen].toLowerCase()}. Dot is %R, line is the 95% CI; dashed line is the hospital rate.`}
        >
          <ForestPlot rows={wards} />
        </Section>
        <Section title="Trend" subtitle={`${where} · rolling ${f.window}-week rate with 95% band; dashed is the 52-week rate`}>
          <TrendChart rows={trend} baseline={yearly} height={300} />
        </Section>
      </div>

      <Section
        title="Specimen breakdown"
        subtitle={`Same organism and marker in each specimen type · ${where} · rolling ${smallWindow}-week rate`}
      >
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {SPECIMENS.map((s, i) => {
            const rows = bySpecimen[i];
            const urineOnly = ref.antibiotics.find((a) => a.antibiotic_code === f.abx)?.reported_for === "urine";
            return (
              <div key={s}>
                <h3 className="mb-1 text-sm font-medium">{SPECIMEN_LABEL[s]}</h3>
                {urineOnly && s !== "urine" ? (
                  <p className="text-xs text-muted">{abxName(f.abx)} is reported for urine only.</p>
                ) : rows.some((r) => r.n_tested > 0) ? (
                  <TrendChart rows={rows} height={220} />
                ) : (
                  <p className="text-xs text-muted">No isolates.</p>
                )}
              </div>
            );
          })}
        </div>
      </Section>

      <div className="grid grid-cols-1 gap-x-6 xl:grid-cols-2">
        <Section title="Year by year" subtitle="First-isolate %R over each 52-week period">
          <RateTable rows={years.map((y) => [y.name, y.row])} />
        </Section>
        <Section title="Population splits" subtitle="Last 52 weeks, by care setting and onset (whole hospital)">
          <RateTable
            rows={splitScopes.map((s, i) => [
              s.scope_type === "setting" ? SETTING_LABEL[s.scope_value] : ONSET_LABEL[s.scope_value],
              splits[i],
            ])}
          />
        </Section>
      </div>

      {hasRegister && (
        <Section
          title={`National context · ${markerName} · THL register`}
          subtitle="Notified cases and incidence per 100,000, Finland and Southwest Finland. Context only."
        >
          <ExternalContext rows={register} />
        </Section>
      )}
    </>
  );
}

function RateTable({ rows }: { rows: [string, RateRow | undefined][] }) {
  const max = Math.max(1, ...rows.map(([, r]) => (r && r.n_tested >= MIN_N ? (r.wilson_high ?? 0) : 0)));
  return (
    <table className="num w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-muted">
          <th className="py-1 font-medium" />
          <th className="py-1 font-medium">%R</th>
          <th className="py-1 font-medium">95% CI</th>
          <th className="py-1 font-medium">x / n</th>
          <th className="w-1/3 py-1" />
        </tr>
      </thead>
      <tbody>
        {rows.map(([name, r]) => (
          <tr key={name} className="border-t border-line">
            <td className="py-1.5">{name}</td>
            {r && r.n_tested >= MIN_N ? (
              <>
                <td className="font-medium">{fmtPct(r.pct_r)}</td>
                <td className="text-xs text-ink-2">{fmtCi(r.wilson_low, r.wilson_high)}</td>
                <td className="text-xs text-ink-2">
                  {r.n_resistant} / {r.n_tested}
                </td>
                <td>
                  <span className="block h-2 rounded-r bg-[#2a78d6]" style={{ width: `${((r.pct_r ?? 0) / max) * 100}%` }} />
                </td>
              </>
            ) : (
              <td colSpan={4} className="text-xs text-muted">
                n = {r?.n_tested ?? 0}, too few for a %
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
