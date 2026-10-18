import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DataGate, Field, PageHeader, Panel } from "@/components/amr/shell";
import { SimpleSelect } from "@/components/amr/selects";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ANTIBIOTICS, MARKERS, ORGANISMS, SPECIMENS, WARDS } from "@/lib/amr/reference";
import { useAmr } from "@/lib/amr/store";
import { antibioticApplicability } from "@/lib/amr/applicability";
import { CheckCircle2, Clock, TriangleAlert } from "lucide-react";
import { ageBand, FEATURE_LABELS, makeTarget, predict, train, type Features } from "@/lib/amr/risk";
import { RequireRole, useAuth } from "@/lib/auth";
import { myCultureRequests, sendCultureRequest, type CultureRequest } from "@/lib/amr/cultures";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const Route = createFileRoute("/patients")({
  head: () => ({
    meta: [
      { title: "Patients — AMR Watch" },
      { name: "description", content: "Patient resistance risk and culture requests for the laboratory." },
      { property: "og:title", content: "Patients — AMR Watch" },
      { property: "og:description", content: "Risk estimates and culture requests." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => (
    <RequireRole role="doctor">
      <PageHeader eyebrow="Patients" title="Patients" />
      <DataGate>
        <Patients />
      </DataGate>
    </RequireRole>
  ),
});

function Patients() {
  const { userId } = useAuth();
  const [requests, setRequests] = useState<CultureRequest[]>([]);

  const refresh = useCallback(() => {
    if (userId) myCultureRequests(userId).then(setRequests).catch(() => {});
  }, [userId]);

  useEffect(refresh, [refresh]);

  // Completion notification: the lab updates the row, realtime pushes it here.
  useEffect(() => {
    if (!userId) return;
    const channel = supabase
      .channel("culture-requests")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "culture_requests", filter: `requester_id=eq.${userId}` },
        (payload) => {
          const row = payload.new as CultureRequest;
          if (row.status === "completed") toast.success(`Culture ${row.culture_id} completed by the lab`);
          refresh();
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, refresh]);

  return (
    <div className="flex flex-col gap-3">
      <PatientForm userId={userId!} onSent={refresh} />
      <Panel title="My culture requests">
        {requests.length === 0 ? (
          <p className="text-sm text-muted-foreground">No cultures sent yet.</p>
        ) : (
          <ul className="divide-y">
            {requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-sm">
                <span className="num font-medium">{r.culture_id}</span>
                <span className="text-muted-foreground">{r.patient_id} · {r.ward_code} · {r.specimen} · {r.sample_date}</span>
                <span className="ml-auto flex items-center gap-1.5">
                  {r.status === "completed" ? (
                    <>
                      <CheckCircle2 className="h-4 w-4 text-success" />
                      <span className="text-success">Completed{r.result_organism ? ` · ${r.result_organism}` : ""}</span>
                    </>
                  ) : (
                    <>
                      <Clock className="h-4 w-4 text-warning" />
                      <span className="text-muted-foreground">Waiting for lab</span>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

const U = "__unknown";

const EMPTY = { sex: U, ward: U, specimen: U, organism: U, setting: U, onset: U };

function PatientForm({ userId, onSent }: { userId: string; onSent: () => void }) {
  const { records } = useAmr();
  const [target, setTarget] = useState("esbl");
  const [f, setF] = useState<Record<string, string>>(EMPTY);
  const [age, setAge] = useState("");
  const [cultureId, setCultureId] = useState("");
  const [patientId, setPatientId] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [admission, setAdmission] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const missing = [
    !cultureId.trim() && "culture ID",
    !patientId.trim() && "patient ID",
    f["sex"] === U && "sex",
    (age === "" || Number.isNaN(Number(age))) && "age",
    !date && "sample date",
    f["ward"] === U && "ward",
    f["specimen"] === U && "specimen",
  ].filter(Boolean) as string[];

  const reset = () => {
    setF(EMPTY);
    setAge("");
    setCultureId("");
    setPatientId("");
    setAdmission("");
    setNote("");
  };

  const send = async () => {
    setBusy(true);
    try {
      await sendCultureRequest(userId, {
        culture_id: cultureId.trim(),
        patient_id: patientId.trim(),
        sex: f["sex"]!,
        age_years: Number(age),
        sample_date: date,
        admission_date: admission || undefined,
        ward_code: f["ward"]!,
        specimen: f["specimen"]!,
        suspected_organism: f["organism"] !== U ? f["organism"] : undefined,
        note: note || undefined,
      });
      toast.success(`Culture ${cultureId.trim()} sent to the lab`);
      reset();
      onSent();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const model = useMemo(() => train(records, makeTarget(target)), [records, target]);
  const features: Features = {};
  for (const k in f) if (f[k] !== U) (features as Record<string, string>)[k] = f[k];
  if (age !== "" && !Number.isNaN(Number(age))) features.ageBand = ageBand(Number(age));
  const res = predict(model, features);
  const known = Object.keys(features).length;
  const rel = res.probability / res.baseline;

  const opt = (vals: { value: string; label: string }[]) => [{ value: U, label: "Unknown" }, ...vals];
  const set = (k: string) => (v: string) => setF({ ...f, [k]: v });

  return (
    <Panel title="Patient">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Field label="Culture ID"><Input value={cultureId} onChange={(e) => setCultureId(e.target.value)} placeholder="e.g. C-2026-0142" /></Field>
        <Field label="Patient ID"><Input value={patientId} onChange={(e) => setPatientId(e.target.value)} /></Field>
        <Field label="Sample date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Admission date"><Input type="date" value={admission} onChange={(e) => setAdmission(e.target.value)} /></Field>
        <Field label="Predict"><SimpleSelect className="w-full" value={target} onChange={setTarget} options={[{ value: "any", label: "Any resistance marker" }, ...MARKERS.map((m) => ({ value: m.key, label: m.label })), ...ANTIBIOTICS.map((a) => ({ value: `abx:${a.code}`, label: `Resistant to ${a.name}` }))]} /></Field>
        <Field label="Age (years)"><Input type="number" min={0} max={110} placeholder="Unknown" value={age} onChange={(e) => setAge(e.target.value)} /></Field>
        <Field label="Sex"><SimpleSelect className="w-full" value={f["sex"]} onChange={set("sex")} options={opt([{ value: "F", label: "Female" }, { value: "M", label: "Male" }])} /></Field>
        <Field label="Ward"><SimpleSelect className="w-full" value={f["ward"]} onChange={set("ward")} options={opt(WARDS.map((w) => ({ value: w.code, label: w.name })))} /></Field>
        <Field label="Specimen"><SimpleSelect className="w-full" value={f["specimen"]} onChange={set("specimen")} options={opt(SPECIMENS.map((s) => ({ value: s, label: s })))} /></Field>
        <Field label="Suspected organism"><SimpleSelect className="w-full" value={f["organism"]} onChange={set("organism")} options={opt(ORGANISMS.map((o) => ({ value: o, label: o })))} /></Field>
        <Field label="Care setting"><SimpleSelect className="w-full" value={f["setting"]} onChange={set("setting")} options={opt([{ value: "inpatient", label: "Inpatient ward" }, { value: "ed", label: "Emergency department" }, { value: "primary_care", label: "Health centre" }])} /></Field>
        <Field label="Onset"><SimpleSelect className="w-full" value={f["onset"]} onChange={set("onset")} options={opt([{ value: "community", label: "Community (< 3rd hospital day)" }, { value: "hospital", label: "Hospital (≥ 3rd hospital day)" }, { value: "outpatient", label: "Outpatient" }])} /></Field>
        <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
      {(() => {
        if (!target.startsWith("abx:")) return null;
        const code = target.slice(4);
        const orgs = f["organism"] && f["organism"] !== U ? [f["organism"]] : ORGANISMS;
        const issues = orgs.map((o) => ({ o, a: antibioticApplicability(o, code) })).filter((x) => x.a.status !== "applicable");
        if (!issues.length) return null;
        const name = ANTIBIOTICS.find((a) => a.code === code)?.name || code;
        return <div role="alert" className="mt-4 flex gap-2 rounded-md border border-warning bg-warning/15 p-3 text-sm">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div><div className="font-medium">{name} is not a guideline-supported choice for {orgs.length === 1 ? <i>{orgs[0]}</i> : "some organisms"}</div>
          <details className="mt-1 text-xs text-muted-foreground"><summary className="cursor-pointer">Details</summary><ul className="mt-1 space-y-0.5">{issues.map((x) => <li key={x.o}><i>{x.o}</i>: {x.a.reason}</li>)}</ul></details>
          <div className="mt-1 text-xs text-muted-foreground">You can still view the estimate, but it should not guide treatment.</div></div>
        </div>;
      })()}
      <div className="mt-4 flex items-center gap-6">
        <div className="num text-5xl font-medium" style={{ color: rel > 2 ? "var(--destructive)" : rel > 1.2 ? "var(--warning)" : "var(--primary)" }}>
          {(res.probability * 100).toFixed(res.probability < 0.1 ? 1 : 0)}%
        </div>
        <div className="text-sm text-muted-foreground">
          {makeTarget(target).label} · baseline {(res.baseline * 100).toFixed(1)}% · {rel.toFixed(1)}× baseline
          <div className="mt-1 text-xs">{known}/7 factors · n={res.trainedOn.toLocaleString()} · Unvalidated estimate, not treatment advice.</div>
        </div>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary transition-all" style={{ width: `${Math.min(100, res.probability * 100)}%` }} />
      </div>
      <div className="mt-3 flex gap-3">
        <Button disabled={busy || missing.length > 0} onClick={send}>Send to lab</Button>
        <Button variant="outline" onClick={reset}>Reset</Button>
        {missing.length > 0 && <span className="self-center text-xs text-muted-foreground">To send: {missing.join(", ")}</span>}
      </div>
      <details className="mt-3 border-t pt-3"><summary className="cursor-pointer text-sm font-semibold">Contributing factors</summary><div className="mt-3">
        {res.contributions.length === 0 ? (
          <p className="text-sm text-muted-foreground">Enter any known factor to see its effect.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {res.contributions.sort((a, b) => Math.abs(b.lr) - Math.abs(a.lr)).map((c) => {
              const x = Math.exp(c.lr);
              return (
                <li key={c.feature} className="flex items-center gap-3 text-sm">
                  <span className="w-28 text-muted-foreground">{FEATURE_LABELS[c.feature as keyof Features]}</span>
                  <span className="flex-1 truncate">{c.value}</span>
                  <span className="num" style={{ color: x > 1.1 ? "var(--destructive)" : x < 0.9 ? "var(--success)" : "var(--muted-foreground)" }}>×{x.toFixed(2)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div></details>
    </Panel>
  );
}
