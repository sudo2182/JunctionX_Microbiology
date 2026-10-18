import { describe, expect, it } from "vitest";
import { ANTIBIOTICS, weekIndex } from "@/lib/amr/reference";
import type { IsolateRecord } from "@/lib/amr/store";
import { wardMatrix } from "@/lib/amr/surveillance";
import { defaultOptions, niceTicks, renderReportHtml, reportCsv, reportFileName, selectedSections, type ReportDoc } from "@/lib/report/report";
import { buildAnnouncementsReport, buildDetectionReport, buildRecordsReport, buildSpatialReport, buildWardsReport } from "@/lib/report/builders";

const doc: ReportDoc = {
  id: "test-page",
  title: "Test <report>",
  subtitle: "Sub & title",
  period: "2026-01-01 to 2026-03-31",
  dataAsOf: "latest sample 2026-03-31",
  keyFacts: ["Fact <one>"],
  sections: [
    { id: "a", heading: "First", blocks: [{ type: "figure", figure: { kind: "bar", caption: "Bars", unit: "n", items: [{ label: "X", value: 3 }] } }, { type: "table", table: { caption: "T1", columns: ["Name", "n"], rows: [["a, b", 1], ['say "hi"', 2]] } }] },
    { id: "b", heading: "Second", blocks: [{ type: "figure", figure: { kind: "line", caption: "Line", unit: "%", x: ["2024", "2025"], series: [{ name: "S", values: [1, null] }] } }, { type: "table", table: { caption: "T2", columns: ["k"], rows: [] } }] },
  ],
  methods: ["Method"],
  limitations: ["Limit"],
  sources: [{ label: "Source", url: "https://example.org" }],
};

describe("report rendering", () => {
  const html = renderReportHtml(doc, defaultOptions(doc), new Date("2026-10-18T10:00:00Z"));
  it("is an ECDC-style document: title block, key facts, numbered sections, figures and tables, citation, disclaimer", () => {
    expect(html).toContain("AMR WATCH · SURVEILLANCE REPORT");
    expect(html).toContain("<h2>Key facts</h2>");
    expect(html).toContain("<h2>1. First</h2>");
    expect(html).toContain("<h2>2. Second</h2>");
    expect(html).toContain("<b>Figure 1.</b> Bars");
    expect(html).toContain("<b>Figure 2.</b> Line");
    expect(html).toContain("<b>Table 1.</b> T1");
    expect(html).toContain("<b>Table 2.</b> T2");
    expect(html).toContain("Suggested citation:");
    expect(html).toContain("Synthetic data.");
    expect(html).toContain("18 October 2026");
  });
  it("escapes every text so data cannot inject markup", () => {
    expect(html).toContain("Test &lt;report&gt;");
    expect(html).toContain("Fact &lt;one&gt;");
    expect(html).not.toContain("<report>");
  });
  it("shows an empty-table message instead of a blank table", () => {
    expect(html).toContain("No data for this selection.");
  });
  it("honours the options: sections, tables, key facts, methods, prepared by", () => {
    const o = { ...defaultOptions(doc), sections: ["b"], tables: false, keyFacts: false, methods: false, preparedBy: "IPC team" };
    const h = renderReportHtml(doc, o);
    expect(h).not.toContain("1. First");
    expect(h).toContain("<h2>1. Second</h2>");
    expect(h).not.toContain("<b>Table");
    expect(h).not.toContain("Key facts");
    expect(h).not.toContain("Methods and definitions");
    expect(h).toContain("IPC team");
    expect(selectedSections(doc, o).map((s) => s.id)).toEqual(["b"]);
  });
  it("names files predictably", () => {
    expect(reportFileName(doc, new Date("2026-10-18T10:00:00Z"), "pdf")).toBe("AMR-Watch_test-page_report_2026-10-18.pdf");
  });
  it("builds sensible axis ticks", () => {
    expect(niceTicks(37)).toEqual([0, 10, 20, 30, 40]);
    expect(niceTicks(0)).toEqual([0, 1]);
  });
});

describe("report CSV", () => {
  it("exports every table with a caption line and correct quoting", () => {
    const csv = reportCsv(doc, defaultOptions(doc));
    expect(csv).toContain("# Table 1. T1");
    expect(csv).toContain('"a, b",1');
    expect(csv).toContain('"say ""hi""",2');
    expect(csv).toContain("# Table 2. T2");
  });
});

