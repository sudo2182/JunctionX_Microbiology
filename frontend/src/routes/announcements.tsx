import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import { Activity } from "lucide-react";
import { Field, PageHeader, Panel } from "@/components/amr/shell";
import { SimpleSelect } from "@/components/amr/selects";
import { Badge } from "@/components/ui/badge";
import { hoursSince, useAnnouncements, type Announcement } from "@/lib/amr/announcements";

export const Route = createFileRoute("/announcements")({
  head: () => ({
    meta: [
      { title: "ECDC announcements — AMR Watch" },
      { name: "description", content: "Official ECDC publications and news, sorted by antimicrobial-resistance relevance." },
      { property: "og:title", content: "ECDC announcements — AMR Watch" },
      { property: "og:description", content: "ECDC feed items checked daily for antimicrobial-resistance relevance." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Announcements,
});

// The checker is a GitHub Actions job (.github/workflows/ecdc_announcements.yml), not a live feed.
const SCHEDULE = "Checked once a day at about 06:23 UTC by a scheduled job. Not real time.";
const STALE_AFTER_HOURS = 36;

const label: Record<Announcement["category"], string> = { relevant: "AMR relevant", review: "Needs review", unrelated: "Unrelated" };
const badgeClass: Record<Announcement["category"], string> = {
  relevant: "bg-destructive text-destructive-foreground",
  review: "bg-warning text-warning-foreground",
  unrelated: "bg-secondary text-secondary-foreground",
};

function when(iso: string | null) {
  return iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC" : "unknown";
}

function Announcements() {
  const { status, items, lastCheck, attribution, error } = useAnnouncements();
  const [filter, setFilter] = useState("amr");
  const shown = useMemo(
    () => items.filter((a) => (filter === "all" ? true : filter === "amr" ? a.category !== "unrelated" : a.category === filter)),
    [items, filter],
  );
  const age = hoursSince(lastCheck);
  const stale = age === null || age > STALE_AFTER_HOURS;

  return (
    <>
      <PageHeader eyebrow="External" title="ECDC announcements">
        <Field label="Show">
          <SimpleSelect
            className="w-56"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "amr", label: "AMR relevant + needs review" },
              { value: "relevant", label: "AMR relevant only" },
              { value: "review", label: "Needs review only" },
              { value: "unrelated", label: "Unrelated" },
              { value: "all", label: "Everything" },
            ]}
          />
        </Field>
      </PageHeader>
      <div className="flex flex-col gap-3">
        <Panel>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
            <span>
              Last successful check: <span className="num font-medium">{status === "loading" ? "…" : when(lastCheck)}</span>
              {status === "ready" && age !== null && <span className="text-muted-foreground"> ({Math.round(age)} h ago)</span>}
            </span>
            {status === "ready" && stale && (
              <Badge className="bg-warning text-warning-foreground">{age === null ? "No successful check yet" : `No check for over ${STALE_AFTER_HOURS} h`}</Badge>
            )}
            <span className="text-muted-foreground">{SCHEDULE}</span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Titles are sorted by keyword rules. A match means the text mentions antimicrobial resistance, not that an outbreak or a clinical alert has occurred. These are real ECDC publications and are separate from the synthetic TYKS data.
          </p>
        </Panel>

        <Panel title={`${shown.length} item${shown.length === 1 ? "" : "s"}`}>
          {status === "loading" && (
            <div className="flex h-32 items-center justify-center gap-3 text-muted-foreground">
              <Activity className="h-5 w-5 animate-pulse text-primary" /> Loading announcements…
            </div>
          )}
          {status === "error" && <div className="text-sm text-destructive">Could not load the announcements: {error}</div>}
          {status === "ready" && shown.length === 0 && <div className="text-sm text-muted-foreground">No items match this filter.</div>}
          <ol className="grid gap-2">
            {shown.map((a) => (
              <li key={a.id} className="rounded-md border-l-4 border-l-primary bg-background p-3" style={a.category === "relevant" ? { borderLeftColor: "var(--destructive)" } : a.category === "review" ? { borderLeftColor: "var(--warning)" } : undefined}>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="num">{a.published ? a.published.slice(0, 10) : "no date"}</span>·<span>{a.feed}</span>
                  <Badge className={`ml-auto ${badgeClass[a.category]}`}>{label[a.category]}</Badge>
                </div>
                <div className="mt-1.5 text-sm font-medium leading-snug">{a.title}</div>
                {a.terms.length > 0 && <div className="mt-0.5 text-xs text-muted-foreground">Matched: {a.terms.join(", ")}</div>}
                {a.summary && <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">{a.summary}</p>}
                {a.url && (
                  <a href={a.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline">
                    Read on ECDC <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </li>
            ))}
          </ol>
          {status === "ready" && <p className="mt-3 text-xs text-muted-foreground">{attribution}</p>}
        </Panel>
      </div>
    </>
  );
}
