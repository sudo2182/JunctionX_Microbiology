import { describe, expect, it } from "vitest";
import { feedEntries, lastUpdated, safeHttpUrl, sourceInfo, traceAlert } from "@/lib/amr/alert-sources";
import type { Announcement } from "@/lib/amr/announcements";
import type { Alert } from "@/lib/amr/store";

const alert = (over: Partial<Alert>): Alert => ({
  id: "a1", title: "t", summary: "", region: "MED-A", severity: "watch", date: "2026-04-06", source: "news", ...over,
});
const ann = (over: Partial<Announcement>): Announcement => ({
  id: 1, title: "ECDC item", url: "https://www.ecdc.europa.eu/en/x", published: "2026-10-13T11:47:37+00:00",
  firstDetected: "2026-10-17T17:23:37+00:00", summary: "", category: "relevant", terms: ["AMR"], feed: "News", ...over,
});
const ids = new Set(["C0000001-1", "4b4eb598"]);

describe("safeHttpUrl", () => {
  it("keeps http(s) links and refuses anything that could run code", () => {
    expect(safeHttpUrl("https://www.ecdc.europa.eu/en/x")).toBe("https://www.ecdc.europa.eu/en/x");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,<script>")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
    expect(safeHttpUrl("")).toBeNull();
  });
});

describe("traceAlert", () => {
  it("links a PAN flag to the record that triggered it", () => {
    expect(traceAlert({ source: "pan", key: "pipeline:C0000001-1" }, ids)).toEqual({ kind: "internal", to: "/records", q: "C0000001-1", text: "Open the flagged record" });
  });
  it("says so when the flagged record was deleted", () => {
    expect(traceAlert({ source: "pan", key: "submission:gone" }, ids)).toEqual({ kind: "none", text: "The flagged record has since been deleted" });
  });
  it("sends cluster-scan alerts to the page that produced them", () => {
    expect(traceAlert({ source: "satscan" }, ids)).toMatchObject({ kind: "internal", to: "/detection" });
  });
  it("uses a posted link, and never renders an unsafe one", () => {
    expect(traceAlert({ source: "news", url: "https://example.org/a" }, ids)).toMatchObject({ kind: "external", href: "https://example.org/a", text: "Open source (example.org)" });
    expect(traceAlert({ source: "news", url: "javascript:alert(1)" }, ids)).toEqual({ kind: "none", text: "Link not shown: not an http(s) address" });
    expect(traceAlert({ source: "news" }, ids)).toEqual({ kind: "none", text: "No source link given" });
  });
});

describe("feedEntries", () => {
  it("merges local alerts with relevant/review ECDC items, newest first, ECDC read-only", () => {
    const rows = feedEntries(
      [alert({ id: "x", source: "satscan", date: "2026-04-06" })],
      [ann({ id: 1 }), ann({ id: 2, category: "unrelated" }), ann({ id: 3, category: "review", published: null })],
      ids,
    );
    expect(rows.map((r) => r.id)).toEqual(["ecdc:1", "alert:x", "ecdc:3"]);
    expect(rows[0]).toMatchObject({ source: "ecdc", deletable: false, trace: { kind: "external", text: "Read on ECDC" } });
    expect(rows[1].deletable).toBe(true);
    expect(sourceInfo(rows[0].source).label).toBe("ECDC");
  });
});

describe("lastUpdated", () => {
  it("compares timestamps as times whatever their format", () => {
    const rows = feedEntries([alert({ posted: "2026-10-17T18:00:00Z" })], [ann({ firstDetected: "2026-10-17T17:23:37+00:00" })], ids);
    expect(lastUpdated(rows, "2026-10-17T19:00:00.000+00:00")).toBe("2026-10-17T19:00:00.000+00:00");
    expect(lastUpdated(rows, "2026-10-17T10:00:00+00:00")).toBe("2026-10-17T18:00:00Z");
    expect(lastUpdated([], null)).toBeNull();
  });
});
