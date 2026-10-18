import type { Announcement } from "./announcements";
import type { Alert } from "./store";

/**
 * Where each item in the "Alerts & news" feed comes from, and how to get back to it.
 * news_items.source values are written by: detection.tsx ("satscan"), the PAN database trigger ("pan"),
 * the Post alert form ("news"). ECDC items come from api.announcements, not news_items.
 */
export const SOURCES = {
  ecdc: {
    label: "ECDC",
    origin: "Official ECDC publication or news item, found by the daily check of ECDC's RSS feeds. Real-world, not part of the synthetic data.",
  },
  satscan: {
    label: "Cluster scan",
    origin: "Space-time scan (Kulldorff method, as in SaTScan) run in this dashboard on the synthetic TYKS data, then sent to the feed by a user.",
  },
  pan: {
    label: "PAN rule",
    origin: "Database rule on the synthetic data: one isolate resistant to every guideline-supported agent in the dashboard panel. A surveillance flag, not confirmed pan-resistance.",
  },
  news: {
    label: "Manual post",
    origin: "Posted by a user of this dashboard with the Post alert form.",
  },
} as const;

export type SourceKey = keyof typeof SOURCES;

export function sourceInfo(source: string): { label: string; origin: string } {
  return (SOURCES as Record<string, { label: string; origin: string }>)[source] ?? { label: source, origin: "Unknown source." };
}

export type Trace =
  | { kind: "external"; href: string; text: string }
  | { kind: "internal"; to: "/records" | "/detection"; q?: string; text: string }
  | { kind: "none"; text: string };

/** Only http(s) links are rendered: posted URLs are user input, and a javascript: URL would run in the reader's browser. */
export function safeHttpUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/** How to get from a feed alert back to what produced it. recordIds: ids currently in the dashboard's records. */
export function traceAlert(a: Pick<Alert, "source" | "url" | "key">, recordIds: ReadonlySet<string>): Trace {
  const link = safeHttpUrl(a.url);
  if (link) return { kind: "external", href: link, text: `Open source (${new URL(link).hostname})` };
  if (a.source === "pan") {
    const id = a.key?.includes(":") ? a.key.slice(a.key.indexOf(":") + 1) : "";
    if (id && recordIds.has(id)) return { kind: "internal", to: "/records", q: id, text: "Open the flagged record" };
    return { kind: "none", text: id ? "The flagged record has since been deleted" : "No record reference stored" };
  }
  if (a.source === "satscan") return { kind: "internal", to: "/detection", text: "Open cluster detection to re-run the scan" };
  return { kind: "none", text: a.url ? "Link not shown: not an http(s) address" : "No source link given" };
}

/** One row of the merged feed. */
export type FeedEntry = {
  id: string;
  source: string;
  title: string;
  summary: string;
  organism?: string | undefined;
  region?: string | undefined;
  date: string; // event date (alert date, or ECDC publication date)
  added: string | null; // when it entered this dashboard's data
  severity?: Alert["severity"];
  category?: Announcement["category"];
  terms?: string[];
  trace: Trace;
  deletable: boolean; // only rows in news_items can be removed from here
};

export function feedEntries(alerts: Alert[], announcements: Announcement[], recordIds: ReadonlySet<string>): FeedEntry[] {
  const local: FeedEntry[] = alerts.map((a) => ({
    id: `alert:${a.id}`,
    source: a.source,
    title: a.title,
    summary: a.summary,
    organism: a.organism,
    region: a.region,
    date: a.date,
    added: a.posted ?? null,
    severity: a.severity,
    trace: traceAlert(a, recordIds),
    deletable: true,
  }));
  // Unrelated ECDC items stay on the announcements page only.
  const ecdc: FeedEntry[] = announcements
    .filter((n) => n.category !== "unrelated")
    .map((n) => {
      const href = safeHttpUrl(n.url);
      return {
        id: `ecdc:${n.id}`,
        source: "ecdc",
        title: n.title,
        summary: n.summary,
        region: "EU/EEA",
        date: n.published ? n.published.slice(0, 10) : "",
        added: n.firstDetected || null,
        category: n.category,
        terms: n.terms,
        trace: href ? { kind: "external", href, text: "Read on ECDC" } : { kind: "none", text: "No link in the feed" },
        deletable: false,
      };
    });
  return [...local, ...ecdc].sort((x, y) => y.date.localeCompare(x.date) || ms(y.added) - ms(x.added));
}

// Timestamps arrive as "...Z" or "...+00:00", so compare them as times, not strings.
const ms = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/** Most recent change across the feed: the newest added row, or the last ECDC check if that is later. */
export function lastUpdated(entries: FeedEntry[], lastEcdcCheck: string | null): string | null {
  let latest: string | null = ms(lastEcdcCheck) ? lastEcdcCheck : null;
  for (const e of entries) if (ms(e.added) > ms(latest)) latest = e.added;
  return latest;
}
