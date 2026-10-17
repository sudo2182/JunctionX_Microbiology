import { describe, expect, it } from "vitest";
import { antibioticApplicability, commonAntibiotics, applicableResult } from "@/lib/amr/applicability";

describe("Guideline applicability", () => {
  it("excludes unsupported organism–antibiotic pairs", () => {
    expect(antibioticApplicability("Pseudomonas aeruginosa", "CRO").status).toBe("unsupported");
    expect(commonAntibiotics(["Escherichia coli", "Pseudomonas aeruginosa"]).map((a) => a.code)).toEqual(["TZP", "CAZ", "MEM", "CIP"]);
  });
  it("never presents cefoxitin screening as treatment", () => {
    expect(antibioticApplicability("Staphylococcus aureus", "FOX").status).toBe("screen");
    expect(commonAntibiotics(["Staphylococcus aureus"]).map((a) => a.code)).not.toContain("FOX");
  });
  it("requires confirmed urinary context and a urine specimen for restricted agents", () => {
    expect(applicableResult("Escherichia coli", "NIT", "urine", false)).toBe(false);
    expect(applicableResult("Escherichia coli", "NIT", "blood", true)).toBe(false);
    expect(applicableResult("Escherichia coli", "NIT", "urine", true)).toBe(true);
    expect(commonAntibiotics(["Escherichia coli"], false).map((a) => a.code)).not.toContain("MEC");
  });
  it("does not interpret expected ampicillin resistance as a susceptible option", () => {
    expect(antibioticApplicability("Klebsiella pneumoniae", "AMP").status).toBe("expected-resistant");
    expect(commonAntibiotics(["Klebsiella oxytoca"]).map((a) => a.code)).not.toContain("AMP");
  });
  it("does not infer a combined regimen for mixed unsupported organisms", () => {
    expect(commonAntibiotics(["Escherichia coli", "Staphylococcus aureus"])).toEqual([]);
  });
});