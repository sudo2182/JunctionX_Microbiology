import { describe, expect, it } from "vitest";
import { TEMPLATE_HEAD, parseUpload } from "@/lib/amr/upload";

const csv = (...rows: string[]) => [TEMPLATE_HEAD.join(","), ...rows].join("\n");

describe("bulk upload", () => {
  it("reads a complete row into markers and susceptibility results", () => {
    const { rows, problems } = parseUpload(csv("P1,F,70,2025-05-19,2025-05-12,MED-A,urine,Escherichia coli,1,0,0,0,R,S,,,,R,,S,R,S,S,,"));
    expect(problems).toEqual([]);
    expect(rows[0]).toMatchObject({ patient: "P1", sex: "F", age: 70, date: "2025-05-19", admission: "2025-05-12", ward: "MED-A", markers: 1 });
    expect(rows[0]?.sus.slice(0, 3)).toBe("RS-");
    expect(rows[0]?.sus).toHaveLength(13);
  });
  it("skips rows whose ward is not one of ours", () => {
    const { rows, problems } = parseUpload(csv("P1,F,70,2025-05-19,,SPACE,urine,Escherichia coli,0,0,0,0,", "P2,M,40,2025-05-20,,ICU,blood,Klebsiella pneumoniae,0,0,0,0,"));
    expect(rows).toHaveLength(1);
    expect(problems[0]).toContain("Row 2");
    expect(problems[0]).toContain("SPACE");
  });
  it("refuses a file without the columns it needs", () => {
    expect(parseUpload("patient_id,ward\nP1,ICU").problems[0]).toContain("sample_date");
    expect(parseUpload("").problems.length).toBe(1);
  });
});
