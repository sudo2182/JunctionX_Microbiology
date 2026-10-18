import { describe, expect, it } from "vitest";
import { ANTIBIOTICS, weekIndex } from "@/lib/amr/reference";
import type { IsolateRecord } from "@/lib/amr/store";
import { wardMatrix, wilson } from "@/lib/amr/surveillance";
import { corpusNumbers, ungroundedNumbers } from "@/lib/assistant/grounding";
import { resolveAntibiotic, resolveOrganism, resolveWard, runTool, type ToolContext } from "@/lib/assistant/tools";
import { ask, type Content, type StepResponse } from "@/lib/assistant/client";
import { searchKnowledge } from "@/lib/assistant/knowledge";
import { TOOL_SPECS } from "@/lib/assistant/tool-specs";

const sus = (results: Record<string, "S" | "R">) => ANTIBIOTICS.map((a) => results[a.code] ?? "-").join("");

function rec(i: number, over: Partial<IsolateRecord> = {}): IsolateRecord {
  const date = over.date ?? "2024-03-04";
  return {
    id: `I${i}`, patient: `P${i}`, sex: "F", age: 70, date, week: weekIndex(date), ward: "ICU", specimen: "urine",
    organism: "Escherichia coli", flags: 0, sus: sus({ CRO: "S" }), admission: "", onset: "community", setting: "inpatient", institution: "hospital",
    ...over,
  };
}

// 35 first isolates of E. coli in ICU, 7 resistant to ceftriaxone (20%), plus one repeat isolate that must not count.
const records: IsolateRecord[] = [
  ...Array.from({ length: 35 }, (_, i) => rec(i, { sus: sus({ CRO: i < 7 ? "R" : "S" }) })),
  rec(0, { id: "I0-repeat", date: "2024-03-05", sus: sus({ CRO: "R" }) }),
  ...Array.from({ length: 5 }, (_, i) => rec(100 + i, { ward: "GER", organism: "Klebsiella pneumoniae", sus: sus({ AMP: "R", CRO: "R" }) })),
];
const ctx: ToolContext = { records, stays: [], alerts: [], announcements: async () => [] };

describe("wilson", () => {
  it("matches the published 95% interval for 27/30 (about 74–97%)", () => {
    const ci = wilson(27, 30)!;
    expect(ci.low).toBeCloseTo(74.4, 1);
    expect(ci.high).toBeCloseTo(96.5, 1);
  });
  it("has no interval without tested isolates", () => {
    expect(wilson(0, 0)).toBeNull();
  });
});

describe("wardMatrix", () => {
  const rows = wardMatrix(records, { organism: "Escherichia coli", endWeek: weekIndex("2024-03-04"), windowWeeks: 4, uncomplicatedUTI: false });
  it("counts first isolates only and calculates % resistant", () => {
    const icu = rows.find((r) => r.ward.code === "ICU")!;
    const cro = icu.cells.find((c) => c.code === "CRO")!;
    expect(icu.n).toBe(35);
    expect(cro).toMatchObject({ n: 35, r: 7, reportable: true, status: "applicable" });
    expect(cro.pct).toBeCloseTo(20, 5);
  });
  it("marks expected resistance instead of calculating it", () => {
    const kp = wardMatrix(records, { organism: "Klebsiella pneumoniae", endWeek: weekIndex("2024-03-04"), windowWeeks: 4, uncomplicatedUTI: false });
    expect(kp.find((r) => r.ward.code === "GER")!.cells.find((c) => c.code === "AMP")).toMatchObject({ status: "expected-resistant", n: 0 });
  });
});

describe("resolvers", () => {
  it("understands common ways of naming things", () => {
    expect(resolveOrganism("E. coli")).toBe("Escherichia coli");
    expect(resolveOrganism("all")).toBe("all");
    expect(resolveAntibiotic("ceftriaxone")).toBe("CRO");
    expect(resolveAntibiotic("cro")).toBe("CRO");
    expect(resolveWard("icu")).toBe("ICU");
  });
});

