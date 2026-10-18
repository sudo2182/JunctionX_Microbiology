import { AckControl } from "@/components/AckControl";
import { AlertCard } from "@/components/AlertCard";
import { ParamSelect } from "@/components/ParamSelect";
import { PageTitle, Section } from "@/components/Section";
import { getData } from "@/lib/data";
import { isActive, type AlertEpisode, type Severity } from "@/lib/data/types";
import { shortOrganism } from "@/lib/format";
import { one, organismFromSlug, slug, type SearchParams } from "@/lib/filters";

export const dynamic = "force-dynamic";

const SEV_ORDER: Severity[] = ["low", "medium", "high", "critical"];

export default async function AlertsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const data = getData();
  const [ref, status, all] = await Promise.all([data.ref(), data.replayStatus(), data.alerts()]);

  // Same parameters the RSS feeds link to: severity (minimum), ward, marker, organism (slug).
  const minSev = SEV_ORDER.indexOf((one(sp.severity) ?? "low") as Severity);
  const ward = one(sp.ward);
  const marker = one(sp.marker)?.toUpperCase();
  const organism = organismFromSlug(one(sp.organism), ref.organisms);
  const type = one(sp.type);
  const state = one(sp.status) ?? "active";

  const shown = all.filter(
    (a) =>
      SEV_ORDER.indexOf(a.severity) >= Math.max(0, minSev) &&
      (!ward || (a.scope_type === "ward" && a.scope_value === ward)) &&
      (!marker || a.marker === marker) &&
      (!organism || a.organism === organism) &&
      (!type || a.type === type) &&
      (state === "all" || (state === "active" ? isActive(a.status) : !isActive(a.status))),
  );
  const visible = shown.slice(0, 60);
  const sparks = await Promise.all(
    visible.map((a) =>
      data.rateSeries(
        { organism: a.organism, antibiotic_code: a.marker, specimen: a.specimen },
        { scope_type: a.scope_type, scope_value: a.scope_value },
        a.type === "drift" ? 52 : 4,
      ),
    ),
  );

  return (
    <>
      <PageTitle title="Alerts">
        Signals from the anomaly engine, ranked by severity × confidence. Rate signals compare the last 4 weeks with the
        52 weeks before them; rare organisms are tracked as counts; CPE, VRE and blood MRSA are reported on first
        occurrence.
      </PageTitle>
      <div className="mb-5 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface p-3">
        <ParamSelect
          name="status"
          label="Status"
          options={[
            ["", "Open and escalated"],
            ["resolved", "Resolved, acknowledged or dismissed"],
            ["all", "All"],
          ]}
        />
        <ParamSelect
          name="severity"
          label="Severity"
          options={[
            ["", "Any"],
            ["medium", "Medium and above"],
            ["high", "High and above"],
            ["critical", "Critical"],
          ]}
        />
        <ParamSelect
          name="type"
          label="Signal"
          options={[
            ["", "Any"],
            ["rate", "Rate"],
            ["count", "Count"],
            ["sentinel", "Sentinel"],
            ["drift", "Drift"],
          ]}
        />
        <ParamSelect name="ward" label="Ward" options={[["", "Any"], ...ref.wards.map((w) => [w.ward_code, w.ward_en] as [string, string])]} />
        <ParamSelect
          name="organism"
          label="Organism"
          options={[["", "Any"], ...ref.organisms.map((o) => [slug(o), shortOrganism(o)] as [string, string])]}
        />
        <ParamSelect
          name="marker"
          label="Marker"
          options={[["", "Any"], ...[...new Set(all.map((a) => a.marker))].sort().map((m) => [m, m] as [string, string])]}
        />
        <span className="ml-auto self-center text-sm text-ink-2">
          {shown.length} alert{shown.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-3">
          {visible.length === 0 && <p className="text-sm text-muted">No alerts match these filters.</p>}
          {visible.map((a, i) => (
            <AlertCard
              key={a.episode_id}
              alert={a}
              series={sparks[i]}
              wards={ref.wards}
              cursorWeek={status.cursor_week_idx}
              status={<AckControl alertId={a.alert_id} compact />}
            />
          ))}
          {shown.length > visible.length && (
            <p className="text-sm text-muted">Showing the top {visible.length}; narrow the filters to see the rest.</p>
          )}
        </div>
        <aside className="flex flex-col gap-4">
          <EnginePanel />
          <ValidationPanel alerts={all} labelFor={(w) => ref.weeks[w - 1]?.label ?? String(w)} cursor={status.cursor_week_idx} />
        </aside>
      </div>
    </>
  );
}

function EnginePanel() {
  return (
    <Section title="How the engine decides">
      <ul className="list-disc space-y-1.5 pl-4 text-xs text-ink-2">
        <li>Current window: last 4 weeks; widened to 8 then 13 if fewer than 30 first isolates.</li>
        <li>Baseline: the 52 weeks before the current window, so an outbreak does not dilute its own baseline.</li>
        <li>Rate: exact one-sided binomial test, Benjamini–Hochberg q &lt; 0.05 across that week&apos;s tests, and a rise of at least 5 percentage points or 1.5×.</li>
        <li>Count (MRSA, ESBL, CPE, VRE): Poisson p &lt; 0.01 and at least 3 isolates in 4 weeks.</li>
        <li>Sentinel: any CPE, VRE, meropenem-resistant Enterobacterales or blood MRSA.</li>
        <li>Drift: last 52 weeks vs the previous 52; always low severity.</li>
        <li>Severity points: priority phenotype 3, blood 3, first-line agent 2, large rise 2, hospital-onset majority 1, ≥ 5 patients 1. Critical ≥ 7, High 5–6, Medium 3–4.</li>
      </ul>
    </Section>
  );
}

function ValidationPanel({
  alerts,
  labelFor,
  cursor,
}: {
  alerts: AlertEpisode[];
  labelFor: (w: number) => string;
  cursor: number;
}) {
  const planted = [
    {
      name: "ESBL E. coli, Urology",
      start: 88,
      match: (a: AlertEpisode) => a.scope_value === "URO" && a.marker === "ESBL" && a.organism === "Escherichia coli",
    },
    {
      name: "MRSA cluster, ICU",
      start: 127,
      match: (a: AlertEpisode) => a.scope_value === "ICU" && a.marker === "MRSA" && a.type !== "sentinel",
    },
  ];
  return (
    <Section title="Validation against planted outbreaks">
      <ul className="space-y-2 text-xs">
        {planted.map((p) => {
          const hit = alerts
            .filter((a) => p.match(a) && a.opened_week_idx >= p.start - 2)
            .sort((a, b) => a.opened_week_idx - b.opened_week_idx)[0];
          return (
            <li key={p.name}>
              <div className="font-medium">{p.name}</div>
              <div className="text-ink-2">
                Planted from {labelFor(p.start)}.{" "}
                {cursor < p.start
                  ? "Not reached yet by the replay."
                  : hit
                    ? `Detected ${labelFor(hit.opened_week_idx)} (${hit.opened_week_idx - p.start >= 0 ? `+${hit.opened_week_idx - p.start}` : hit.opened_week_idx - p.start} wk), ${hit.severity}.`
                    : "Not detected."}
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
