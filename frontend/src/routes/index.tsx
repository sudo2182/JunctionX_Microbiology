import { Link, createFileRoute } from "@tanstack/react-router";
import { useReport } from "@/components/amr/report";
import { buildAtlasReport } from "@/lib/report/builders";
import { wardOverview } from "@/lib/amr/occupancy";
import { useExternal } from "@/lib/amr/external";
import { useMemo, useState } from "react";
import { ArrowUpRight, ExternalLink, Rss, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { DataGate, Field, Panel } from "@/components/amr/shell";
import { SimpleSelect } from "@/components/amr/selects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { addAlert, deleteAlert, latestSampleDate, useAmr, type Alert } from "@/lib/amr/store";
import { WardAtlas } from "@/components/amr/ward-atlas";
import { useAnnouncements, type Announcement } from "@/lib/amr/announcements";
import { SOURCES, feedEntries, lastUpdated, sourceInfo, type FeedEntry, type Trace } from "@/lib/amr/alert-sources";
import { FEED_PATH } from "@/lib/amr/alert-rss";

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
  const latest = useMemo(() => latestSampleDate(records), [records]);
  const [selectedDate, setSelectedDate] = useState("");
  const asOf = selectedDate || latest;
  const { alerts } = useAmr();
  const ecdcForReport = useAnnouncements();
  const external = useExternal();
  useReport(records.length ? () => buildAtlasReport({
    wards: wardOverview(stays, records, asOf),
    asOf,
    latestSample: latest,
    feed: feedEntries(alerts, ecdcForReport.items, new Set(records.map((r) => r.id))),
    external: external.data,
  }) : null);

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

const categoryBadge: Record<Announcement["category"], { text: string; cls: string }> = {
  relevant: { text: "AMR relevant", cls: "bg-destructive text-destructive-foreground" },
  review: { text: "needs review", cls: "bg-warning text-warning-foreground" },
  unrelated: { text: "unrelated", cls: "bg-secondary text-secondary-foreground" },
};

const borderColor = (e: FeedEntry) =>
  e.severity === "warning" || e.category === "relevant" ? "var(--destructive)" : e.severity === "watch" || e.category === "review" ? "var(--warning)" : undefined;

function formatUtc(iso: string | null): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC" : "unknown";
}

