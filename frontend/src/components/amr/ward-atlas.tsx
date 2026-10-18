import { useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { BedDouble, Building2, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { wardOverview } from "@/lib/amr/occupancy";
import type { IsolateRecord, StayRecord } from "@/lib/amr/store";
import { AntibioticGuidance } from "./antibiotic-guidance";
import { heatVar } from "./shell";
import { WardHistory } from "./ward-history";

type Ward = ReturnType<typeof wardOverview>[number];

function Percentage({ rate }: { rate: Ward["rates"][number] }) {
  return <span className="num" title={`${rate.positive} positive / ${rate.n} first isolates`}>{rate.pct === null ? `— (n=${rate.n})` : `${rate.pct.toFixed(1)}%`}</span>;
}

function WardTile({ ward, selected, onSelect }: { ward: Ward; selected: boolean; onSelect: () => void }) {
  const rates = ward.rates.flatMap((r) => r.pct === null ? [] : [r.pct]);
  const highest = rates.length ? Math.max(...rates) : null;
  return <Button variant="ghost" className="atlas-tile w-full text-foreground" aria-label={`Select ${ward.name}`} aria-pressed={selected} onClick={onSelect} style={{ backgroundColor: heatVar(highest) }}>
    <div className="flex items-start gap-2"><BedDouble className="mt-0.5 shrink-0" /><span className="min-w-0 flex-1 font-semibold">{ward.name}</span><span className="num text-[10px] text-muted-foreground">{ward.code}</span></div>
    <div className="my-1.5 flex items-baseline gap-2"><span className="num text-3xl font-semibold">{ward.patients}</span><span className="text-xs text-muted-foreground">marker-positive patients</span></div>
    <div className="mb-2 text-[11px] text-muted-foreground"><span className="num font-semibold">{ward.occupancy}</span> estimated total patients</div>

    <div className="mt-auto grid grid-cols-4 gap-2 border-t border-foreground/10 pt-2">{ward.markers.map((m) => <div key={m.key}><div className={`atlas-marker-${m.key} text-[10px] font-semibold`}>{m.label}</div><div className="num mt-0.5 text-sm">{m.patients}</div></div>)}</div>
  </Button>;
}

export function WardAtlas({ stays, records, asOf, onDateChange, side }: { stays: StayRecord[]; records: IsolateRecord[]; asOf: string; onDateChange: (date: string) => void; side?: ReactNode }) {
  const [wardCode, setWardCode] = useState("MED-A");
  const [scope, setScope] = useState("hospital");
  const wards = useMemo(() => wardOverview(stays, records, asOf), [stays, records, asOf]);
  const ward = wards.find((w) => w.code === wardCode) || wards[0];
  const shown = wards.filter((w) => w.institution === (scope === "hospital" ? "hospital" : "primary_care"));
  if (!ward) return null;
  return <div className="space-y-3">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><h1 className="text-xl font-semibold">Hospital ward atlas</h1></div>
      <div className="flex items-center gap-3"><Badge variant="outline">Synthetic dataset</Badge><label className="text-xs text-muted-foreground">Estimate date<Input className="mt-1 w-40 bg-card" aria-label="Occupancy estimate date" type="date" value={asOf} onChange={(e) => e.target.value && onDateChange(e.target.value)} /></label></div>
    </div>
    <div className="grid items-start gap-3 md:grid-cols-[260px_minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,1fr)_320px]">
      <aside className="min-w-0 border bg-card p-4 md:max-h-[calc(100vh-150px)] md:overflow-y-auto" aria-label="Selected ward details">
        <div className="flex flex-wrap items-center gap-2"><BedDouble className="h-6 w-6 text-primary" /><h2 className="text-2xl font-semibold">{ward.code}</h2><Badge className="ml-auto">Selected ward</Badge></div><p className="mt-1 text-sm text-muted-foreground">{ward.name}</p>
        <div className="my-3 border-y py-3"><div className="text-xs text-muted-foreground">Marker-positive patients</div><div className="num mt-1 text-4xl font-semibold text-primary">{ward.patients}</div><div className="mt-2 text-xs text-muted-foreground"><span className="num font-semibold">{ward.occupancy}</span> estimated total patients in this ward</div><p className="mt-2 text-[10px] text-muted-foreground">As of {asOf} · Test-based estimate, not confirmed bed occupancy; capacity unavailable.</p></div>
        <Button asChild variant="ghost" className="mb-3 h-auto w-full flex-col items-stretch whitespace-normal border p-3 text-left">
          <Link to="/wards" search={{ ward: ward.code, date: asOf }} aria-label={`View resistance analysis for ${ward.name}`}>
            <div className="flex items-center justify-between gap-2 text-sm font-semibold">Resistance overview<ArrowUpRight className="h-4 w-4" /></div>
            <div className="text-[10px] font-normal text-muted-foreground">Marker-positive % · latest 28 days</div>
            <div className="grid grid-cols-4 gap-2">{ward.rates.map((r) => <div key={r.key}><div className={`atlas-marker-${r.key} text-xs font-semibold`}>{r.label}</div><div className="mt-1 text-xs"><Percentage rate={r} /></div></div>)}</div>
            <div className="text-[10px] font-normal text-muted-foreground">All first isolates; ≥30 required. Antibiotic-specific results in ward resistance.</div>
          </Link>
        </Button>
        <WardHistory stays={stays} records={records} ward={ward.code} asOf={asOf} />
        <h3 className="border-t pt-4 text-sm font-semibold">Organisms in estimated positive cases</h3>
        {ward.organisms.length ? <div className="my-3 space-y-3">{ward.organisms.map((o) => <div key={o.organism} className="border-b pb-3"><div className="flex flex-wrap items-start justify-between gap-1"><span className="text-sm italic">{o.organism}</span><span className="num text-xs text-muted-foreground">{o.patients} patients</span></div><div className="mt-2 flex flex-wrap gap-2">{o.markers.map((m) => { const rate = o.rates.find((r) => r.key === m.key); return <Badge variant="outline" key={m.key} className={`atlas-marker-${m.key}`}>{m.label}{rate && <Percentage rate={rate} />}</Badge>; })}</div></div>)}</div> : <p className="my-4 text-sm text-muted-foreground">No estimated marker-positive cases in this ward.</p>}
        {ward.organisms.length > 0 && <AntibioticGuidance organisms={ward.organisms.map((o) => o.organism)} uncomplicatedUTI={false} />}
        <Link to="/wards" search={{ ward: ward.code, date: asOf }} className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-primary">Full ward resistance analysis<ArrowUpRight className="h-3 w-3" /></Link>
      </aside>
      <section className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div className="flex gap-1" aria-label="Facility scope">{["hospital", "community"].map((s) => <Button key={s} size="sm" variant={scope === s ? "default" : "ghost"} aria-pressed={scope === s} onClick={() => { setScope(s); const first = wards.find((w) => w.institution === (s === "hospital" ? "hospital" : "primary_care")); if (first) setWardCode(first.code); }}>{s === "hospital" ? "Hospital wards" : "Health centres"}</Button>)}</div><span className="text-xs text-muted-foreground">Schematic · not a floor plan</span></div>
        <div className="atlas-board border bg-secondary/40 p-3 md:p-4">
          <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground"><Building2 className="h-4 w-4" />{scope === "hospital" ? "Hospital" : "Primary care"}<span className="ml-auto">Grouped by service · locations unverified</span></div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{shown.map((w) => <WardTile key={w.code} ward={w} selected={wardCode === w.code} onSelect={() => setWardCode(w.code)} />)}</div>
          <div className="mt-3 border-t pt-2"><div className="mb-2 text-xs font-medium">Highest 28-day marker-positive % · ≥30 first isolates</div><div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground">{["<5%", "5–9.9%", "10–19.9%", "20–39.9%", "≥40%", "Insufficient data"].map((label, i) => <span key={label} className="flex items-center gap-1"><span className="h-2.5 w-5 border" style={{ backgroundColor: i === 5 ? "var(--muted)" : `var(--heat-${i})` }} />{label}</span>)}</div></div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">Estimated from test dates · not confirmed occupancy, an outbreak determination or an isolation recommendation.</p>
      </section>
      {side && <div className="min-w-0 md:col-span-2 xl:col-span-1">{side}</div>}
    </div>
  </div>;
}