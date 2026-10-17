import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DataGate, Field, PageHeader, Panel, heatVar } from "@/components/amr/shell";
import { SimpleSelect } from "@/components/amr/selects";
import { Button } from "@/components/ui/button";
import { AntibioticGuidance } from "@/components/amr/antibiotic-guidance";
import { antibioticApplicability, commonAntibiotics, applicableResult } from "@/lib/amr/applicability";
import { Switch } from "@/components/ui/switch";
import { ANTIBIOTICS, ORGANISMS, WARDS, weekStart, weekIndex } from "@/lib/amr/reference";
import { maxWeek, useAmr } from "@/lib/amr/store";
import { firstIsolates, MIN_ISOLATES, resistance } from "@/lib/amr/stats";

export const Route = createFileRoute("/wards")({
  validateSearch: (search: Record<string, unknown>): { ward?: string | undefined; date?: string | undefined } => ({
    ward: typeof search['ward'] === "string" && WARDS.some((w) => w.code === search['ward']) ? search['ward'] : undefined,
    date: typeof search['date'] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(search['date']) && Number.isFinite(Date.parse(`${search['date']}T00:00:00Z`)) ? search['date'] : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Weekly ward resistance — AMR Watch" },
      { name: "description", content: "Weekly updated resistance percentages per hospital ward and antibiotic." },
      { property: "og:title", content: "Weekly ward resistance — AMR Watch" },
      { property: "og:description", content: "Resistance percentages per ward, updated weekly." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => (
    <>
      <PageHeader eyebrow="Hospital wards" title="Weekly resistance by ward" />
      <DataGate>
        <Wards />
      </DataGate>
    </>
  ),
});

const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--foreground)", "var(--muted-foreground)", "var(--warning)", "var(--success)"];

function Wards() {
  const { records } = useAmr();
  const search = Route.useSearch();
  const last = maxWeek(records);
  const [week, setWeek] = useState(String(search.date ? Math.max(0, Math.min(last, weekIndex(search.date))) : last));
  const [windowW, setWindowW] = useState("4");
  const [org, setOrg] = useState("Escherichia coli");
  const [urinary, setUrinary] = useState(false);
  const [selectedWard, setSelectedWard] = useState(search.ward || "all");
  const [abx, setAbx] = useState("CRO");

  const organisms = org === "all" ? ORGANISMS : [org];
  const available = commonAntibiotics(organisms, urinary);
  const activeAbx = available.some((a) => a.code === abx) ? abx : (available[0]?.code || "");
  const wk = Number(week);
  const W = Number(windowW);
  const pool = useMemo(() => records.filter((r) => org === "all" || r.organism === org), [records, org]);

  const matrix = useMemo(() => {
    const inWin = pool.filter((r) => r.week <= wk && r.week > wk - W);
    const set = firstIsolates(inWin);
    const groups = [...WARDS.map((w) => ({ ward: w as { code: string; name: string; type: string }, rs: set.filter((r) => r.ward === w.code) })), { ward: { code: "TOTAL", name: "Total · all wards", type: "total" }, rs: set }];
    return groups.map(({ ward: w, rs }) => {
      return { ward: w, n: rs.length, cells: ANTIBIOTICS.map((a) => {
        const rules = organisms.map((o) => antibioticApplicability(o, a.code));
        const valid = available.some((x) => x.code === a.code);
        const reason = organisms.map((o, i) => `${o}: ${rules[i].reason}`).join("\n");
        const status = valid ? "applicable" : rules.every((r) => r.status === "expected-resistant") ? "expected-resistant" : rules.every((r) => r.status === "screen") ? "screen" : rules.some((r) => r.status === "urinary") && !urinary ? "urinary" : rules.some((r) => r.status === "review") ? "review" : "unsupported";
        return { ...resistance(valid ? rs.filter((r) => applicableResult(r.organism, a.code, r.specimen, urinary)) : [], a.code), status, reason };
      }) };
    });
  }, [pool, wk, W, organisms, available, urinary]);

  const trend = useMemo(() => {
    const rows = [];
    for (let t = Math.max(W - 1, last - 103); t <= last; t++) {
      const win = pool.filter((r) => r.week <= t && r.week > t - W);
      const set = firstIsolates(win);
      const row: Record<string, number | string | null> = { week: weekStart(t) };
      for (const w of WARDS) {
        const res = resistance(set.filter((r) => r.ward === w.code && applicableResult(r.organism, activeAbx, r.specimen, urinary)), activeAbx);
        row[w.code] = res.n >= MIN_ISOLATES && res.pct != null ? +res.pct.toFixed(1) : null;
      }
      rows.push(row);
    }
    return rows;
  }, [pool, W, activeAbx, last, urinary]);

  const weeks = Array.from({ length: last + 1 }, (_, i) => last - i).map((i) => ({ value: String(i), label: `Week of ${weekStart(i)}` }));

  return (
    <div className="flex flex-col gap-3">
      <Panel>
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Reporting week"><SimpleSelect className="w-52" value={week} onChange={setWeek} options={weeks} /></Field>
          <Field label="Window"><SimpleSelect className="w-40" value={windowW} onChange={setWindowW} options={[{ value: "1", label: "This week" }, { value: "4", label: "Rolling 4 weeks" }, { value: "13", label: "Rolling 13 weeks" }, { value: "52", label: "Rolling 52 weeks" }]} /></Field>
          <Field label="Organism"><SimpleSelect className="w-60" value={org} onChange={setOrg} options={[{ value: "all", label: "All organisms" }, ...ORGANISMS.map((o) => ({ value: o, label: o }))]} /></Field>
          <label className="flex items-center gap-2 text-sm"><Switch checked={urinary} onCheckedChange={setUrinary} /> Uncomplicated lower UTI context</label>
        </div>
        <AntibioticGuidance organisms={organisms} uncomplicatedUTI={urinary} />
      </Panel>

      <Panel title={`% resistant · ${weekStart(Math.max(0, wk - W + 1))} → ${weekStart(wk)}`}>
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-0.5 text-sm">
            <thead>
              <tr>
                <th className="eyebrow p-2 text-left">Ward</th>
                <th className="eyebrow p-2 text-right">n</th>
                {ANTIBIOTICS.map((a) => (
                  <th key={a.code} title={a.name} className="num p-2 text-xs font-medium">
                    <Button size="sm" variant={activeAbx === a.code ? "secondary" : "ghost"} disabled={!available.some((x) => x.code === a.code)} onClick={() => setAbx(a.code)}>{a.code}</Button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.map((row) => (
                <tr key={row.ward.code} className={row.ward.type === "total" ? "font-semibold" : row.ward.code === selectedWard ? "bg-accent" : undefined}>
                  <td className={`whitespace-nowrap p-2 ${row.ward.type === "total" ? "border-t-2 border-foreground/30" : ""}`}>
                    {row.ward.name} <span className="text-xs text-muted-foreground">{row.ward.type === "total" ? "" : row.ward.type === "in" ? "inpatient" : "outpatient"}</span>
                  </td>
                  <td className="num p-2 text-right text-muted-foreground">{row.n}</td>
                  {row.cells.map((c, i) => {
                    const hidden = !c.reportable;
                    const label = c.status === "expected-resistant" ? "ER" : c.status === "screen" ? "Screen" : c.status === "urinary" ? "UTI only" : c.status === "review" ? "Review" : c.status === "unsupported" ? "N/A" : c.n === 0 ? "No AST" : hidden ? `n=${c.n}` : `${c.pct?.toFixed(0)}%`;
                    return (
                      <td key={i} title={`${c.reason}\n${c.r}/${c.n} resistant`} className={`num min-w-14 rounded p-2 text-center text-xs ${c.status === "expected-resistant" ? "bg-warning text-warning-foreground" : c.status === "review" || c.status === "screen" || c.status === "urinary" ? "bg-accent text-accent-foreground" : c.status === "unsupported" ? "bg-secondary text-muted-foreground border border-dashed" : hidden ? "bg-muted text-muted-foreground" : "text-heat-foreground"}`} style={c.status === "applicable" && !hidden ? { background: heatVar(c.pct) } : undefined}>
                        {label}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          Legend {["<5%", "5–10%", "10–20%", "20–40%", "≥40%"].map((l, i) => (<span key={l} className="flex items-center gap-1"><span className="h-3 w-5 rounded" style={{ background: `var(--heat-${i})` }} />{l}</span>))}
          <span>N/A unsupported · ER expected resistance · Screen only · Review · UTI only · No AST · n&lt;30</span>
        </div>
      </Panel>

      <Panel title={`Trend · ${ANTIBIOTICS.find((a) => a.code === activeAbx)?.name || "No common supported agent"} · % resistant (window ${W} wk)`} right={<div className="flex flex-wrap gap-2"><Field label="Antibiotic"><SimpleSelect className="h-8 w-56" value={activeAbx || "none"} onChange={setAbx} options={available.length ? available.map((a) => ({ value: a.code, label: a.name })) : [{ value: "none", label: "No common agent" }]} /></Field><Field label="Chart ward"><SimpleSelect className="h-8 w-56" value={selectedWard} onChange={setSelectedWard} options={[{ value: "all", label: "All wards" }, ...WARDS.map((w) => ({ value: w.code, label: w.name }))]} /></Field></div>}>
        <div className="h-56">
          <ResponsiveContainer>
            <LineChart data={trend}>
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis dataKey="week" tick={{ fontSize: 11 }} minTickGap={50} />
              <YAxis tick={{ fontSize: 11 }} width={36} unit="%" />
              <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--border)" }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {WARDS.map((w, i) => (selectedWard === "all" || selectedWard === w.code) && (
                <Line key={w.code} dataKey={w.code} name={w.name} stroke={COLORS[i]} dot={false} connectNulls={false} strokeWidth={1.75} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Gaps: too few isolates in that window.</p>
      </Panel>
    </div>
  );
}
