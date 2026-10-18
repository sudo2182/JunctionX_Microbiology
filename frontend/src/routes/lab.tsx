import { createFileRoute } from "@tanstack/react-router";
import { useReport } from "@/components/amr/report";
import { buildLabReport } from "@/lib/report/builders";
import { useState } from "react";
import { Field, PageHeader, Panel } from "@/components/amr/shell";
import { SimpleSelect } from "@/components/amr/selects";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ANTIBIOTICS, MARKERS, ORGANISMS, WARDS } from "@/lib/amr/reference";
import { RequireRole } from "@/lib/auth";
import { completeCultureRequest, type CultureRequest } from "@/lib/amr/cultures";
import { useLabWorklist } from "@/lib/amr/use-lab-worklist";
import { toast } from "sonner";
import { FlaskConical, Plus, RefreshCw, X } from "lucide-react";

export const Route = createFileRoute("/lab")({
  head: () => ({
    meta: [
      { title: "Laboratory — AMR Watch" },
      { name: "description", content: "Culture examination waiting list and resistance entry for the laboratory." },
      { property: "og:title", content: "Laboratory — AMR Watch" },
      { property: "og:description", content: "Culture waiting list and resistance entry." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <RequireRole role="lab">
      <PageHeader eyebrow="Laboratory" title="Laboratory" />
      <Lab />
    </RequireRole>
  ),
});

function Lab() {
  // Kept current from Supabase in real time: requests sent by doctors appear without reloading.
  const { waiting, loading, error, connection, refresh } = useLabWorklist();
  useReport(loading ? null : () => buildLabReport({ waiting }));
  const [open, setOpen] = useState<CultureRequest | null>(null);
  const openStillWaiting = !open || waiting.some((r) => r.id === open.id);

  return (
    <div className="grid gap-3 lg:grid-cols-[380px_1fr]">
      <Panel
        title={`Waiting list (${waiting.length})`}
        right={
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5" title="Updates arrive automatically from Supabase">
              <span className={`h-2 w-2 rounded-full ${connection === "live" ? "bg-success" : connection === "offline" ? "bg-destructive" : "bg-warning"}`} />
              {connection === "live" ? "Live" : connection === "offline" ? "Offline · refreshing every 30 s" : "Connecting…"}
            </span>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => void refresh()} aria-label="Refresh waiting list"><RefreshCw className="h-3.5 w-3.5" /></Button>
          </div>
        }
      >
        {error && <p role="alert" className="mb-2 text-sm text-destructive">Could not load the waiting list: {error}</p>}
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : waiting.length === 0 ? (
          <p className="text-sm text-muted-foreground">No cultures waiting.</p>
        ) : (
          <ul className="divide-y">
            {waiting.map((r) => (
              <li key={r.id}>
                <button
                  className={`flex w-full items-center gap-3 py-2 text-left text-sm ${open?.id === r.id ? "text-primary" : ""}`}
                  onClick={() => setOpen(r)}
                >
                  <FlaskConical className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="num font-medium">{r.culture_id}</span>
                  <span className="truncate text-muted-foreground">{r.patient_id} · {WARDS.find((w) => w.code === r.ward_code)?.name ?? r.ward_code} · {r.specimen}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {open && !openStillWaiting ? (
        <Panel><p className="text-sm text-muted-foreground">Culture {open.culture_id} is no longer waiting: it has already been completed.</p></Panel>
      ) : open ? <ResultForm key={open.id} req={open} onDone={() => { setOpen(null); void refresh(); }} /> : (
        <Panel><p className="text-sm text-muted-foreground">Select a culture from the waiting list to enter results.</p></Panel>
      )}
    </div>
  );
}

type Sus = Record<string, "S" | "R" | "-">;
type Iso = { key: number; organism: string; markers: number; sus: Sus };
const blank = (key: number, organism = ""): Iso => ({ key, organism, markers: 0, sus: Object.fromEntries(ANTIBIOTICS.map((a) => [a.code, "-"])) });

function ResultForm({ req, onDone }: { req: CultureRequest; onDone: () => void }) {
  const [isos, setIsos] = useState<Iso[]>(() => [blank(0, req.suspected_organism ?? "")]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const upd = (k: number, patch: Partial<Iso>) => setIsos((xs) => xs.map((x) => (x.key === k ? { ...x, ...patch } : x)));
  const valid = isos.length > 0 && isos.every((i) => i.organism);

  const submit = async () => {
    setBusy(true);
    try {
      await completeCultureRequest(
        req,
        isos.map((i) => ({
          organism: i.organism,
          markers: i.markers,
          susceptibility: ANTIBIOTICS.map((a) => (i.sus[a.code] !== "-" ? `${a.code}:${i.sus[a.code]}` : "")).filter(Boolean).join(","),
        })),
        note || undefined,
      );
      toast.success(`Culture ${req.culture_id} completed · ${isos.length} isolate${isos.length > 1 ? "s" : ""} added`);
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  return (
    <Panel title={`Culture ${req.culture_id}`}>
      <p className="mb-3 text-sm text-muted-foreground">
        {req.patient_id} · {req.sex} · {req.age_years}y · {WARDS.find((w) => w.code === req.ward_code)?.name ?? req.ward_code} · {req.specimen} · {req.sample_date}
        {req.note ? ` · ${req.note}` : ""}
      </p>
      <div className="flex flex-col gap-3">
        {isos.map((iso, idx) => (
          <div key={iso.key} className="rounded-md border p-3">
            <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto]">
              <Field label={`Organism ${idx + 1}`}><SimpleSelect className="w-full" value={iso.organism} onChange={(v) => upd(iso.key, { organism: v })} options={[{ value: "", label: "Select…" }, ...ORGANISMS.map((o) => ({ value: o, label: o }))]} /></Field>
              <Field label="Resistance markers">
                <div className="flex flex-wrap gap-2 pt-1">
                  {MARKERS.filter((m) => m.bit <= 8).map((m) => (
                    <label key={m.key} className="flex items-center gap-1.5 text-sm">
                      <input type="checkbox" checked={(iso.markers & m.bit) > 0} onChange={() => upd(iso.key, { markers: iso.markers ^ m.bit })} />
                      {m.label}
                    </label>
                  ))}
                </div>
              </Field>
              {isos.length > 1 && (
                <Button variant="ghost" size="icon" className="self-start" aria-label={`Remove organism ${idx + 1}`} onClick={() => setIsos((xs) => xs.filter((x) => x.key !== iso.key))}><X className="h-4 w-4" /></Button>
              )}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
              {ANTIBIOTICS.map((a) => (
                <div key={a.code} className="flex items-center justify-between gap-2 rounded border px-2 py-1.5 text-sm">
                  <span title={a.name}>{a.code}</span>
                  <div className="flex gap-1">
                    {(["S", "R", "-"] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => upd(iso.key, { sus: { ...iso.sus, [a.code]: v } })}
                        className={`h-6 w-6 rounded text-xs font-medium ${iso.sus[a.code] === v ? (v === "R" ? "bg-destructive text-destructive-foreground" : v === "S" ? "bg-success text-success-foreground" : "bg-muted-foreground text-background") : "bg-muted text-muted-foreground"}`}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
        <Button variant="outline" className="self-start gap-2" onClick={() => setIsos((xs) => [...xs, blank(Math.max(...xs.map((x) => x.key)) + 1)])}><Plus className="h-4 w-4" />Add organism</Button>
      </div>
      <div className="mt-4">
        <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
      <Button className="mt-5" disabled={busy || !valid} onClick={submit}>Complete and add to database</Button>
    </Panel>
  );
}
