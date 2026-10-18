import { useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { BedDouble, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { wardOverview } from "@/lib/amr/occupancy";
import type { IsolateRecord, StayRecord } from "@/lib/amr/store";
import { ExternalPanel } from "./external-panel";
import { heatVar } from "./shell";

type Ward = ReturnType<typeof wardOverview>[number];

/** A ward tile opens that ward's full resistance analysis for the same date. */
function WardTile({ ward, asOf }: { ward: Ward; asOf: string }) {
  const rates = ward.rates.flatMap((r) => r.pct === null ? [] : [r.pct]);
  const highest = rates.length ? Math.max(...rates) : null;
  return <Button asChild variant="ghost" className="atlas-tile w-full text-foreground" style={{ backgroundColor: heatVar(highest) }}><Link to="/wards" search={{ ward: ward.code, date: asOf }} aria-label={`Open resistance analysis for ${ward.name}`}>
    <div className="flex items-start gap-2"><BedDouble className="mt-0.5 shrink-0" /><span className="min-w-0 flex-1 font-semibold">{ward.name}</span><span className="num text-[10px] text-muted-foreground">{ward.code}</span></div>
    <div className="my-1.5 flex items-baseline gap-2"><span className="num text-3xl font-semibold">{ward.patients}</span><span className="text-xs text-muted-foreground">marker-positive patients</span></div>
    <div className="mb-2 text-[11px] text-muted-foreground"><span className="num font-semibold">{ward.occupancy}</span> estimated total patients</div>

    <div className="mt-auto grid grid-cols-4 gap-2 border-t border-foreground/10 pt-2">{ward.markers.map((m) => <div key={m.key}><div className={`atlas-marker-${m.key} text-[10px] font-semibold`}>{m.label}</div><div className="num mt-0.5 text-sm">{m.patients}</div></div>)}</div>
  </Link></Button>;
}

export function WardAtlas({ stays, records, asOf, onDateChange, side }: { stays: StayRecord[]; records: IsolateRecord[]; asOf: string; onDateChange: (date: string) => void; side?: ReactNode }) {
  const [scope, setScope] = useState("hospital");
  const wards = useMemo(() => wardOverview(stays, records, asOf), [stays, records, asOf]);
  const shown = wards.filter((w) => w.institution === (scope === "hospital" ? "hospital" : "primary_care"));
  return <div className="space-y-3">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><h1 className="text-xl font-semibold">Hospital ward atlas</h1></div>
      <div className="flex items-center gap-3"><Badge variant="outline">Synthetic dataset</Badge><label className="text-xs text-muted-foreground">Estimate date<Input className="mt-1 w-40 bg-card" aria-label="Occupancy estimate date" type="date" value={asOf} onChange={(e) => e.target.value && onDateChange(e.target.value)} /></label></div>
    </div>
    <div className="grid items-start gap-3 md:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)_320px]">
      <ExternalPanel />
      <section className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div className="flex gap-1" aria-label="Facility scope">{["hospital", "community"].map((s) => <Button key={s} size="sm" variant={scope === s ? "default" : "ghost"} aria-pressed={scope === s} onClick={() => setScope(s)}>{s === "hospital" ? "Hospital wards" : "Health centres"}</Button>)}</div><span className="text-xs text-muted-foreground">Schematic · not a floor plan</span></div>
        <div className="atlas-board border bg-secondary/40 p-3 md:p-4">
          <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground"><Building2 className="h-4 w-4" />{scope === "hospital" ? "Hospital" : "Primary care"}<span className="ml-auto">Grouped by service · locations unverified</span></div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{shown.map((w) => <WardTile key={w.code} ward={w} asOf={asOf} />)}</div>
          <div className="mt-3 border-t pt-2"><div className="mb-2 text-xs font-medium">Highest 28-day marker-positive % · ≥30 first isolates</div><div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground">{["<5%", "5–9.9%", "10–19.9%", "20–39.9%", "≥40%", "Insufficient data"].map((label, i) => <span key={label} className="flex items-center gap-1"><span className="h-2.5 w-5 border" style={{ backgroundColor: i === 5 ? "var(--muted)" : `var(--heat-${i})` }} />{label}</span>)}</div></div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">Estimated from test dates · not confirmed occupancy, an outbreak determination or an isolation recommendation.</p>
      </section>
      {side && <div className="min-w-0 md:col-span-2 xl:col-span-1">{side}</div>}
    </div>
  </div>;
}