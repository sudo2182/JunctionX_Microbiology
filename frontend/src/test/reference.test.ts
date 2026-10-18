import { describe, expect, it } from "vitest";
import { ANTIBIOTICS, ORGANISMS, WARDS, setReference } from "@/lib/amr/reference";

const ward = (code: string) => ({
  code,
  name: `Ward ${code}`,
  type: "in",
  institution: "hospital",
});
const abx = (code: string) => ({ code, name: `Drug ${code}`, cls: "Class" });

describe("setReference", () => {
  it("replaces the shared lists in place, keeping the built-in display order and appending unknown codes", () => {
    const wardsRef = WARDS;
    setReference({
      wards: [ward("ZZZ"), ward("ICU"), ward("ED")],
      antibiotics: [abx("CLI"), abx("NEW"), abx("AMP")],
      organisms: ["Staphylococcus aureus", "Acinetobacter baumannii", "Escherichia coli"],
    });
    expect(WARDS).toBe(wardsRef); // same array object, so every importer sees the new rows
    expect(WARDS.map((w) => w.code)).toEqual(["ED", "ICU", "ZZZ"]);
    expect(ANTIBIOTICS.map((a) => a.code)).toEqual(["AMP", "CLI", "NEW"]);
    expect(ORGANISMS).toEqual([
      "Escherichia coli",
      "Staphylococcus aureus",
      "Acinetobacter baumannii",
    ]);
    expect(WARDS[0].name).toBe("Ward ED");
  });

  it("refuses empty reference data instead of silently keeping the built-in lists", () => {
    expect(() =>
      setReference({ wards: [], antibiotics: [abx("AMP")], organisms: ["Escherichia coli"] }),
    ).toThrow(/empty/);
  });
});
