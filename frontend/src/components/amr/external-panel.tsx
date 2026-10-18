import { useMemo, useState } from "react";
import { CartesianGrid, Cell, LabelList, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ExternalLink, Globe2, TriangleAlert } from "lucide-react";
import { SimpleSelect } from "@/components/amr/selects";
import { Button } from "@/components/ui/button";
import {
  COUNTRY, REGION, SPECIMEN_LABEL, finresOptions, finresSeries, freshness, incidenceSeries, notificationShare, registerOptions,
  useExternal, yearRange, type RegisterKey, type SourceRow, type Specimen,
} from "@/lib/amr/external";

/**
 * Left column of the Hospital atlas: real THL reference data (Finland and Southwest Finland) as charts, with when it
 * was collected. Separate from the synthetic local data on the rest of the page; never divided by or merged with it.
 */

const EMPHASIS = "var(--chart-1)"; // Southwest Finland / the highlighted series
const CONTEXT = "var(--muted-foreground)"; // Finland, shown as context
const tooltipStyle = { background: "var(--card)", border: "1px solid var(--border)", fontSize: 12 };
const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC" : "never";

function Collected({ label, source, coverage }: { label: string; source: SourceRow | undefined; coverage: string }) {
  const f = freshness(source);
  return (
    <div className="text-[11px] leading-snug text-muted-foreground">
      <span className="font-medium text-foreground">{label}</span> · data {coverage} · collected <span className="num">{fmtDate(f.lastImport)}</span>
      {f.stale && (
        <span className="mt-0.5 flex items-start gap-1 text-destructive">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
          {f.daysAgo === null ? "Never imported." : `Last import ${f.daysAgo} days ago; the monthly update may not be running.`}
        </span>
      )}
    </div>
  );
}

