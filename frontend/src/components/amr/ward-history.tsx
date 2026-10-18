import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { wardHistory } from "@/lib/amr/occupancy";
import { MARKERS } from "@/lib/amr/reference";
import type { IsolateRecord, StayRecord } from "@/lib/amr/store";

const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-5)"];
const tooltipStyle = { background: "var(--card)", border: "1px solid var(--border)", fontSize: 11 };

export function WardHistory({ stays, records, ward, asOf }: { stays: StayRecord[]; records: IsolateRecord[]; ward: string; asOf: string }) {
  const rows = useMemo(() => wardHistory(stays, records, ward, asOf), [stays, records, ward, asOf]);
  return <section className="space-y-3 border-t pt-3" aria-label={`${ward} histories`}>
    <div>
      <h3 className="text-sm font-semibold">Occupancy history · 12 weeks</h3>
      <div className="mt-1 flex flex-wrap gap-3 text-[10px]"><span className="text-primary">Total estimated patients</span><span className="text-muted-foreground">Marker-positive patients (dashed)</span></div>
      <div className="mt-2 h-28" aria-label="Estimated occupancy history chart">
        <ResponsiveContainer><LineChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="date" tickFormatter={(v: string) => v.slice(5)} minTickGap={35} tick={{ fontSize: 10 }} />
          <YAxis width={28} tick={{ fontSize: 10 }} allowDecimals={false} />
          <Tooltip contentStyle={tooltipStyle} />
          <Line dataKey="occupancy" name="Estimated total patients" stroke="var(--primary)" dot={false} strokeWidth={2} />
          <Line dataKey="positive" name="Estimated marker-positive patients" stroke="var(--muted-foreground)" strokeDasharray="4 3" dot={false} />
        </LineChart></ResponsiveContainer>
      </div>
    </div>
    <div>
      <h3 className="text-sm font-semibold">Resistant phenotype history</h3>
      <p className="mt-1 text-[10px] text-muted-foreground">Rolling 28-day % · ≥30 first isolates; gaps = insufficient data.</p>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {MARKERS.map((m, i) => <div key={m.key} className="min-w-0">
          <div className={`atlas-marker-${m.key} text-[10px] font-semibold`}>{m.label}</div>
          <div className="h-20" aria-label={`${m.label} history chart`}>
            <ResponsiveContainer><LineChart data={rows} margin={{ top: 4, right: 3, bottom: 0, left: 0 }}>
              <XAxis dataKey="date" hide />
              <YAxis width={30} domain={[0, "auto"]} tick={{ fontSize: 9 }} unit="%" />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => [`${Number(v).toFixed(1)}%`, m.label]} />
              <Line dataKey={m.key} stroke={COLORS[i]} strokeWidth={2} dot={{ r: 1 }} connectNulls={false} />
            </LineChart></ResponsiveContainer>
          </div>
          {rows.every((r) => r[m.key] == null) && <p className="text-[10px] text-muted-foreground">Insufficient isolates</p>}
        </div>)}
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">{rows[0]?.date} → {asOf} · All organisms; first isolate per patient / organism / specimen.</p>
    </div>
  </section>;
}