describe("runTool", () => {
  it("returns the same figure as the Ward resistance page, with CI and an evidence link", async () => {
    const out = await runTool("resistance_rate", { organism: "E. coli", antibiotic: "ceftriaxone", ward: "ICU", end_date: "2024-03-04" }, ctx);
    expect(out.result).toMatchObject({ tested: 35, resistant: 7, percent_resistant: 20, reportable: true, eucast_status: "applicable" });
    expect(out.result["ci95_percent"]).toEqual({ low: 10, high: 35.9 });
    expect(out.evidence?.href).toBe("/wards?ward=ICU&date=2024-03-04");
  });
  it("withholds a percentage below 30 tested isolates", async () => {
    const out = await runTool("resistance_rate", { organism: "Klebsiella pneumoniae", antibiotic: "CRO", ward: "GER", end_date: "2024-03-04" }, ctx);
    expect(out.result).toMatchObject({ tested: 5, percent_resistant: null, reportable: false });
  });
  it("turns bad input into an error the model can act on", async () => {
    const out = await runTool("resistance_rate", { organism: "Martian bacillus", antibiotic: "CRO" }, ctx);
    expect(String(out.result["error"])).toContain("Unknown organism");
    expect((await runTool("drop_tables", {}, ctx)).result["error"]).toContain("Unknown tool");
  });
  it("counts isolates with grouping", async () => {
    const out = await runTool("count_isolates", { group_by: "ward" }, ctx);
    expect(out.result["isolates"]).toBe(41);
  });
});

describe("grounding", () => {
  const sources = corpusNumbers([JSON.stringify({ percent_resistant: 20.04, tested: 12345, ci: { low: 10, high: 35.9 }, week: "2024-03-04" })]);
  it("accepts figures that appear in or round from tool results", () => {
    expect(ungroundedNumbers("20% (n=12,345; 95% CI 10–35.9%), week of 2024-03-04", [...sources, 95])).toEqual([]);
    expect(ungroundedNumbers("about 20.0% resistant", sources)).toEqual([]);
  });
  it("ignores small counting numbers but flags invented statistics", () => {
    expect(ungroundedNumbers("3 wards were above 47.3%", sources)).toEqual(["47.3"]);
  });
});

describe("ask loop", () => {
  it("runs requested tools, sends results back with signatures intact, and returns the answer", async () => {
    const sent: Content[][] = [];
    const replies: StepResponse[] = [
      { turns: [{ role: "model", parts: [{ functionCall: { name: "resistance_rate", args: { organism: "E. coli", antibiotic: "CRO", ward: "ICU", end_date: "2024-03-04" } }, thoughtSignature: "sig-A" }] }], unverified: [] },
      { turns: [{ role: "model", parts: [{ text: "20% of E. coli in ICU were resistant (n=35)." }] }], unverified: [] },
    ];
    const answer = await ask([], "E. coli CRO in ICU?", ctx, async (c) => { sent.push(c); return replies[sent.length - 1]; });
    expect(answer.text).toContain("20%");
    expect(answer.tools.map((t) => t.name)).toEqual(["resistance_rate"]);
    expect(answer.evidence[0].href).toBe("/wards?ward=ICU&date=2024-03-04");
    const second = sent[1];
    expect(second[1].parts[0].thoughtSignature).toBe("sig-A");
    expect(second[2].parts[0].functionResponse?.response).toMatchObject({ percent_resistant: 20, evidence_link: { href: "/wards?ward=ICU&date=2024-03-04" } });
  });
  it("stops after too many lookups", async () => {
    const loop: StepResponse = { turns: [{ role: "model", parts: [{ functionCall: { name: "data_overview", args: {} } }] }], unverified: [] };
    await expect(ask([], "loop", ctx, async () => loop)).rejects.toThrow("too many lookups");
  });
});

describe("knowledge and tool specs", () => {
  it("finds the methods section for common questions", () => {
    expect(searchKnowledge("why does it say n= instead of a percentage")[0].id).toBe("minimum-isolates");
    expect(searchKnowledge("is this cluster an outbreak?")[0].id).toBe("cluster-detection");
  });
  it("only cites sources with https links or the dashboard's own rules", () => {
    for (const s of searchKnowledge("first isolate confidence eucast cluster onset", 20))
      for (const src of s.sources) expect(src.url === undefined || src.url.startsWith("https://")).toBe(true);
  });
  it("declares integer parameters without enums (Gemini only allows enums on strings)", () => {
    for (const t of TOOL_SPECS) for (const p of Object.values(t.parameters.properties)) if (p.type !== "string") expect(p.enum).toBeUndefined();
  });
});
