import { describe, expect, it } from "vitest";
import { estimatedOccupancy, markerRates, stayEnd, wardOverview, wardHistory } from "@/lib/amr/occupancy";
import type { IsolateRecord, StayRecord } from "@/lib/amr/store";

const rec = (p: Partial<IsolateRecord> = {}): IsolateRecord => ({
  id: "1", patient: "P1", sex: "F", age: 50, date: "2026-01-01", week: 0, ward: "ICU", specimen: "urine",
  organism: "Escherichia coli", flags: 1, sus: "S------------", admission: "2025-12-01",
  onset: "hospital", setting: "inpatient", institution: "hospital", ...p,
});

/** Every culture is a stay, including ones that grew nothing. */
const staysOf = (rows: IsolateRecord[]): StayRecord[] =>
  rows.map((r) => ({ id: r.id, patient: r.patient, ward: r.ward, date: r.date, admission: r.admission, institution: r.institution, result: r.flags ? "positive" : "negative", nIsolates: 1 }));

describe("estimated ward occupancy", () => {
  it("includes marker-negative patients in total occupancy without changing positive counts", () => {
    const rows = [rec(), rec({ id: "2", patient: "P2", flags: 0 }), rec({ id: "3" })];
    expect(wardOverview(staysOf(rows), rows, "2026-01-02").find((w) => w.code === "ICU")).toMatchObject({ occupancy: 2, patients: 1 });
  });
  it("history applies transfers and expiry at each snapshot and ends on the chosen date", () => {
    const rows = [rec(), rec({ id: "2", patient: "P2", flags: 0 }), rec({ id: "3", ward: "MED-A", date: "2026-01-08" })];
    const history = wardHistory(staysOf(rows), rows, "ICU", "2026-01-15");
    expect(history).toHaveLength(13);
    expect(history.find((r) => r.date === "2026-01-01")).toMatchObject({ occupancy: 2, positive: 1 });
    expect(history.find((r) => r.date === "2026-01-08")).toMatchObject({ occupancy: 1, positive: 0 });
    expect(history.at(-1)).toMatchObject({ date: "2026-01-15", occupancy: 0, positive: 0 });
  });
  it("phenotype history retains the 30-isolate reporting threshold", () => {
    const rows = Array.from({ length: 30 }, (_, i) => rec({ id: String(i), patient: String(i), flags: i < 6 ? 1 : 0 }));
    expect(wardHistory(staysOf(rows), rows, "ICU", "2026-01-02").at(-1)?.esbl).toBe(20);
    expect(wardHistory(staysOf(rows.slice(1)), rows.slice(1), "ICU", "2026-01-02").at(-1)?.esbl).toBeNull();
  });
  it("starts at the first test and ends after 14 days without extension from repeat tests", () => {
    const rows = [rec(), rec({ id: "2", date: "2026-01-12" })];
    expect(estimatedOccupancy(staysOf(rows), "2026-01-14")[0]?.start).toBe("2026-01-01");
    expect(estimatedOccupancy(staysOf(rows), "2026-01-15")).toHaveLength(0);
  });
  it("supports a same-ward return after two weeks", () => {
    const rows = [rec(), rec({ id: "2", date: "2026-01-15", flags: 0 })];
    const active = estimatedOccupancy(staysOf(rows), "2026-01-16");
    expect(active[0]?.start).toBe("2026-01-15");
    expect(wardOverview(staysOf(rows), rows, "2026-01-16").find((w) => w.code === "ICU")?.patients).toBe(0);
  });
  it("supports return to another ward and does not count a patient in two wards", () => {
    const rows = [rec(), rec({ id: "2", date: "2026-01-15", ward: "MED-A" })];
    expect(estimatedOccupancy(staysOf(rows), "2026-01-16").map((e) => e.ward)).toEqual(["MED-A"]);
  });
  it("counts a patient whose sample grew nothing as present", () => {
    const rows = [rec({ flags: 0 })];
    expect(wardOverview(staysOf(rows), rows, "2026-01-02").find((w) => w.code === "ICU")).toMatchObject({ occupancy: 1, patients: 0 });
  });
  it("uses six calendar months for each health centre", () => {
    for (const ward of ["PHC-N", "PHC-S"]) {
      expect(stayEnd("2026-08-31", ward)).toBe("2027-02-28");
      expect(estimatedOccupancy(staysOf([rec({ ward })]), "2026-06-30")).toHaveLength(1);
      expect(estimatedOccupancy(staysOf([rec({ ward })]), "2026-07-01")).toHaveLength(0);
    }
  });
  it("uses the stated three-day default for emergency and surgery", () => {
    for (const ward of ["ED", "SURG"]) {
      expect(estimatedOccupancy(staysOf([rec({ ward })]), "2026-01-03")).toHaveLength(1);
      expect(estimatedOccupancy(staysOf([rec({ ward })]), "2026-01-04")).toHaveLength(0);
    }
  });
  it("ignores future tests and counts each positive patient once", () => {
    const rows = [rec(), rec({ id: "2", flags: 3 }), rec({ id: "3", patient: "P2", date: "2026-01-10" })];
    const ward = wardOverview(staysOf(rows), rows, "2026-01-02").find((w) => w.code === "ICU");
    expect(ward?.patients).toBe(1);
    expect(ward?.markers.map((m) => m.patients)).toEqual([1, 1, 0, 0]);
  });
});

describe("marker percentages", () => {
  it("deduplicates first isolates and suppresses percentages below 30", () => {
    expect(markerRates(Array.from({ length: 30 }, (_, i) => rec({ id: String(i) })))[0]?.pct).toBeNull();
    expect(markerRates(Array.from({ length: 29 }, (_, i) => rec({ patient: String(i) })))[0]?.pct).toBeNull();
  });
  it("reports positive over all first isolates by ward and affected organism", () => {
    const rows = Array.from({ length: 40 }, (_, i) => rec({ patient: String(i), flags: i < 10 ? 1 : 0 }));
    expect(markerRates(rows)[0]).toMatchObject({ n: 40, positive: 10, pct: 25 });
    const ward = wardOverview(staysOf(rows), rows, "2026-01-02").find((w) => w.code === "ICU");
    expect(ward?.rates[0]?.pct).toBe(25);
    expect(ward?.organisms[0]?.rates[0]?.pct).toBe(25);
  });
});