// Builders must report exactly what the pages compute.
const sus = (o: Record<string, "S" | "R">) => ANTIBIOTICS.map((a) => o[a.code] ?? "-").join("");
const rec = (i: number, over: Partial<IsolateRecord> = {}): IsolateRecord => {
  const date = over.date ?? "2024-03-04";
  return { id: `I${i}`, patient: `P${i}`, sex: "F", age: 60, date, week: weekIndex(date), ward: i % 2 ? "ICU" : "MED-A", specimen: "urine", organism: "Escherichia coli", flags: i < 5 ? 1 : 0, sus: sus({ CRO: i < 12 ? "R" : "S" }), admission: "", onset: "community", setting: "inpatient", institution: "hospital", ...over };
};
const records = Array.from({ length: 80 }, (_, i) => rec(i));
const wk = weekIndex("2024-03-04");

describe("report builders match the pages", () => {
  it("ward report: hospital-wide figure equals the Ward resistance table", () => {
    const r = buildWardsReport({ records, organism: "Escherichia coli", endWeek: wk, windowWeeks: 4, uncomplicatedUTI: false, antibiotic: "CRO", lastWeek: wk });
    const total = wardMatrix(records, { organism: "Escherichia coli", endWeek: wk, windowWeeks: 4, uncomplicatedUTI: false }).at(-1)!.cells.find((c) => c.code === "CRO")!;
    expect(total).toMatchObject({ n: 80, r: 12 });
    expect(r.keyFacts[0]).toContain(`${total.pct!.toFixed(1)}%`);
    expect(r.keyFacts[0]).toContain("(12/80;");
    const matrix = r.sections.find((s) => s.id === "matrix")!.blocks[0];
    expect(matrix.type === "table" && matrix.table.columns).toContain("CRO");
  });
  it("spatial report counts every isolate per location", () => {
    const r = buildSpatialReport({ records, organisms: ["Escherichia coli"], antibiotic: null, fromWeek: 0, toWeek: wk, uncomplicatedUTI: false, lastWeek: wk });
    const t = r.sections[0].blocks.find((b) => b.type === "table");
    const rows = t && t.type === "table" ? t.table.rows : [];
    expect(rows.find((x) => x[0] === "Intensive care unit")?.[1]).toBe(40);
    expect(r.keyFacts[0]).toContain("80 isolates");
  });
  it("records report summarises the filtered selection", () => {
    const r = buildRecordsReport({ records, filterLabel: "all" });
    expect(r.keyFacts[0]).toContain("80 isolates from 80 patients");
    const markers = r.sections.find((s) => s.id === "markers")!.blocks[0];
    expect(markers.type === "table" && markers.table.rows[0]).toEqual(["ESBL", 5, 80, "6.3% (5/80)"]);
  });
  it("detection report runs the same deterministic scan", () => {
    const settings = { model: "stp" as const, organism: "all", caseDefinition: "esbl", studyWeeks: 26, maxWindow: 4, prospective: false, replications: 99, maxClusters: 5, includeOverlapping: true, lastWeek: wk };
    const a = buildDetectionReport({ records, settings, caseLabel: "ESBL", pLimit: 1 });
    const b = buildDetectionReport({ records, settings, caseLabel: "ESBL", pLimit: 1 });
    expect(a.sections).toEqual(b.sections);
    expect(a.keyFacts[0]).toContain("5 cases (ESBL)");
  });
  it("announcements report counts categories", () => {
    const r = buildAnnouncementsReport({ items: [{ id: 1, title: "CPE", url: "https://x", published: "2026-10-01T00:00:00Z", firstDetected: "", summary: "", category: "relevant", terms: ["carbapenem"], feed: "" }], filterLabel: "all", lastCheck: null, attribution: "Source: ECDC" });
    expect(r.keyFacts[0]).toContain("1 ECDC items: 1 AMR-relevant");
  });
});

describe("surveillance 'now'", () => {
  it("is set by replayed data, not by a pending record entered with a later date", async () => {
    const { maxWeek, latestSampleDate } = await import("@/lib/amr/store");
    const late = rec(999, { date: "2026-10-17", pending: true });
    expect(maxWeek([...records, late])).toBe(wk);
    expect(latestSampleDate([...records, late])).toBe("2024-03-04");
    expect(maxWeek([late])).toBe(weekIndex("2026-10-17")); // nothing ingested yet: fall back to all records
  });
});

describe("chart layout helpers", () => {
  it("never prints an x label that crowds the last one", async () => {
    const { xLabelIndexes } = await import("@/lib/report/report");
    expect(xLabelIndexes(26)).toEqual([0, 4, 8, 12, 16, 20, 25]);
    expect(xLabelIndexes(5)).toEqual([0, 1, 2, 3, 4]);
    expect(xLabelIndexes(1)).toEqual([0]);
  });
  it("spreads overlapping end labels apart", async () => {
    const { dodge } = await import("@/lib/report/report");
    expect(dodge([100, 104, 300])).toEqual([100, 112, 300]);
  });
});
