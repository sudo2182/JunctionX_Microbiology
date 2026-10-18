import { safeHttpUrl, sourceInfo } from "./alert-sources";

/**
 * Public RSS 2.0 feed of the alerts posted from this dashboard (public.news_items: staff posts, cluster
 * detections sent to the feed, automatic PAN flags). ECDC announcements are external news and are not
 * republished here. Pure rendering, so it can be tested without a database.
 */

export type AlertRow = {
  id: string;
  title: string;
  summary: string | null;
  url: string | null;
  region: string | null;
  organism: string | null;
  severity: string | null;
  alert_date: string | null;
  source: string | null;
  posted_at: string | null;
};

export const FEED_PATH = "/rss/alerts.xml";
export const FEED_LIMIT = 100;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;")
    // XML 1.0 forbids most control characters; drop them rather than emit an invalid feed.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

/** RFC 822 date as RSS requires; falls back to the alert date, then to "now" (never an invalid string). */
function rfc822(posted: string | null, alertDate: string | null, now: Date): string {
  for (const v of [posted, alertDate ? `${alertDate}T00:00:00Z` : null]) {
    const t = v ? Date.parse(v) : NaN;
    if (Number.isFinite(t)) return new Date(t).toUTCString();
  }
  return now.toUTCString();
}

export function renderAlertsRss(rows: AlertRow[], o: { siteUrl: string; now?: Date }): string {
  const now = o.now ?? new Date();
  const site = o.siteUrl.replace(/\/+$/, "");
  const sorted = [...rows]
    .sort((a, b) => (Date.parse(b.posted_at ?? "") || 0) - (Date.parse(a.posted_at ?? "") || 0))
    .slice(0, FEED_LIMIT);
  const items = sorted.map((a) => {
    const source = a.source ? sourceInfo(a.source).label : "Dashboard";
    const details = [
      a.summary?.trim(),
      [a.organism, a.region].filter(Boolean).join(" · "),
      a.alert_date ? `Alert date: ${a.alert_date}` : "",
      `Source: ${source}. Synthetic surveillance data (AMR Watch, JunctionX), not a real clinical event.`,
    ].filter(Boolean).join("\n");
    const severity = a.severity ? `[${a.severity}] ` : "";
    return [
      "    <item>",
      `      <title>${esc(severity + a.title)}</title>`,
      `      <link>${esc(safeHttpUrl(a.url) ?? `${site}/`)}</link>`,
      `      <guid isPermaLink="false">amr-watch-alert-${esc(a.id)}</guid>`,
      `      <pubDate>${rfc822(a.posted_at, a.alert_date, now)}</pubDate>`,
      `      <description>${esc(details)}</description>`,
      a.severity ? `      <category>${esc(a.severity)}</category>` : "",
      `      <category>${esc(source)}</category>`,
      "    </item>",
    ].filter(Boolean).join("\n");
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    "    <title>AMR Watch · local alerts</title>",
    `    <link>${esc(site)}/</link>`,
    `    <atom:link href="${esc(site + FEED_PATH)}" rel="self" type="application/rss+xml"/>`,
    "    <description>Alerts posted from the AMR Watch dashboard (staff posts, cluster detections, automatic PAN flags). Synthetic hackathon data.</description>",
    "    <language>en</language>",
    `    <lastBuildDate>${now.toUTCString()}</lastBuildDate>`,
    "    <ttl>5</ttl>",
    ...items,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
}