export function ExternalPanel() {
  const ext = useExternal();
  const [specimen, setSpecimen] = useState<Specimen>("blood_csf");
  const [series, setSeries] = useState<RegisterKey>("esbl-ecoli");
  const [finresKey, setFinresKey] = useState("Escherichia coli|CRO|blood");

  const context = ext.data?.context ?? [];
  const bench = ext.data?.bench ?? [];
  const options = useMemo(() => registerOptions(context, specimen), [context, specimen]);
  const activeSeries = options.some((o) => o.key === series) ? series : (options[0]?.key ?? "esbl-ecoli");
  const incidence = useMemo(() => incidenceSeries(context, activeSeries, specimen), [context, activeSeries, specimen]);
  const share = useMemo(() => notificationShare(context, REGION.code, specimen), [context, specimen]);
  const fOptions = useMemo(() => finresOptions(bench), [bench]);
  const activeFinres = fOptions.some((o) => o.key === finresKey) ? finresKey : (fOptions[0]?.key ?? "");
  const finres = useMemo(() => finresSeries(bench, activeFinres), [bench, activeFinres]);

  const src = (id: string) => ext.data?.sources.find((s) => s.source_id === id);
  const nidr = src("thl_nidr");
  const fin = src("thl_finres");
  const seriesLabel = options.find((o) => o.key === activeSeries)?.label ?? "";
  const lastInc = [...incidence].reverse().find((p) => p.region != null);
  const lastFin = finres.at(-1);

  return (
    <aside className="min-w-0 space-y-4 border bg-card p-4 md:max-h-[calc(100vh-150px)] md:overflow-y-auto" aria-label="THL national and regional reference data">
      <div>
        <div className="flex items-center gap-2"><Globe2 className="h-5 w-5 text-primary" /><h2 className="text-base font-semibold">Finland · THL reference data</h2></div>
        <p className="mt-1 text-[11px] text-muted-foreground">Real national and regional surveillance. Context only: not directly comparable with the synthetic local data on this page.</p>
      </div>

      {ext.status === "loading" && <p className="text-sm text-muted-foreground">Loading THL data…</p>}
      {ext.status === "error" && <p role="alert" className="text-sm text-destructive">THL data could not be loaded: {ext.error}</p>}

      {ext.status === "ready" && (
        <>
          <div className="space-y-1 border-y py-2">
            <Collected label="THL infectious diseases register" source={nidr} coverage={yearRange(context)} />
            <Collected label="THL Finres resistance report" source={fin} coverage={yearRange(bench)} />
          </div>

          <div className="flex gap-1" role="group" aria-label="Finding type">
            {(Object.keys(SPECIMEN_LABEL) as Specimen[]).map((s) => (
              <Button key={s} size="sm" className="h-7 text-xs" variant={specimen === s ? "default" : "ghost"} aria-pressed={specimen === s} onClick={() => setSpecimen(s)}>{SPECIMEN_LABEL[s]}</Button>
            ))}
          </div>

          {/* Line: notifications per 100 000, region (emphasis) vs country (context). One unit, one axis. */}
          <section aria-label="Notified cases per 100 000 population">
            <h3 className="text-sm font-semibold">Notified cases per 100,000</h3>
            <p className="mb-2 text-[11px] text-muted-foreground">{SPECIMEN_LABEL[specimen]} findings · {REGION.label} vs {COUNTRY.label}</p>
            <SimpleSelect className="mb-2 h-8 w-full" value={activeSeries} onChange={(v) => setSeries(v as RegisterKey)} options={options.map((o) => ({ value: o.key, label: o.label }))} />
            <div className="h-44">
              <ResponsiveContainer>
                <LineChart data={incidence} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                  <CartesianGrid stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="year" tick={{ fontSize: 10 }} tickLine={false} minTickGap={16} />
                  <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={44} />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    formatter={(v, name, item) => {
                      const p = item.payload as (typeof incidence)[number];
                      const cases = name === REGION.label ? p.regionCases : p.countryCases;
                      return [`${Number(v).toFixed(1)} per 100k (${cases ?? "–"} cases)`, name];
                    }}
                  />
                  <Line type="monotone" dataKey="country" name={COUNTRY.label} stroke={CONTEXT} strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls={false} />
                  <Line type="monotone" dataKey="region" name={REGION.label} stroke={EMPHASIS} strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1"><span className="h-0.5 w-4" style={{ background: EMPHASIS }} />{REGION.label}{lastInc && <span className="num text-foreground">· {lastInc.region?.toFixed(1)} in {lastInc.year}</span>}</span>
              <span className="flex items-center gap-1"><span className="h-0.5 w-4" style={{ background: CONTEXT }} />{COUNTRY.label}</span>
            </div>
            <details className="mt-1 text-[11px]">
              <summary className="cursor-pointer text-muted-foreground">Show the numbers</summary>
              <table className="mt-1 w-full num">
                <thead><tr className="text-muted-foreground"><th className="text-left font-normal">Year</th><th className="text-right font-normal">{REGION.label}</th><th className="text-right font-normal">{COUNTRY.label}</th></tr></thead>
                <tbody>{incidence.map((p) => <tr key={p.year}><td>{p.year}</td><td className="text-right">{p.region?.toFixed(1) ?? "–"} ({p.regionCases ?? "–"})</td><td className="text-right">{p.country?.toFixed(1) ?? "–"} ({p.countryCases ?? "–"})</td></tr>)}</tbody>
              </table>
              <p className="mt-1 text-muted-foreground">Per 100,000 population (cases). {seriesLabel}.</p>
            </details>
          </section>

          {/* Pie: part-to-whole of notified cases by type, one area, one year, one finding type (no double counting). */}
          <section aria-label="Share of notified cases by type">
            <h3 className="text-sm font-semibold">{REGION.label}: notified cases by type</h3>
            <p className="mb-1 text-[11px] text-muted-foreground">{SPECIMEN_LABEL[specimen]} findings · {share.year ?? "–"} · {share.total.toLocaleString()} cases</p>
            {share.total === 0 ? (
              <p className="text-sm text-muted-foreground">No notified cases for this finding type.</p>
            ) : (
              <>
                <div className="h-44">
                  <ResponsiveContainer>
                    <PieChart>
                      <Pie data={share.slices} dataKey="cases" nameKey="label" innerRadius="45%" outerRadius="80%" paddingAngle={0} stroke="var(--card)" strokeWidth={2} isAnimationActive={false}>
                        {share.slices.map((s) => <Cell key={s.key} fill={s.color} />)}
                        <LabelList dataKey="label" position="outside" offset={8} style={{ fontSize: 11, fill: "var(--foreground)" }} />
                      </Pie>
                      <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => [`${Number(v).toLocaleString()} cases (${((100 * Number(v)) / share.total).toFixed(0)}%)`, name]} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
                  {share.slices.map((s) => (
                    <li key={s.key} className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: s.color }} />
                      <span className="font-medium">{s.label}</span>
                      <span className="num ml-auto text-muted-foreground">{s.cases.toLocaleString()} · {s.pct.toFixed(0)}%</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-[10px] text-muted-foreground">Species summed within each type (e.g. ESBL = E. coli + K. pneumoniae).</p>
              </>
            )}
          </section>

          {/* Line: Finres national % resistant over time, single series. */}
          <section aria-label="National percent resistant (THL Finres)">
            <h3 className="text-sm font-semibold">Finland: % resistant (Finres)</h3>
            <p className="mb-2 text-[11px] text-muted-foreground">National, first isolates, per year</p>
            <SimpleSelect className="mb-2 h-8 w-full" value={activeFinres} onChange={setFinresKey} options={fOptions.map((o) => ({ value: o.key, label: o.label }))} />
            <div className="h-40">
              <ResponsiveContainer>
                <LineChart data={finres} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                  <CartesianGrid stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="year" tick={{ fontSize: 10 }} tickLine={false} minTickGap={16} />
                  <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={44} unit="%" domain={[0, "auto"]} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v, _n, item) => [`${Number(v).toFixed(1)}% resistant (n=${(item.payload as { n: number | null }).n?.toLocaleString() ?? "–"} tested)`, "Finland"]} />
                  <Line type="monotone" dataKey="pct" name="Finland" stroke={EMPHASIS} strokeWidth={2} dot={{ r: 2.5 }} activeDot={{ r: 4 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            {lastFin && <p className="text-[11px] text-muted-foreground">Latest: <span className="num font-medium text-foreground">{lastFin.pct.toFixed(1)}%</span> in {lastFin.year} (n={lastFin.n?.toLocaleString() ?? "–"} tested)</p>}
            <details className="mt-1 text-[11px]">
              <summary className="cursor-pointer text-muted-foreground">Show the numbers</summary>
              <table className="mt-1 w-full num">
                <thead><tr className="text-muted-foreground"><th className="text-left font-normal">Year</th><th className="text-right font-normal">% R</th><th className="text-right font-normal">n tested</th></tr></thead>
                <tbody>{finres.map((p) => <tr key={p.year}><td>{p.year}</td><td className="text-right">{p.pct.toFixed(1)}</td><td className="text-right">{p.n?.toLocaleString() ?? "–"}</td></tr>)}</tbody>
              </table>
            </details>
          </section>

          <div className="space-y-1 border-t pt-2 text-[10px] text-muted-foreground">
            {[nidr, fin].filter(Boolean).map((s) => (
              <p key={s!.source_id}>
                {s!.attribution ?? s!.name}{s!.licence ? ` · ${s!.licence}` : ""}
                {s!.landing_url && <> · <a href={s!.landing_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 underline">source<ExternalLink className="h-2.5 w-2.5" /></a></>}
              </p>
            ))}
            <p>Updates automatically on page load after each import (register: monthly; Finres: when THL publishes a new report).</p>
          </div>
        </>
      )}
    </aside>
  );
}
