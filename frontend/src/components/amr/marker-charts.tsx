import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { MARKERS, weekStart } from "@/lib/amr/reference";
import { firstIsolates, MIN_ISOLATES } from "@/lib/amr/stats";
import type { IsolateRecord } from "@/lib/amr/store";
import { Panel } from "./shell";

const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-5)"];

export function MarkerCharts({ records, asOf, ward, binWeeks = 1, percentage = true, compact = false, scopeLabel }: {
  records: IsolateRecord[]; asOf?: string; ward?: string | null; binWeeks?: number; percentage?: boolean; compact?: boolean; scopeLabel?: string;
}) {
  const rows = useMemo(() => {
    const pool = records.filter((r) => (!asOf || r.date <= asOf) && (!ward || r.ward === ward));
    const last = pool.reduce((w, r) => Math.max(w, r.week), 0);
    const first = pool.length ? Math.floor(Math.min(...pool.map((r) => r.week)) / binWeeks) : 0;
    const groups = new Map<number, IsolateRecord[]>();
    for (const r of pool) {
      const bin = Math.floor(r.week / binWeeks);
      const group = groups.get(bin) || [];
      group.push(r);
      groups.set(bin, group);
    }
    return Array.from({ length: Math.max(0, Math.floor(last / binWeeks) - first + 1) }, (_, index) => {
      const bin = first + index;
      const isolates = firstIsolates(groups.get(bin) || []);
      return { period: weekStart(bin * binWeeks), n: isolates.length, ...Object.fromEntries(MARKERS.map((m) => {
        const positive = isolates.filter((r) => (r.flags & m.bit) !== 0).length;
        return [m.label, percentage ? (isolates.length >= MIN_ISOLATES ? 100 * positive / isolates.length : null) : positive];
      })) };
    });
  }, [records, asOf, ward, binWeeks, percentage]);

  return <section className="space-y-2">
    <h2 className="text-sm font-semibold">Resistance phenotypes · {scopeLabel || ward || "All wards"}</h2>
    <p className="text-xs text-muted-foreground">First isolate per patient / organism / specimen per {binWeeks === 1 ? "week" : `${binWeeks}-week period`} · fewer than 30 isolates omitted.</p>
    <div className={`grid gap-3 md:grid-cols-2 xl:grid-cols-4`}>
      {MARKERS.map((m, i) => <Panel key={m.key} title={`${m.label} · ${percentage ? "% positive" : "positive isolates"}`}>
        <div className={compact ? "h-28" : "h-36"}>
          <ResponsiveContainer><LineChart data={rows}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="period" tick={{ fontSize: 10 }} minTickGap={65} />
            <YAxis domain={[0, "auto"]} width={44} tick={{ fontSize: 11 }} unit={percentage ? "%" : ""} allowDecimals={percentage} />
            <Tooltip formatter={(v) => [percentage ? `${Number(v).toFixed(1)}%` : v, m.label]} contentStyle={{ background: "var(--card)", border: "1px solid var(--border)" }} />
            <Line dataKey={m.label} stroke={COLORS[i]} dot={false} strokeWidth={2} connectNulls={false} />
          </LineChart></ResponsiveContainer>
        </div>
      </Panel>)}
    </div>
  </section>;
}