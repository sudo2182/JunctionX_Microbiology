import { describe, expect, it } from "vitest";
import { isHospitalOnset, type IsolateRecord } from "@/lib/amr/store";
import { firstIsolates, resistance } from "@/lib/amr/stats";
import { runScan, singleZones } from "@/lib/amr/satscan";

const rec = (p: Partial<IsolateRecord>): IsolateRecord => ({
  id: "x", patient: "P1", sex: "F", age: 50, date: "2026-01-05", week: 0, ward: "ICU", specimen: "urine",
  organism: "Escherichia coli", flags: 0, sus: "S------------", admission: "",
  onset: "", setting: "", institution: "hospital", ...p,
});

describe("AMR rules", () => {
  it("counts hospital-onset from the 3rd hospital day", () => {
    expect(isHospitalOnset({ admission: "2026-01-01", date: "2026-01-02" })).toBe(false);
    expect(isHospitalOnset({ admission: "2026-01-01", date: "2026-01-03" })).toBe(true);
  });
  it("keeps only the first isolate per patient/organism/specimen", () => {
    const out = firstIsolates([rec({ id: "b", date: "2026-02-01" }), rec({ id: "a", date: "2026-01-01" })]);
    expect(out.map((r) => r.id)).toEqual(["a"]);
  });
  it("marks resistance reportable only from 30 isolates", () => {
    expect(resistance(Array(29).fill(rec({})), "AMP").reportable).toBe(false);
    expect(resistance(Array(30).fill(rec({})), "AMP").reportable).toBe(true);
  });
  it("finds an injected space-time cluster", () => {
    const cases = [0, 1, 2].map(() => Array(20).fill(2));
    cases[1]![19] = 20;
    const [top] = runScan({ locations: ["A", "B", "C"], zones: singleZones(3), weeks: 20, cases, model: "stp", maxWindow: 3, prospective: false, replications: 99 });
    expect(top!.zone).toEqual(["B"]);
    expect(top!.end).toBe(19);
    expect(top!.p).toBeLessThan(0.05);
  });
});
