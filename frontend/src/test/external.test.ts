import { describe, expect, it } from "vitest";
import { finresOptions, finresSeries, freshness, incidenceSeries, notificationShare, registerOptions, yearRange, type BenchRow, type ContextRow } from "@/lib/amr/external";

const ctx = (over: Partial<ContextRow>): ContextRow => ({
  phenotype: "ESBL", organism: "Escherichia coli", specimen: "blood_csf", geo_code: "wsc:05", geo_name: "Southwest Finland",
  year: 2025, indicator: "cases", value: 1, retrieved_at: null, source_url: null, attribution: null, ...over,
});

const context: ContextRow[] = [
  ctx({ year: 2024, indicator: "incidence_per_100k", value: 4.2 }),
  ctx({ year: 2024, indicator: "cases", value: 20 }),
  ctx({ year: 2025, indicator: "incidence_per_100k", value: 4.8 }),
  ctx({ year: 2025, indicator: "cases", value: 23 }),
  ctx({ year: 2025, geo_code: "FI", indicator: "incidence_per_100k", value: 6.3 }),
  ctx({ year: 2025, geo_code: "FI", indicator: "cases", value: 358 }),
  ctx({ year: 2025, organism: "Klebsiella pneumoniae", value: 4 }),
  ctx({ year: 2025, phenotype: "MRSA", organism: "Staphylococcus aureus", value: 18 }),
  ctx({ year: 2025, phenotype: "not_MRSA", organism: "Staphylococcus aureus", value: 204 }),
  ctx({ year: 2025, phenotype: "ESBL", specimen: "carriage", value: 492 }),
  ctx({ year: 2025, phenotype: "CPE", specimen: "carriage", value: 17 }),
];

describe("THL register charts", () => {
  it("builds the region vs country incidence line, oldest first, with case counts", () => {
    const s = incidenceSeries(context, "esbl-ecoli", "blood_csf");
    expect(s.map((p) => p.year)).toEqual([2024, 2025]);
    expect(s[1]).toEqual({ year: 2025, region: 4.8, country: 6.3, regionCases: 23, countryCases: 358 });
    expect(s[0].country).toBeNull(); // missing years stay gaps, never zero
  });

  it("offers only the series the register has for the finding type", () => {
    expect(registerOptions(context, "blood_csf").map((o) => o.key)).toContain("mrsa");
    expect(registerOptions(context, "blood_csf").map((o) => o.key)).not.toContain("cpe-ecoli");
    expect(registerOptions(context, "carriage").map((o) => o.key)).toContain("cpe-ecoli");
  });

  it("pie: sums species within a type, excludes not_MRSA, and never mixes bloodstream with carriage", () => {
    const blood = notificationShare(context, "wsc:05", "blood_csf");
    expect(blood.year).toBe(2025);
    expect(blood.total).toBe(23 + 4 + 18); // ESBL E. coli + ESBL K. pneumoniae + MRSA
    expect(blood.slices.map((s) => [s.label, s.cases])).toEqual([["ESBL", 27], ["MRSA", 18]]);
    expect(blood.slices.reduce((p, s) => p + s.pct, 0)).toBeCloseTo(100, 6);
    const carriage = notificationShare(context, "wsc:05", "carriage");
    expect(carriage.total).toBe(492 + 17);
  });

  it("pie: an area with no notifications gives an empty result instead of a broken chart", () => {
    expect(notificationShare(context, "wsc:99", "blood_csf")).toEqual({ year: null, total: 0, slices: [] });
  });
});

describe("Finres chart", () => {
  const bench: BenchRow[] = [2023, 2024, 2022].map((year, i) => ({
    organism: "Escherichia coli", antibiotic_code: "CRO", specimen: "blood", year, n_tested: 4000 + i, pct_r: 7.04 + i,
    retrieved_at: null, source_url: null, release: "2024", caveat: null, attribution: null,
  }));
  it("labels series readably and returns years in order with n tested", () => {
    expect(finresOptions(bench)).toEqual([{ key: "Escherichia coli|CRO|blood", label: "E. coli · Ceftriaxone · blood" }]);
    expect(finresSeries(bench, "Escherichia coli|CRO|blood").map((p) => p.year)).toEqual([2022, 2023, 2024]);
    expect(finresSeries(bench, "Escherichia coli|CRO|blood")[1]).toEqual({ year: 2023, pct: 7, n: 4000 });
  });
});

describe("provenance", () => {
  const now = Date.parse("2026-10-18T12:00:00Z");
  it("reports when data was collected and flags an overdue monthly import", () => {
    const fresh = freshness({ source_id: "thl_nidr", name: "", landing_url: null, attribution: null, licence: null, update_cadence: null, last_import_at: "2026-10-17T14:02:01Z" }, now);
    expect(fresh).toMatchObject({ daysAgo: 0, stale: false });
    const old = freshness({ source_id: "thl_nidr", name: "", landing_url: null, attribution: null, licence: null, update_cadence: null, last_import_at: "2026-08-01T00:00:00Z" }, now);
    expect(old.stale).toBe(true);
    expect(freshness(undefined, now)).toEqual({ lastImport: null, daysAgo: null, stale: true });
  });
  it("summarises the years covered", () => {
    expect(yearRange([{ year: 2015 }, { year: 2025 }, { year: 2020 }])).toBe("2015–2025");
    expect(yearRange([])).toBe("–");
  });
});
