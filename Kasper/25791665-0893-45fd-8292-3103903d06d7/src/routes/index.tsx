import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { ExternalLink, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { DataGate, Field, Panel } from "@/components/amr/shell";
import { SimpleSelect } from "@/components/amr/selects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { addAlert, deleteAlert, useAmr, type Alert } from "@/lib/amr/store";
import { WardAtlas } from "@/components/amr/ward-atlas";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Hospital ward atlas & alerts — AMR Watch" },
      { name: "description", content: "Interactive hospital ward atlas with estimated marker-positive cases, ward resistance percentages and outbreak alerts." },
      { property: "og:title", content: "Hospital ward atlas & alerts — AMR Watch" },
      { property: "og:description", content: "Explore estimated resistant cases by ward, associated organisms and outbreak alerts." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => (
    <>
      <DataGate>
        <Overview />
      </DataGate>
    </>
  ),
});

function Overview() {
  const { records, stays } = useAmr();
  const latest = useMemo(() => records.reduce((date, r) => r.date > date ? r.date : date, ""), [records]);
  const [selectedDate, setSelectedDate] = useState("");
  const asOf = selectedDate || latest;

  return (
    <div className="space-y-3">
      <WardAtlas stays={stays} records={records} asOf={asOf} onDateChange={setSelectedDate} side={<AlertFeed />} />
      <div className="border-t pt-4 text-xs text-muted-foreground">Latest sample: <span className="num">{latest}</span></div>
    </div>
  );
}

const sevClass: Record<Alert["severity"], string> = {
  info: "bg-accent text-accent-foreground",
  watch: "bg-warning text-warning-foreground",
  warning: "bg-destructive text-destructive-foreground",
};

function AlertFeed() {
  const { alerts } = useAmr();
  const [filter, setFilter] = useState("all");
  const [posting, setPosting] = useState(false);
  const shown = alerts.filter((a) => filter === "all" || a.source === filter).sort((a, b) => b.date.localeCompare(a.date));
  return (
    <Panel
      title="Alerts & news"
      right={<div className="flex items-center gap-2"><Button size="sm" variant={posting ? "secondary" : "outline"} onClick={() => setPosting(!posting)}>{posting ? "Close" : "Post alert"}</Button>{
        <SimpleSelect
          className="h-8 w-36"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All sources" },
            { value: "news", label: "News" },
            { value: "satscan", label: "SaTScan" },
            { value: "internal", label: "Internal" },
          ]}
        />}</div>
      }
    >
      {posting && <div className="mb-4 border-b pb-4"><PostAlert onDone={() => setPosting(false)} /></div>}
      <ol className="grid max-h-[calc(100vh-210px)] gap-2 overflow-y-auto md:grid-cols-2 xl:grid-cols-1">
        {shown.length === 0 && <li className="text-sm text-muted-foreground">No alerts yet.</li>}
        {shown.map((a) => (
          <li key={a.id} className="group rounded-md border-l-4 border-l-primary bg-background p-3" style={a.severity === "warning" ? { borderLeftColor: "var(--destructive)" } : a.severity === "watch" ? { borderLeftColor: "var(--warning)" } : undefined}>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="num">{a.date}</span>·<span>{a.region}</span>
              <Badge className={`ml-auto ${sevClass[a.severity]}`}>{a.severity}</Badge>
              <Badge variant="outline">{a.source}</Badge>
            </div>
            <div className="mt-1.5 text-sm font-medium leading-snug">{a.title}</div>
            {a.organism && <div className="mt-0.5 text-xs italic text-muted-foreground">{a.organism}</div>}
            {a.summary && <p className="mt-1 text-sm text-muted-foreground">{a.summary}</p>}
            <div className="mt-2 flex items-center gap-3">
              {a.url && (
                <a href={a.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                  Read article <ExternalLink className="h-3 w-3" />
                </a>
              )}
               <Button variant="ghost" size="icon" className="ml-auto text-muted-foreground" onClick={() => deleteAlert(a.id).catch((e: unknown) => toast.error(e instanceof Error ? e.message : "Could not remove the alert"))} aria-label="Remove alert">
                <Trash2 className="h-3.5 w-3.5" />
               </Button>
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function PostAlert({ onDone }: { onDone: () => void }) {
  const empty = { title: "", summary: "", url: "", region: "", organism: "", severity: "info" as Alert["severity"], date: new Date().toISOString().slice(0, 10) };
  const [f, setF] = useState(empty);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.title.trim() || !f.region.trim()) {
      toast.error("Title and region are required");
      return;
    }
    addAlert({ ...f, url: f.url || undefined, organism: f.organism || undefined, source: "news" })
      .then(() => {
        setF(empty);
        toast.success("Alert posted to the feed");
        onDone();
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : "Could not post the alert"));
  };
  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold">Post a news article / outbreak alert</h3>
      <form onSubmit={submit} className="grid gap-2 md:grid-cols-2 xl:grid-cols-1">
        <Field label="Headline"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. NDM-producing E. coli outbreak in…" /></Field>
        <Field label="Article URL"><Input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://…" /></Field>
        <Field label="Region / country"><Input value={f.region} onChange={(e) => setF({ ...f, region: e.target.value })} /></Field>
        <Field label="Organism (optional)"><Input value={f.organism} onChange={(e) => setF({ ...f, organism: e.target.value })} /></Field>
        <Field label="Severity">
          <SimpleSelect className="w-full" value={f.severity} onChange={(v) => setF({ ...f, severity: v as Alert["severity"] })} options={[{ value: "info", label: "Info" }, { value: "watch", label: "Watch" }, { value: "warning", label: "Warning" }]} />
        </Field>
        <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <div className="md:col-span-2 xl:col-span-1"><Field label="Summary"><Textarea rows={3} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} /></Field></div>
        <div className="md:col-span-2 xl:col-span-1"><Button type="submit">Post alert</Button></div>
      </form>
    </div>
  );
}
