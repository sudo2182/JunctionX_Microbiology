import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DataGate, Field, PageHeader, Panel, heatVar } from "@/components/amr/shell";
import { SimpleSelect } from "@/components/amr/selects";
import { OrgChips } from "@/components/amr/org-chips";
import { MarkerCharts } from "@/components/amr/marker-charts";
import { AntibioticGuidance } from "@/components/amr/antibiotic-guidance";
import { Switch } from "@/components/ui/switch";
import { commonAntibiotics, applicableResult } from "@/lib/amr/applicability";
import { firstIsolates, MIN_ISOLATES } from "@/lib/amr/stats";
import { Slider } from "@/components/ui/slider";
import { WARDS, weekStart } from "@/lib/amr/reference";
import { abxResult, maxWeek, useAmr, type IsolateRecord } from "@/lib/amr/store";

export const Route = createFileRoute("/map")({
  head: () => ({
    meta: [
      { title: "Spatial distribution & trends — AMR Watch" },
      { name: "description", content: "Where resistant bacteria are found across hospital wards and health centres, and how this evolves over time." },
      { property: "og:title", content: "Spatial distribution & trends — AMR Watch" },
      { property: "og:description", content: "Resistance by care location and how it evolves over time." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => (
    <>
      <PageHeader eyebrow="Spatial & temporal" title="Where and when" />
      <DataGate>
        <MapView />
      </DataGate>
    </>
  ),
});

// Schematic of care locations: wards inside the hospital block, health centres beside it.
const NODES: Record<string, { x: number; y: number }> = {
  ED: { x: 28, y: 52 },
  ICU: { x: 128, y: 52 },
  SURG: { x: 228, y: 52 },
  "MED-A": { x: 28, y: 116 },
  "MED-B": { x: 128, y: 116 },
  URO: { x: 228, y: 116 },
  GER: { x: 28, y: 180 },
  "PHC-N": { x: 340, y: 60 },
  "PHC-S": { x: 340, y: 130 },
};
const NODE_W = 88;
const NODE_H = 52;
const WARD_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--foreground)", "var(--muted-foreground)", "var(--warning)", "var(--success)"];

const matcher = (metric: string, urinary: boolean) => {
  if (metric.startsWith("abx:")) {
    const code = metric.slice(4);
    return { test: (r: IsolateRecord) => abxResult(r, code) === "R", applies: (r: IsolateRecord) => applicableResult(r.organism, code, r.specimen, urinary) && abxResult(r, code) !== "-" };
  }
  return null;
};

function MapView() {
  const { records } = useAmr();
  const last = maxWeek(records);
  const [orgs, setOrgs] = useState<string[]>(["Escherichia coli", "Klebsiella pneumoniae"]);
  const [metric, setMetric] = useState("count");
  const [range, setRange] = useState<[number, number]>([Math.max(0, last - 25), last]);
  const [selected, setSelected] = useState<string | null>(null);

  const [urinary, setUrinary] = useState(false);
  const available = commonAntibiotics(orgs, urinary);
  const activeMetric = metric === "count" || available.some((a) => metric === `abx:${a.code}`) ? metric : "count";
  const m = matcher(activeMetric, urinary);
  const pool = useMemo(() => records.filter((r) => orgs.includes(r.organism)), [records, orgs]);

  const byWard = useMemo(() => {
    const out: Record<string, { n: number; pos: number; tested: number }> = {};
    WARDS.forEach((w) => (out[w.code] = { n: 0, pos: 0, tested: 0 }));
    for (const r of (m ? firstIsolates(pool.filter((r) => r.week >= range[0] && r.week <= range[1])) : pool)) {
      if (r.week < range[0] || r.week > range[1] || !out[r.ward]) continue;
      const o = out[r.ward];
      o.n++;
      if (m && m.applies(r)) {
        o.tested++;
        if (m.test(r)) o.pos++;
      }
    }
    return out;
  }, [pool, range, m]);

  const series = useMemo(() => {
    // 4-week bins over the full period
    const bins = Math.ceil((last + 1) / 4);
    const cnt = Array.from({ length: bins }, () => WARDS.map(() => [0, 0]));
    const grouped = Array.from({ length: bins }, (_, i) => pool.filter((r) => Math.floor(r.week / 4) === i));
    for (const r of (m ? grouped.flatMap(firstIsolates) : pool)) {
      const bin = cnt[Math.floor(r.week / 4)];
      const wi = WARDS.findIndex((w) => w.code === r.ward);
      if (!bin || wi < 0) continue;
      if (!m) bin[wi][0]++;
      else if (m.applies(r)) {
        bin[wi][1]++;
        if (m.test(r)) bin[wi][0]++;
      }
    }
    const pct = activeMetric.startsWith("abx:");
    const rows = cnt.map((bin, i) => {
      const row: Record<string, number | string | null> = { period: weekStart(i * 4) };
      WARDS.forEach((w, wi) => (row[w.code] = pct ? (bin[wi][1] >= MIN_ISOLATES ? +((100 * bin[wi][0]) / bin[wi][1]).toFixed(1) : null) : bin[wi][0]));
      return row;
    });
    return rows;
  }, [pool, m, activeMetric, last]);

  const value = (code: string) => {
    const o = byWard[code];
    if (!m) return { label: `${o.n}`, heat: null as number | null, sub: "isolates" };
    if (activeMetric.startsWith("abx:")) {
      const pct = o.tested >= MIN_ISOLATES ? (100 * o.pos) / o.tested : null;
      return { label: pct == null ? "–" : `${pct.toFixed(0)}%`, heat: pct, sub: `${o.pos}/${o.tested} R` };
    }
    const pct = o.n ? (100 * o.pos) / o.n : null;
    return { label: `${o.pos}`, heat: pct == null ? null : pct * 4, sub: `${pct?.toFixed(1) ?? 0}% of ${o.n}` };
  };

  const maxN = Math.max(1, ...WARDS.map((w) => byWard[w.code].n));
  const metricOptions = [
    { value: "count", label: "Isolate count" },
    ...available.map((a) => ({ value: `abx:${a.code}`, label: `% resistant · ${a.name}` })),
  ];
  const yLabel = activeMetric === "count" ? "isolates" : "% R";

  return (
    <div className="flex flex-col gap-3">
      <Panel>
        <div className="flex flex-col gap-4">
          <Field label="Bacteria"><OrgChips value={orgs} onChange={setOrgs} /></Field>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Measure"><SimpleSelect className="w-64" value={activeMetric} onChange={setMetric} options={metricOptions} /></Field>
            <Field label="Location"><SimpleSelect className="w-52" value={selected || "all"} onChange={(v) => setSelected(v === "all" ? null : v)} options={[{ value: "all", label: "All locations" }, ...WARDS.map((w) => ({ value: w.code, label: w.name }))]} /></Field>
            <label className="flex items-center gap-2 text-sm"><Switch checked={urinary} onCheckedChange={setUrinary} /> Uncomplicated lower UTI context</label>
            <div className="min-w-0 w-full flex-1 sm:min-w-72">
              <Field label={`Map period: ${weekStart(range[0])} → ${weekStart(range[1])} (${range[1] - range[0] + 1} weeks)`}>
                <Slider className="mt-3" min={0} max={last} step={1} value={range} onValueChange={(v) => setRange([v[0], v[1]] as [number, number])} />
              </Field>
            </div>
          </div>
          <AntibioticGuidance organisms={orgs} uncomplicatedUTI={urinary} />
        </div>
      </Panel>
      <div className="grid gap-3 lg:grid-cols-[440px_1fr]">
        <Panel title="Care locations">
          <svg viewBox="0 0 460 300" className="w-full">
            <rect x={12} y={34} width={306} height={250} rx={6} fill="none" stroke="var(--border)" />
            <text x={18} y={26} fontSize={10} fill="var(--muted-foreground)" className="eyebrow">Hospital</text>
            <rect x={324} y={34} width={124} height={250} rx={6} fill="none" stroke="var(--border)" />
            <text x={330} y={26} fontSize={10} fill="var(--muted-foreground)" className="eyebrow">Primary care</text>
            {WARDS.map((w) => {
              const v = value(w.code);
              const s = NODES[w.code];
              if (!s) return null;
              const fill = m ? heatVar(v.heat) : `color-mix(in oklch, var(--chart-1) ${15 + (75 * byWard[w.code].n) / maxN}%, var(--card))`;
              const active = selected === w.code;
              return (
                <g key={w.code} role="button" tabIndex={0} aria-label={`Select ${w.name}`} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(active ? null : w.code); } }} className="cursor-pointer" onClick={() => setSelected(active ? null : w.code)}>
                  <rect x={s.x} y={s.y} width={NODE_W} height={NODE_H} rx={5} fill={fill} stroke={active ? "var(--foreground)" : "var(--card)"} strokeWidth={active ? 3 : 2} />
                  <text x={s.x + NODE_W / 2} y={s.y + 15} textAnchor="middle" className="eyebrow" fill="var(--foreground)" fontSize={10}>{w.code}</text>
                  <text x={s.x + NODE_W / 2} y={s.y + 34} textAnchor="middle" fill="var(--foreground)" fontSize={17} className="num">{v.label}</text>
                  <text x={s.x + NODE_W / 2} y={s.y + 46} textAnchor="middle" fill="var(--muted-foreground)" fontSize={8}>{v.sub}</text>
                </g>
              );
            })}
          </svg>
          <p className="mt-2 text-xs text-muted-foreground">Schematic of care locations · percentages need ≥30 tested first isolates.</p>
        </Panel>
        <Panel title={`Evolution over time · ${yLabel} per 4 weeks`}>
          <div className="h-[400px]">
            <ResponsiveContainer>
              <LineChart data={series}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="period" tick={{ fontSize: 11 }} minTickGap={40} />
                <YAxis tick={{ fontSize: 11 }} width={36} />
                <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--border)" }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {WARDS.map((w, i) => (!selected || selected === w.code) && (
                  <Line key={w.code} dataKey={w.code} name={w.name} stroke={WARD_COLORS[i]} dot={false} connectNulls={false} strokeWidth={2} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>
      <MarkerCharts records={records} ward={selected} binWeeks={4} percentage={false} />
    </div>
  );
}
