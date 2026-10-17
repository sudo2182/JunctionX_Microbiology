import Link from "next/link";
import { notFound } from "next/navigation";

import { AckControl } from "@/components/AckControl";
import { BarList } from "@/components/BarList";
import { Chip } from "@/components/AlertCard";
import { PageTitle, Section } from "@/components/Section";
import { ConfidenceLabel, SeverityBadge } from "@/components/SeverityBadge";
import { TrendChart } from "@/components/TrendChart";
import { getData } from "@/lib/data";
import type { Specimen } from "@/lib/data/types";
import { fmtPct, ONSET_LABEL, scopeLabel, shortOrganism, SPECIMEN_LABEL } from "@/lib/format";
import { filtersToQuery, one, type SearchParams } from "@/lib/filters";

export const dynamic = "force-dynamic";

export default async function AlertDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const data = getData();
  const [ref, alert] = await Promise.all([data.ref(), data.alertDetail(decodeURIComponent(id))]);
  if (!alert) notFound();

  const e = alert.evidence;
  const scope = { scope_type: alert.scope_type, scope_value: alert.scope_value };
  const combo = { organism: alert.organism, antibiotic_code: alert.marker, specimen: alert.specimen };
  const window = alert.type === "drift" ? 52 : (e.current.window_weeks > 1 ? e.current.window_weeks : 4);
  const [series, baseline] = await Promise.all([
    data.rateSeries(combo, scope, window),
    data.rateSeries(combo, scope, 52),
  ]);
  const label = (w: number) => ref.weeks[w - 1]?.label ?? String(w);
  const fromWeek = one(sp.week);
  const wardName = (c: string) => ref.wards.find((w) => w.ward_code === c)?.ward_en ?? c;
  const abxName = (c: string) => ref.antibiotics.find((a) => a.antibiotic_code === c)?.antibiotic ?? c;
  const exploreHref = `/explore${filtersToQuery({
    organism: alert.organism,
    abx: alert.marker,
    specimen: alert.specimen === "all" ? undefined : (alert.specimen as Specimen),
    scope: alert.scope_type === "ward" ? { scope_type: "hospital", scope_value: "ALL" } : scope,
    window: window === 13 || window === 52 ? window : undefined,
  })}`;

  return (
    <>
      <div className="mb-3 text-sm">
        <Link href="/alerts" className="text-accent hover:underline">
          ← All alerts
        </Link>
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <SeverityBadge severity={alert.severity} />
        <ConfidenceLabel confidence={alert.confidence} />
        <Chip>{alert.status}</Chip>
        <Chip>{scopeLabel(scope, ref.wards)}</Chip>
        <Chip>{SPECIMEN_LABEL[alert.specimen]}</Chip>
        <span className="text-xs text-muted">{alert.alert_id}</span>
      </div>
      <PageTitle title={`${shortOrganism(alert.organism)} · ${alert.marker} · ${scopeLabel(scope, ref.wards)}`}>
        {alert.headline}
      </PageTitle>
      {fromWeek && (
        <p className="-mt-2 mb-4 text-xs text-ink-2">
          Opened from the feed item for {fromWeek}. The evidence below is the {alert.status === "resolved" ? "peak" : "latest"} firing ({label(e.week_idx)}).
        </p>
      )}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Link href={exploreHref} className="rounded-md bg-ink px-3 py-1.5 text-sm text-white hover:bg-ink/85">
          Explore in C →
        </Link>
        <AckControl alertId={alert.alert_id} />
      </div>

      <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-2">
        <Section title="Why this fired">
          <table className="num w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="py-1 font-medium" />
                <th className="py-1 font-medium">Weeks</th>
                <th className="py-1 font-medium">{alert.type === "count" ? "Isolates" : "x / n"}</th>
                <th className="py-1 font-medium">{alert.type === "count" ? "Expected" : "%R (95% CI)"}</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-line">
                <td className="py-1.5 font-medium">Current</td>
                <td>{e.current.weeks}</td>
                <td>{alert.type === "count" || alert.type === "sentinel" ? e.current.k : `${e.current.x} / ${e.current.n}`}</td>
                <td>
                  {alert.type === "count"
                    ? `${e.effect?.ratio}× expected`
                    : e.current.pct != null
                      ? `${fmtPct(e.current.pct)} (${e.current.ci?.[0]}–${e.current.ci?.[1]}%)`
                      : "–"}
                </td>
              </tr>
              {e.baseline && (
                <tr className="border-t border-line">
                  <td className="py-1.5 font-medium">Baseline</td>
                  <td>{e.baseline.weeks}</td>
                  <td>{alert.type === "count" ? `${e.baseline.count_52w} in 52 wk` : `${e.baseline.x} / ${e.baseline.n}`}</td>
                  <td>
                    {alert.type === "count"
                      ? `${e.baseline.expected_4w} per 4 wk`
                      : `${fmtPct(e.baseline.pct)} (${e.baseline.ci?.[0]}–${e.baseline.ci?.[1]}%)`}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            {e.effect?.abs_pp != null && (
              <>
                <dt className="text-muted">Difference</dt>
                <dd>
                  +{e.effect.abs_pp} percentage points ({e.effect.ratio}×)
                </dd>
              </>
            )}
            <dt className="text-muted">Test</dt>
            <dd>
              {e.test.name}
              {e.test.p != null && `, p = ${e.test.p}`}
              {e.test.q != null && `, q = ${e.test.q}`}
            </dd>
            <dt className="text-muted">Rule</dt>
            <dd>{e.rule}</dd>
            <dt className="text-muted">Severity</dt>
            <dd>
              {e.severity_points} points ({alert.severity}), {alert.confidence} confidence, rank {alert.rank}
            </dd>
            {e.distinct_patients != null && (
              <>
                <dt className="text-muted">Distinct patients</dt>
                <dd>
                  {e.distinct_patients}
                  {e.distinct_patients <= 2 ? " (could be one patient re-sampled)" : ""}
                </dd>
              </>
            )}
          </dl>
        </Section>

        <Section title="Where it comes from" subtitle="Flagged first isolates in the trigger window">
          {Object.keys(e.breakdown.ward ?? {}).length ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
              <div>
                <h3 className="mb-1 text-xs font-medium text-ink-2">Ward</h3>
                <BarList items={sorted(e.breakdown.ward).map(([k, v]) => [wardName(k), v])} />
              </div>
              <div>
                <h3 className="mb-1 text-xs font-medium text-ink-2">Specimen</h3>
                <BarList items={sorted(e.breakdown.specimen).map(([k, v]) => [SPECIMEN_LABEL[k as Specimen] ?? k, v])} />
              </div>
              <div>
                <h3 className="mb-1 text-xs font-medium text-ink-2">Onset</h3>
                <BarList items={sorted(e.breakdown.onset).map(([k, v]) => [ONSET_LABEL[k] ?? k, v])} />
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted">No breakdown for this signal type.</p>
          )}
          {Object.keys(e.co_resistance).length > 0 && (
            <div className="mt-4">
              <h3 className="mb-1 text-xs font-medium text-ink-2">Co-resistance of the flagged isolates</h3>
              <BarList
                items={Object.entries(e.co_resistance)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => [`${abxName(k)} R`, Math.round(v * 100)])}
                total={100}
              />
              <p className="mt-1 text-[11px] text-muted">Share resistant, %</p>
            </div>
          )}
        </Section>
      </div>

      <Section
        title="Trend"
        subtitle={`${scopeLabel(scope, ref.wards)} · rolling ${window}-week rate; shaded weeks are when this alert fired`}
      >
        <TrendChart rows={series} baseline={baseline} highlight={[label(alert.opened_week_idx), label(alert.last_fired_week_idx)]} />
      </Section>

      <Section title="Firing history" subtitle="Consecutive weeks update the same episode; two silent weeks resolve it">
        <ol className="flex flex-wrap gap-2 text-xs">
          {alert.firings.map((f) => (
            <li
              key={f.week_idx}
              className={`rounded border px-2 py-1 ${f.week_label === fromWeek ? "border-ink bg-black/5" : "border-line bg-white"}`}
            >
              {f.week_label} · <span className="capitalize">{f.severity}</span>
            </li>
          ))}
        </ol>
      </Section>
    </>
  );
}

function sorted(r: Record<string, number> | undefined): [string, number][] {
  return Object.entries(r ?? {}).sort((a, b) => b[1] - a[1]);
}
