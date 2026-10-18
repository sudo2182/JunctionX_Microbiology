import { describe, expect, it } from "vitest";
import { renderAlertsRss, type AlertRow } from "@/lib/amr/alert-rss";

const row = (over: Partial<AlertRow>): AlertRow => ({
  id: "a1", title: "ESBL cluster in Urology", summary: "6 observed vs 1.2 expected", url: null, region: "Hospital",
  organism: "Escherichia coli", severity: "watch", alert_date: "2026-04-06", source: "satscan", posted_at: "2026-10-17T08:00:00Z",
  ...over,
});
const now = new Date("2026-10-18T10:00:00Z");

describe("renderAlertsRss", () => {
  const xml = renderAlertsRss([
    row({ id: "old", title: "Older", posted_at: "2026-10-01T00:00:00Z" }),
    row({ id: "new", title: "Newer <b>&</b> 'quoted'", source: "pan", severity: "warning" }),
  ], { siteUrl: "https://amr.example.app/", now });

  it("is RSS 2.0 with a self link to the public feed URL", () => {
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain('<atom:link href="https://amr.example.app/rss/alerts.xml" rel="self"');
    expect(xml).toContain("<lastBuildDate>Sun, 18 Oct 2026 10:00:00 GMT</lastBuildDate>");
  });
  it("lists the newest alert first, with a stable guid and an RFC 822 date", () => {
    expect(xml.indexOf("amr-watch-alert-new")).toBeLessThan(xml.indexOf("amr-watch-alert-old"));
    expect(xml).toContain("<pubDate>Sat, 17 Oct 2026 08:00:00 GMT</pubDate>");
  });
  it("escapes text so a title cannot break the XML", () => {
    expect(xml).toContain("<title>[warning] Newer &lt;b&gt;&amp;&lt;/b&gt; &apos;quoted&apos;</title>");
    expect(xml).not.toContain("<b>&</b>");
  });
  it("labels the source and marks the data as synthetic", () => {
    expect(xml).toContain("<category>PAN rule</category>");
    expect(xml).toContain("Synthetic surveillance data");
  });
  it("links to the article only when it is a safe http(s) URL, otherwise to the dashboard", () => {
    const safe = renderAlertsRss([row({ url: "https://news.example/item" })], { siteUrl: "https://amr.example.app", now });
    const unsafe = renderAlertsRss([row({ url: "javascript:alert(1)" })], { siteUrl: "https://amr.example.app", now });
    expect(safe).toContain("<link>https://news.example/item</link>");
    expect(unsafe).toContain("<link>https://amr.example.app/</link>");
    expect(unsafe).not.toContain("javascript:");
  });
  it("renders an empty but valid feed when nothing has been posted", () => {
    const empty = renderAlertsRss([], { siteUrl: "https://amr.example.app", now });
    expect(empty).toContain("<channel>");
    expect(empty).not.toContain("<item>");
  });
});