function TraceLink({ trace }: { trace: Trace }) {
  if (trace.kind === "external")
    return (
      <a href={trace.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
        {trace.text} <ExternalLink className="h-3 w-3" />
      </a>
    );
  if (trace.kind === "internal")
    return trace.to === "/records" ? (
      <Link to="/records" search={{ q: trace.q }} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
        {trace.text} <ArrowUpRight className="h-3 w-3" />
      </Link>
    ) : (
      <Link to="/detection" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
        {trace.text} <ArrowUpRight className="h-3 w-3" />
      </Link>
    );
  return <span className="text-xs text-muted-foreground">{trace.text}</span>;
}

function AlertFeed() {
  const { alerts, records } = useAmr();
  const ecdc = useAnnouncements();
  const [filter, setFilter] = useState("all");
  const [posting, setPosting] = useState(false);
  const recordIds = useMemo(() => new Set(records.map((r) => r.id)), [records]);
  const entries = useMemo(() => feedEntries(alerts, ecdc.items, recordIds), [alerts, ecdc.items, recordIds]);
  const updated = lastUpdated(entries, ecdc.lastCheck);
  const shown = entries.filter((e) => filter === "all" || e.source === filter);
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.source, (counts.get(e.source) ?? 0) + 1);
  // Every known source is offered (with its count, even 0); unknown values found in the data are added after them.
  const sourceKeys = [...Object.keys(SOURCES), ...[...counts.keys()].filter((k) => !(k in SOURCES))];

  return (
    <Panel
      title="Alerts & news"
      right={<div className="flex items-center gap-2"><Button asChild size="sm" variant="ghost" title="Public RSS feed of the alerts posted here (ECDC news not included)"><a href={FEED_PATH} target="_blank" rel="noopener noreferrer"><Rss className="h-4 w-4" />RSS</a></Button><Button size="sm" variant={posting ? "secondary" : "outline"} onClick={() => setPosting(!posting)}>{posting ? "Close" : "Post alert"}</Button>{
        <SimpleSelect
          className="h-8 w-44"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: `All sources (${entries.length})` },
            ...sourceKeys.map((k) => ({ value: k, label: `${sourceInfo(k).label} (${counts.get(k) ?? 0})` })),
          ]}
        />}</div>
      }
    >
      <div className="mb-2 space-y-0.5 text-xs text-muted-foreground">
        <div>
          Updated on <span className="num font-medium text-foreground">{formatUtc(updated)}</span>
        </div>
        <div>
          ECDC feed last checked <span className="num">{ecdc.status === "loading" ? "…" : formatUtc(ecdc.lastCheck)}</span> · daily, not real time
        </div>
        {ecdc.status === "error" && <div className="text-destructive">ECDC items could not be loaded: {ecdc.error}</div>}
      </div>
      {posting && <div className="mb-4 border-b pb-4"><PostAlert onDone={() => setPosting(false)} /></div>}
      <ol className="grid max-h-[calc(100vh-250px)] gap-2 overflow-y-auto md:grid-cols-2 xl:grid-cols-1">
        {shown.length === 0 && <li className="text-sm text-muted-foreground">No alerts from this source yet.</li>}
        {shown.map((e) => {
          const info = sourceInfo(e.source);
          const alertId = e.id.slice("alert:".length);
          return (
            <li key={e.id} className="group rounded-md border-l-4 border-l-primary bg-background p-3" style={borderColor(e) ? { borderLeftColor: borderColor(e) } : undefined}>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="num">{e.date || "no date"}</span>
                {e.region && <>·<span>{e.region}</span></>}
                {e.severity && <Badge className={`ml-auto ${sevClass[e.severity]}`}>{e.severity}</Badge>}
                {e.category && <Badge className={`ml-auto ${categoryBadge[e.category].cls}`}>{categoryBadge[e.category].text}</Badge>}
                <Badge variant="outline" title={info.origin}>{info.label}</Badge>
              </div>
              <div className="mt-1.5 text-sm font-medium leading-snug">{e.title}</div>
              {e.organism && <div className="mt-0.5 text-xs italic text-muted-foreground">{e.organism}</div>}
              {e.terms && e.terms.length > 0 && <div className="mt-0.5 text-xs text-muted-foreground">Matched: {e.terms.join(", ")}</div>}
              {e.summary && <p className="mt-1 line-clamp-4 text-sm text-muted-foreground">{e.summary}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <TraceLink trace={e.trace} />
                <span className="text-[11px] text-muted-foreground">{e.source === "ecdc" ? "Found" : "Added"} {formatUtc(e.added)}</span>
                {e.deletable && (
                  <Button variant="ghost" size="icon" className="ml-auto text-muted-foreground" onClick={() => deleteAlert(alertId).catch((err: unknown) => toast.error(err instanceof Error ? err.message : "Could not remove the alert"))} aria-label="Remove alert">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <details className="mt-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer">Where do these come from?</summary>
        <dl className="mt-2 space-y-1.5">
          {Object.values(SOURCES).map((s) => (
            <div key={s.label}><dt className="inline font-medium text-foreground">{s.label}: </dt><dd className="inline">{s.origin}</dd></div>
          ))}
        </dl>
        {ecdc.attribution && <p className="mt-2">{ecdc.attribution}</p>}
      </details>
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
      <h3 className="mb-1 text-sm font-semibold">Post a news article / outbreak alert</h3>
      <p className="mb-3 text-xs text-muted-foreground">Posted alerts appear in this feed and in the public <a href={FEED_PATH} target="_blank" rel="noopener noreferrer" className="underline">RSS feed</a> that anyone can read. Never include patient names or identifiers.</p>
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
