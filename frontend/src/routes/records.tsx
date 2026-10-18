import { createFileRoute } from "@tanstack/react-router";
import { useReport } from "@/components/amr/report";
import { buildRecordsReport } from "@/lib/report/builders";
import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Plus, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { DataGate, Field, PageHeader, Panel } from "@/components/amr/shell";
import { SimpleSelect } from "@/components/amr/selects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ANTIBIOTICS, MARKERS, ORGANISMS, SPECIMENS, WARDS, shortOrg } from "@/lib/amr/reference";
import { addRecords, deleteRecord, latestSampleDate, useAmr, type NewRecord } from "@/lib/amr/store";
import { parseUpload, recordKey, templateExample, templateHead } from "@/lib/amr/upload";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/records")({
  // ?q= pre-fills the ID search, so alerts can link to the exact record they came from.
  validateSearch: (search: Record<string, unknown>): { q?: string | undefined } => ({
    q: typeof search["q"] === "string" && search["q"].length <= 100 ? search["q"] : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Isolate records — AMR Watch" },
      { name: "description", content: "Browse, filter, add and export microbiology isolate records." },
      { property: "og:title", content: "Isolate records — AMR Watch" },
      { property: "og:description", content: "Browse and add microbiology isolate records." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => (
    <>
      <PageHeader eyebrow="Database" title="Isolate records">
        <LabWriteControls />
      </PageHeader>
      <DataGate>
        <Records />
      </DataGate>
    </>
  ),
});

const PAGE = 50;

/** Adding isolate records is a laboratory task; doctors can browse and export. */
function LabWriteControls() {
  if (useAuth().activeRole !== "lab") return null;
  return (
    <>
      <BulkUploadDialog />
      <AddRecordDialog />
    </>
  );
}

function Records() {
  const { records } = useAmr();
  const canDelete = useAuth().activeRole === "lab";
  const search = Route.useSearch();
  const [q, setQ] = useState(search.q ?? "");
  const [org, setOrg] = useState("all");
  const [ward, setWard] = useState("all");
  const [marker, setMarker] = useState("all");
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    const m = MARKERS.find((x) => x.key === marker);
    return records
      .filter((r) => (org === "all" || r.organism === org) && (ward === "all" || r.ward === ward) && (marker === "all" || (marker === "user" ? r.pending : m && r.flags & m.bit)) && (!s || r.id.toLowerCase().includes(s) || r.patient.toLowerCase().includes(s)))
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [records, q, org, ward, marker]);

  const filterLabel = [org === "all" ? "all organisms" : org, ward === "all" ? "all locations" : ward, marker === "all" ? "any marker" : marker === "user" ? "added from dashboard" : marker.toUpperCase(), q.trim() ? `ID contains "${q.trim()}"` : ""].filter(Boolean).join(" · ");
  useReport(records.length ? () => buildRecordsReport({ records: filtered, filterLabel }) : null);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const rows = filtered.slice(page * PAGE, page * PAGE + PAGE);
  const reset = (fn: (v: string) => void) => (v: string) => (fn(v), setPage(0));

  const exportCsv = () => {
    const head = ["isolate_id", "patient_id", "sex", "age", "sample_date", "admission_date", "ward", "specimen", "organism", "esbl", "mrsa", "vre", "cpe", ...ANTIBIOTICS.map((a) => a.code)];
    const lines = filtered.map((r) => [r.id, r.patient, r.sex, r.age, r.date, r.admission, r.ward, r.specimen, r.organism, ...MARKERS.map((m) => (r.flags & m.bit ? 1 : 0)), ...r.sus.split("").map((c) => (c === "-" ? "" : c))].join(","));
    const blob = new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "isolates.csv";
    a.click();
  };

  return (
    <Panel>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Search ID"><Input className="w-52" placeholder="Isolate or patient ID" value={q} onChange={(e) => reset(setQ)(e.target.value)} /></Field>
        <Field label="Organism"><SimpleSelect className="w-56" value={org} onChange={reset(setOrg)} options={[{ value: "all", label: "All organisms" }, ...ORGANISMS.map((o) => ({ value: o, label: o }))]} /></Field>
        <Field label="Ward"><SimpleSelect className="w-52" value={ward} onChange={reset(setWard)} options={[{ value: "all", label: "All wards" }, ...WARDS.map((w) => ({ value: w.code, label: w.name }))]} /></Field>
        <Field label="Filter"><SimpleSelect className="w-44" value={marker} onChange={reset(setMarker)} options={[{ value: "all", label: "All records" }, ...MARKERS.map((m) => ({ value: m.key, label: `${m.label} positive` })), { value: "user", label: "Added here" }]} /></Field>
        <Button variant="outline" onClick={exportCsv} className="ml-auto"><Download className="mr-1 h-4 w-4" />Export CSV</Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="eyebrow text-left">
            <tr className="border-b">
              <th className="p-2">Isolate</th><th className="p-2">Patient</th><th className="p-2">Date</th><th className="p-2">Ward</th><th className="p-2">Specimen</th><th className="p-2">Organism</th><th className="p-2">Markers</th><th className="p-2">Resistant to</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b last:border-0 hover:bg-muted/50">
                <td className="num p-2 text-xs">{r.id}{r.pending && <Badge className="ml-2" variant="outline">new</Badge>}</td>
                <td className="num p-2 text-xs">{r.patient} <span className="text-muted-foreground">{r.sex}/{r.age}</span></td>
                <td className="num p-2 text-xs">{r.date}</td>
                <td className="p-2">{r.ward}</td>
                <td className="p-2">{r.specimen}</td>
                <td className="p-2 italic">{shortOrg(r.organism)}</td>
                <td className="p-2">{MARKERS.filter((m) => r.flags & m.bit).map((m) => <Badge key={m.key} className="mr-1 bg-destructive text-destructive-foreground">{m.label}</Badge>)}</td>
                <td className="num p-2 text-xs text-muted-foreground">{ANTIBIOTICS.filter((_, i) => r.sus[i] === "R").map((a) => a.code).join(" ")}</td>
                <td className="p-2">{r.pending && canDelete && <button aria-label="Delete record" onClick={() => deleteRecord(r.id).catch((e: unknown) => toast.error(e instanceof Error ? e.message : "Could not delete the record"))}><Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive" /></button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
        <span className="num">{filtered.length.toLocaleString()} records</span>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
          <span className="num">{page + 1} / {pages}</span>
          <Button size="sm" variant="outline" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Next</Button>
        </div>
      </div>
    </Panel>
  );
}

function BulkUploadDialog() {
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState<NewRecord[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [duplicates, setDuplicates] = useState(0);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { records } = useAmr();

  const take = async (file: File) => {
    // Records already in the database (pipeline + earlier uploads) are skipped, so re-uploading a file is safe.
    const parsed = parseUpload(await file.text(), { existing: new Set(records.map(recordKey)) });
    setReady(parsed.rows);
    setProblems(parsed.problems);
    setDuplicates(parsed.duplicates);
  };

  const save = () => {
    if (!ready.length) return;
    setSaving(true);
    addRecords(ready)
      .then((n) => {
        toast.success(`${n} record${n === 1 ? "" : "s"} saved`);
        setOpen(false);
        setReady([]);
        setProblems([]);
        setDuplicates(0);
        if (fileRef.current) fileRef.current.value = "";
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : "Could not save the records"))
      .finally(() => setSaving(false));
  };

  const template = () => {
    const blob = new Blob([[templateHead().join(","), templateExample().join(",")].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "amr-upload-template.csv";
    a.click();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline"><Upload className="mr-1 h-4 w-4" />Bulk upload</Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Upload isolate records</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">A CSV with one row per isolate. Columns: patient_id, sex, age, sample_date, admission_date, ward, specimen, organism, then esbl/mrsa/vre/cpe as 0 or 1, then one column per antibiotic with S or R.</p>
          <div className="flex flex-wrap items-center gap-3">
            <Input ref={fileRef} type="file" accept=".csv,text/csv" className="file:mr-3 file:rounded file:border-0 file:bg-secondary file:px-3 file:py-1 file:text-xs" onChange={(e) => { const f = e.target.files?.[0]; if (f) void take(f); }} />
            <Button variant="ghost" size="sm" onClick={template}><Download className="mr-1 h-3.5 w-3.5" />Template</Button>
          </div>
          {(ready.length > 0 || problems.length > 0) && (
            <div className="rounded border bg-secondary/40 p-3 text-sm">
              <span className="num font-semibold">{ready.length}</span> records ready
              {problems.length > 0 && <span className="text-muted-foreground"> · {problems.length} row(s) skipped{duplicates > 0 ? ` (${duplicates} duplicate${duplicates === 1 ? "" : "s"})` : ""}</span>}
              {problems.length > 0 && <ul className="mt-2 max-h-28 overflow-y-auto text-xs text-muted-foreground">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
            </div>
          )}
          <Button onClick={save} disabled={!ready.length || saving}>{saving ? "Saving…" : `Save ${ready.length || ""} record${ready.length === 1 ? "" : "s"}`}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AddRecordDialog() {
  const { records } = useAmr();
  // Default to the latest sample already in the database so a new entry lands in the current reporting period.
  const latestDate = useMemo(() => latestSampleDate(records), [records]);
  const init = { patient: "", sex: "F", age: "", date: latestDate, admission: "", ward: "MED-A", specimen: "urine", organism: "Escherichia coli" };
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(init);
  const [dateTouched, setDateTouched] = useState(false);
  const [flags, setFlags] = useState(0);
  const [sus, setSus] = useState<string[]>(ANTIBIOTICS.map(() => "-"));
  const [saving, setSaving] = useState(false);

  // The dialog mounts while the database is still loading, so adopt the reporting
  // period as soon as it is known instead of keeping the pre-load fallback.
  useEffect(() => {
    if (!dateTouched && latestDate) setF((s) => (s.date === latestDate ? s : { ...s, date: latestDate }));
  }, [latestDate, dateTouched]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const age = Number(f.age);
    if (!f.patient.trim() || f.age === "" || Number.isNaN(age) || !f.date) {
      toast.error("Patient ID, age and sample date are required");
      return;
    }
    if (f.admission && f.admission > f.date) {
      toast.error("Admission date must be before the sample date");
      return;
    }
    setSaving(true);
    addRecords([{
      patient: f.patient.trim(),
      sex: f.sex,
      age,
      date: f.date,
      admission: f.admission || undefined,
      ward: f.ward,
      specimen: f.specimen,
      organism: f.organism,
      markers: flags,
      sus: ANTIBIOTICS.map((_, i) => sus[i] ?? "-").join(""),
    }])
      .then(() => {
        toast.success("Record saved — all charts now include it");
        setOpen(false);
        setF(init);
        setDateTouched(false);
        setFlags(0);
        setSus(ANTIBIOTICS.map(() => "-"));
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : "Could not save the record"))
      .finally(() => setSaving(false));
  };
  const set = (k: keyof typeof init) => (v: string) => setF({ ...f, [k]: v });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button><Plus className="mr-1 h-4 w-4" />Add record</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader><DialogTitle>New isolate record</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Patient ID"><Input value={f.patient} onChange={(e) => set("patient")(e.target.value)} placeholder="P012345" /></Field>
            <Field label="Sex"><SimpleSelect className="w-full" value={f.sex} onChange={set("sex")} options={[{ value: "F", label: "Female" }, { value: "M", label: "Male" }]} /></Field>
            <Field label="Age"><Input type="number" min={0} max={120} value={f.age} onChange={(e) => set("age")(e.target.value)} /></Field>
            <Field label="Sample date"><Input type="date" value={f.date} onChange={(e) => { setDateTouched(true); set("date")(e.target.value); }} /></Field>
            <Field label="Admission date (if inpatient)"><Input type="date" value={f.admission} onChange={(e) => set("admission")(e.target.value)} /></Field>
            <Field label="Ward"><SimpleSelect className="w-full" value={f.ward} onChange={set("ward")} options={WARDS.map((w) => ({ value: w.code, label: w.name }))} /></Field>
            <Field label="Specimen"><SimpleSelect className="w-full" value={f.specimen} onChange={set("specimen")} options={SPECIMENS.map((s) => ({ value: s, label: s }))} /></Field>
            <Field label="Organism"><SimpleSelect className="w-full" value={f.organism} onChange={set("organism")} options={ORGANISMS.map((o) => ({ value: o, label: o }))} /></Field>
          </div>
          <div>
            <div className="eyebrow mb-2">Resistance markers</div>
            <div className="flex gap-5">
              {MARKERS.map((m) => (
                <label key={m.key} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={(flags & m.bit) > 0} onCheckedChange={(c) => setFlags(c ? flags | m.bit : flags & ~m.bit)} /> {m.label}
                </label>
              ))}
            </div>
          </div>
          <div>
            <div className="eyebrow mb-2">Susceptibility results</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {ANTIBIOTICS.map((a, i) => (
                <div key={a.code} className="flex items-center justify-between gap-2 rounded border p-1.5 pl-2 text-xs">
                  <span title={a.name} className="num">{a.code}</span>
                  <div className="flex">
                    {["-", "S", "R"].map((v) => (
                      <button type="button" key={v} onClick={() => setSus(ANTIBIOTICS.map((_, j) => (j === i ? v : sus[j] ?? "-")))} className={`num w-7 rounded py-0.5 ${(sus[i] ?? "-") === v ? (v === "R" ? "bg-destructive text-destructive-foreground" : v === "S" ? "bg-success text-primary-foreground" : "bg-muted") : "text-muted-foreground"}`}>
                        {v === "-" ? "–" : v}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save record"}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
