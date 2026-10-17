import Link from "next/link";

import { AlertCard } from "@/components/AlertCard";
import { Antibiogram } from "@/components/Antibiogram";
import { FilterBar } from "@/components/FilterBar";
import { KpiTile } from "@/components/KpiTile";
import { PageTitle, Section } from "@/components/Section";
import { TrendChart } from "@/components/TrendChart";
import { getData } from "@/lib/data";
import { isActive, type Combo, type Specimen } from "@/lib/data/types";
import { PHENOTYPE_LABEL, scopeLabel, shortOrganism, SPECIMEN_LABEL } from "@/lib/format";
import { filtersToQuery, parseFilters, type SearchParams } from "@/lib/filters";

export const dynamic = "force-dynamic";

const PINNED: Combo[] = [
  { organism: "Escherichia coli", antibiotic_code: "CIP", specimen: "urine" },
  { organism: "Escherichia coli", antibiotic_code: "TMP", specimen: "urine" },
  { organism: "Escherichia coli", antibiotic_code: "MEC", specimen: "urine" },
  { organism: "Escherichia coli", antibiotic_code: "NIT", specimen: "urine" },
  { organism: "Escherichia coli", antibiotic_code: "CRO", specimen: "blood" },
  { organism: "Staphylococcus aureus", antibiotic_code: "MRSA", specimen: "all" },
];

export default async function OverviewPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const data = getData();
  const [ref, status] = await Promise.all([data.ref(), data.replayStatus()]);
  const f = parseFilters(sp, ref.organisms);
  const abxName = (c: string) => ref.antibiotics.find((a) => a.antibiotic_code === c)?.antibiotic ?? c;
  const combo: Combo = { organism: f.organism, antibiotic_code: f.abx, specimen: f.specimen as Specimen };
  const antibiogramMeasure = sp.measure === "r" ? "r" : "s";

  const [tiles, series, baseline, benchmarks, antibiogram, alerts] = await Promise.all([
    data.currentVsBaseline(PINNED, f.scope),
    data.rateSeries(combo, f.scope, f.window),
    data.rateSeries(combo, f.scope, 52),
    data.benchmarks(combo),
    data.antibiogram(f.specimen, f.scope),
    data.alerts(),
  ]);
  const inScope = alerts.filter(
    (a) =>
      isActive(a.status) &&
      (f.scope.scope_type === "hospital" ||
        (a.scope_type === f.scope.scope_type && a.scope_value === f.scope.scope_value)),
  );
  const top = inScope.slice(0, 3);
  const sparks = await Promise.all(
    top.map((a) =>
      data.rateSeries(
        { organism: a.organism, antibiotic_code: a.marker, specimen: a.specimen },
        { scope_type: a.scope_type, scope_value: a.scope_value },
        4,
      ),
    ),
  );
  const where = scopeLabel(f.scope, ref.wards);
  const toggleQ = new URLSearchParams(filtersToQuery({ ...f, measure: "r" }).slice(1));
  if (antibiogramMeasure === "s") toggleQ.set("measure", "r");
  const toggleHref = `/?${toggleQ.toString()}`;
  const markerName = PHENOTYPE_LABEL[f.abx] ?? `${abxName(f.abx)} resistance`;

  return (
    <>
      <PageTitle title="Surveillance overview">
        Current resistance for {where.toLowerCase() === "whole hospital" ? "the whole hospital" : where}: the last 4
        weeks against the previous 52, with counts and 95% confidence intervals.
      </PageTitle>
      <FilterBar
        filters={f}
        wards={ref.wards}
        organisms={ref.organisms}
        antibiotics={ref.antibiotics}
        phenotypes={ref.phenotypes}
      />

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {tiles.map((t) => (
          <KpiTile key={`${t.organism}${t.antibiotic_code}${t.specimen}`} row={t} abxName={abxName(t.antibiotic_code)} />
        ))}
      </div>

      <div className="mb-6 rounded-lg border border-line bg-surface p-4">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-base font-semibold">Open alerts {f.scope.scope_type !== "hospital" && `· ${where}`}</h2>
          <Link href="/alerts" className="ml-auto text-sm text-accent hover:underline">
            All alerts ({inScope.length} open) →
          </Link>
        </div>
        {top.length ? (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            {top.map((a, i) => (
              <AlertCard key={a.episode_id} alert={a} series={sparks[i]} wards={ref.wards} cursorWeek={status.cursor_week_idx} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">No open alerts for this selection.</p>
        )}
      </div>

      <Section
        id="trend"
        title={`${shortOrganism(f.organism)} · ${SPECIMEN_LABEL[f.specimen]} · ${markerName}`}
        subtitle={`${where} · rolling ${f.window}-week first-isolate rate with 95% Wilson band; dashed line is the rolling 52-week rate. Weeks with fewer than 30 isolates are left out of the line.`}
        action={
          <Link href={`/explore${filtersToQuery(f)}`} className="text-sm text-accent hover:underline">
            Explore this combination →
          </Link>
        }
      >
        {series.some((r) => r.n_tested > 0) ? (
          <TrendChart rows={series} baseline={baseline} benchmarks={benchmarks} />
        ) : (
          <p className="text-sm text-muted">No isolates for this combination and scope.</p>
        )}
        {series.some((r) => r.n_tested > 0) && !series.some((r) => r.reportable) && (
          <p className="mt-2 text-xs text-ink-2">
            No {f.window}-week window here reaches 30 isolates, so only counts are shown. Try a 13- or 52-week window.
          </p>
        )}
        {benchmarks.length === 0 && (
          <p className="mt-2 text-xs text-muted">No national benchmark loaded for this combination yet.</p>
        )}
      </Section>

      <Section
        title={`Antibiogram · ${where} · ${SPECIMEN_LABEL[f.specimen]}`}
        subtitle="First isolates per patient. Click a cell to explore it."
        action={
          <Link
            href={toggleHref}
            className="text-sm text-accent hover:underline"
            scroll={false}
          >
            Show {antibiogramMeasure === "s" ? "% resistant" : "% susceptible"}
          </Link>
        }
      >
        {(f.scope.scope_type === "setting" || f.scope.scope_type === "onset") && (
          <p className="mb-2 text-xs text-ink-2">The antibiogram is published for the whole hospital and for single wards only.</p>
        )}
        <Antibiogram rows={antibiogram} antibiotics={ref.antibiotics} measure={antibiogramMeasure} scope={f.scope} />
      </Section>
    </>
  );
}
