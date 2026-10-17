import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { DataGate, Field, PageHeader, Panel } from "@/components/amr/shell";
import { SimpleSelect } from "@/components/amr/selects";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ANTIBIOTICS, MARKERS, ORGANISMS, SPECIMENS, WARDS } from "@/lib/amr/reference";
import { useAmr } from "@/lib/amr/store";
import { antibioticApplicability } from "@/lib/amr/applicability";
import { TriangleAlert } from "lucide-react";
import { ageBand, FEATURE_LABELS, makeTarget, predict, train, type Features } from "@/lib/amr/risk";

export const Route = createFileRoute("/risk")({
  head: () => ({
    meta: [
      { title: "Resistance risk predictor — AMR Watch" },
      { name: "description", content: "Estimate a patient's risk of a resistant infection from incomplete information." },
      { property: "og:title", content: "Resistance risk predictor — AMR Watch" },
      { property: "og:description", content: "Risk estimate from incomplete patient data." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => (
    <>
      <PageHeader eyebrow="Prediction" title="Patient resistance risk" />
      <DataGate>
        <Risk />
      </DataGate>
    </>
  ),
});

const U = "__unknown";

function Risk() {
  const { records } = useAmr();
  const [target, setTarget] = useState("esbl");
  const [f, setF] = useState<Record<string, string>>({ sex: U, ward: U, specimen: U, organism: U, setting: U, onset: U });
  const [age, setAge] = useState("");

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
    <div className="grid gap-3 lg:grid-cols-[1fr_420px]">
      <Panel title="Patient information — fill in what you know">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Predict"><SimpleSelect className="w-full" value={target} onChange={setTarget} options={[{ value: "any", label: "Any resistance marker" }, ...MARKERS.map((m) => ({ value: m.key, label: m.label })), ...ANTIBIOTICS.map((a) => ({ value: `abx:${a.code}`, label: `Resistant to ${a.name}` }))]} /></Field>
          <Field label="Age (years)"><Input type="number" min={0} max={110} placeholder="Unknown" value={age} onChange={(e) => setAge(e.target.value)} /></Field>
          <Field label="Sex"><SimpleSelect className="w-full" value={f["sex"]} onChange={set("sex")} options={opt([{ value: "F", label: "Female" }, { value: "M", label: "Male" }])} /></Field>
          <Field label="Ward"><SimpleSelect className="w-full" value={f["ward"]} onChange={set("ward")} options={opt(WARDS.map((w) => ({ value: w.code, label: w.name })))} /></Field>
          <Field label="Specimen"><SimpleSelect className="w-full" value={f["specimen"]} onChange={set("specimen")} options={opt(SPECIMENS.map((s) => ({ value: s, label: s })))} /></Field>
          <Field label="Suspected organism"><SimpleSelect className="w-full" value={f["organism"]} onChange={set("organism")} options={opt(ORGANISMS.map((o) => ({ value: o, label: o })))} /></Field>
          <Field label="Care setting"><SimpleSelect className="w-full" value={f["setting"]} onChange={set("setting")} options={opt([{ value: "inpatient", label: "Inpatient ward" }, { value: "ed", label: "Emergency department" }, { value: "primary_care", label: "Health centre" }])} /></Field>
          <Field label="Onset"><SimpleSelect className="w-full" value={f["onset"]} onChange={set("onset")} options={opt([{ value: "community", label: "Community (< 3rd hospital day)" }, { value: "hospital", label: "Hospital (≥ 3rd hospital day)" }, { value: "outpatient", label: "Outpatient" }])} /></Field>
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
            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">{issues.map((x) => <li key={x.o}><i>{x.o}</i>: {x.a.reason}</li>)}</ul>
            <div className="mt-1 text-xs text-muted-foreground">You can still view the estimate, but it should not guide treatment.</div></div>
          </div>;
        })()}
        <Button variant="outline" className="mt-5" onClick={() => (setF({ sex: U, ward: U, specimen: U, organism: U, setting: U, onset: U }), setAge(""))}>Reset</Button>
      </Panel>

      <div className="flex flex-col gap-3">
        <Panel title="Estimated risk">
          <div className="num text-6xl font-medium" style={{ color: rel > 2 ? "var(--destructive)" : rel > 1.2 ? "var(--warning)" : "var(--primary)" }}>
            {(res.probability * 100).toFixed(res.probability < 0.1 ? 1 : 0)}%
          </div>
          <div className="mt-2 text-sm text-muted-foreground">
            {makeTarget(target).label} · baseline {(res.baseline * 100).toFixed(1)}% · {rel.toFixed(1)}× baseline
          </div>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary transition-all" style={{ width: `${Math.min(100, res.probability * 100)}%` }} />
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Based on {known} of 7 known factors and {res.trainedOn.toLocaleString()} isolates. Unknown factors are left out, so the estimate falls back toward the baseline. Decision support only.
          </p>
        </Panel>
        <Panel title="What drives this estimate">
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
        </Panel>
      </div>
    </div>
  );
}
