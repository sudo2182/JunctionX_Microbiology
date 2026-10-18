import { createFileRoute } from "@tanstack/react-router";
import { useReport } from "@/components/amr/report";
import { buildDetectionReport } from "@/lib/report/builders";
import { useState } from "react";
import { toast } from "sonner";
import { DataGate, Field, PageHeader, Panel } from "@/components/amr/shell";
import { SimpleSelect } from "@/components/amr/selects";
import { Switch } from "@/components/ui/switch";
import { commonAntibiotics } from "@/lib/amr/applicability";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MARKERS, ORGANISMS, WARDS, weekStart } from "@/lib/amr/reference";
import { addAlert, maxWeek, useAmr } from "@/lib/amr/store";
import { type Cluster, type ScanModel } from "@/lib/amr/satscan";
import { clusterScan } from "@/lib/amr/surveillance";

export const Route = createFileRoute("/detection")({
  head: () => ({
    meta: [
      { title: "SaTScan cluster detection — AMR Watch" },
      { name: "description", content: "Space-time scan statistics to detect emerging clusters of resistant bacteria." },
      { property: "og:title", content: "SaTScan cluster detection — AMR Watch" },
      { property: "og:description", content: "Detect emerging space-time clusters of resistant bacteria." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => (
    <>
      <PageHeader eyebrow="Detection" title="Space-time cluster detection (SaTScan)" />
      <DataGate>
        <Detection />
      </DataGate>
    </>
  ),
});

function Detection() {
  const { records } = useAmr();
  const last = maxWeek(records);
  const [model, setModel] = useState<ScanModel>("stp");
  const [org, setOrg] = useState("all");
  const [caseDef, setCaseDef] = useState("esbl");
  const [study, setStudy] = useState("52");
  const [maxWin, setMaxWin] = useState("4");
  const [mode, setMode] = useState("prospective");
  const [reps, setReps] = useState("199");
  const [result, setResult] = useState<{ clusters: Cluster[]; cases: number; start: number; locLabel: (s: string) => string } | null>(null);
  const [running, setRunning] = useState(false);
  const [overlapping, setOverlapping] = useState(true);
  const [limit, setLimit] = useState("20");
  const [pLimit, setPLimit] = useState("1");
  const available = commonAntibiotics(org === "all" ? ORGANISMS : [org]);
  const activeCase = caseDef.startsWith("abx:") && !available.some((a) => caseDef === `abx:${a.code}`) ? "esbl" : caseDef;

  const run = () => {
    setRunning(true);
    setTimeout(() => {
      // Shared with the assistant (lib/amr/surveillance), so both find the same clusters.
      const { clusters, cases: nCases, start } = clusterScan(records, {
        model, organism: org, caseDefinition: activeCase, studyWeeks: Number(study), maxWindow: Number(maxWin),
        prospective: mode === "prospective", replications: Number(reps), maxClusters: Number(limit), includeOverlapping: overlapping, lastWeek: last,
      });
      const locLabel = (s: string) => WARDS.find((w) => w.code === s)?.name ?? s;
      setResult({ clusters, cases: nCases, start, locLabel });
      setRunning(false);
    }, 20);
  };

  const caseLabel = MARKERS.find((m) => m.key === activeCase)?.label ?? (activeCase === "all" ? "all isolates" : `${activeCase.slice(4)}-resistant`);
  useReport(records.length ? () => buildDetectionReport({
    records,
    settings: { model, organism: org, caseDefinition: activeCase, studyWeeks: Number(study), maxWindow: Number(maxWin), prospective: mode === "prospective", replications: Number(reps), maxClusters: Number(limit), includeOverlapping: overlapping, lastWeek: last },
    caseLabel,
    pLimit: Number(pLimit),
  }) : null);
  const pushAlert = (c: Cluster) => {
    if (!result) return;
    addAlert({
      title: `SaTScan ${c.p < 0.05 ? "significant candidate" : "non-significant candidate"}: ${caseLabel} cluster in ${c.zone.map(result.locLabel).join(" + ")}`,
      summary: `${c.observed} observed vs ${c.expected.toFixed(1)} expected (RR ${c.rr.toFixed(2)}), weeks ${weekStart(result.start + c.start)} → ${weekStart(result.start + c.end)}, p = ${c.p.toFixed(3)}.`,
      region: "Hospital",
      organism: org === "all" ? undefined : org,
      severity: c.p < 0.01 ? "warning" : c.p < 0.05 ? "watch" : "info",
      date: weekStart(result.start + c.end),
      source: "satscan",
    })
      .then(() => toast.success("Cluster sent to the alert feed"))
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : "Could not send the cluster"));
  };

  return (
    <div className="flex flex-col gap-3">
      <Panel title="Analysis settings">
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Probability model"><SimpleSelect className="w-60" value={model} onChange={(v) => setModel(v as ScanModel)} options={[{ value: "stp", label: "Space-time permutation" }, { value: "bernoulli", label: "Bernoulli (cases vs non-cases)" }]} /></Field>
          <Field label="Organism"><SimpleSelect className="w-56" value={org} onChange={setOrg} options={[{ value: "all", label: "All organisms" }, ...ORGANISMS.map((o) => ({ value: o, label: o }))]} /></Field>
          <Field label="Case definition"><SimpleSelect className="w-56" value={activeCase} onChange={setCaseDef} options={[{ value: "all", label: "Any isolate" }, ...MARKERS.map((m) => ({ value: m.key, label: m.label })), ...available.map((a) => ({ value: `abx:${a.code}`, label: `Resistant to ${a.name}` }))]} /></Field>
          <Field label="Study period"><SimpleSelect className="w-36" value={study} onChange={setStudy} options={["26", "52", "104", "156"].map((v) => ({ value: v, label: `Last ${v} weeks` }))} /></Field>
          <Field label="Max cluster length"><SimpleSelect className="w-32" value={maxWin} onChange={setMaxWin} options={["2", "4", "8", "13"].map((v) => ({ value: v, label: `${v} weeks` }))} /></Field>
          <Field label="Scan type"><SimpleSelect className="w-52" value={mode} onChange={setMode} options={[{ value: "prospective", label: "Prospective (ongoing)" }, { value: "retrospective", label: "Retrospective" }]} /></Field>
          <Field label="Monte Carlo reps"><SimpleSelect className="w-28" value={reps} onChange={setReps} options={["99", "199", "999"].map((v) => ({ value: v, label: v }))} /></Field>
          <Field label="Candidates"><SimpleSelect className="w-28" value={limit} onChange={setLimit} options={["5", "20", "50"].map((v) => ({ value: v, label: v }))} /></Field>
          <Field label="Report p-values"><SimpleSelect className="w-44" value={pLimit} onChange={setPLimit} options={[{ value: "1", label: "All p-values" }, { value: "0.5", label: "p ≤ 0.50" }, { value: "0.2", label: "p ≤ 0.20" }, { value: "0.05", label: "p ≤ 0.05" }]} /></Field>
          <label className="flex items-center gap-2 text-sm"><Switch checked={overlapping} onCheckedChange={setOverlapping} /> Include overlapping candidates</label>
          <Button onClick={run} disabled={running}>{running ? "Scanning…" : "Run scan"}</Button>
        </div>
        <p className="mt-4 text-xs text-muted-foreground">Space-time permutation flags wards whose share of cases jumps recently; Bernoulli compares cases with non-cases among tested isolates.</p>
      </Panel>

      <p className="text-xs text-muted-foreground">Weaker and overlapping candidates are shown; p-values and the 0.05 threshold are unchanged.</p>
      {result && (
        <Panel title={`Results · ${result.cases} cases · ${weekStart(result.start)} → ${weekStart(last)}`}>
          {result.clusters.filter((c) => c.p <= Number(pLimit)).length === 0 ? (
            <p className="text-sm text-muted-foreground">No candidate clusters match the reporting threshold.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="eyebrow text-left">
                  <tr className="border-b">
                    <th className="p-2">#</th><th className="p-2">Location(s)</th><th className="p-2">Period</th><th className="p-2 text-right">Obs</th><th className="p-2 text-right">Exp</th><th className="p-2 text-right">RR</th><th className="p-2 text-right">LLR</th><th className="p-2 text-right">p-value</th><th />
                  </tr>
                </thead>
                <tbody>
                  {result.clusters.filter((c) => c.p <= Number(pLimit)).map((c, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="num p-2">{i + 1}</td>
                      <td className="p-2">{c.zone.map(result.locLabel).join(" + ")}</td>
                      <td className="num p-2 text-xs">{weekStart(result.start + c.start)} → {weekStart(result.start + c.end)}</td>
                      <td className="num p-2 text-right">{c.observed}</td>
                      <td className="num p-2 text-right">{c.expected.toFixed(1)}</td>
                      <td className="num p-2 text-right">{c.rr.toFixed(2)}</td>
                      <td className="num p-2 text-right">{c.llr.toFixed(2)}</td>
                      <td className="p-2 text-right">
                        <Badge className={c.p < 0.05 ? "bg-destructive text-destructive-foreground" : "bg-muted text-muted-foreground"}>{c.p.toFixed(3)} · {c.p < 0.05 ? "Significant" : "Not significant"}</Badge>
                      </td>
                      <td className="p-2 text-right"><Button size="sm" variant="outline" onClick={() => pushAlert(c)}>Send to alerts</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
