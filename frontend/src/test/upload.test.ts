import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_ROWS, parseUpload, recordKey, templateExample, templateHead } from "@/lib/amr/upload";

const TODAY = "2026-10-18";
const csv = (...rows: string[]) => [templateHead().join(","), ...rows].join("\n");
const parse = (text: string, existing?: Set<string>) => parseUpload(text, { today: TODAY, existing });
// A valid row in template column order: 8 fields, 4 markers, 13 antibiotics.
const row = (o: Partial<Record<"patient" | "sex" | "age" | "date" | "adm" | "ward" | "spec" | "org", string>> = {}, markers = "0,0,0,0", ast = ",,,,,,,,,,,,") =>
  [o.patient ?? "P1", o.sex ?? "F", o.age ?? "70", o.date ?? "2025-05-19", o.adm ?? "2025-05-12", o.ward ?? "MED-A", o.spec ?? "urine", o.org ?? "Escherichia coli", markers, ast].join(",");

describe("bulk upload: valid data", () => {
  it("reads the downloadable template example as one valid record", () => {
    const { rows, problems } = parse([templateHead().join(","), templateExample().join(",")].join("\n"));
    expect(problems).toEqual([]);
    expect(rows[0]).toMatchObject({ patient: "P012345", sex: "F", age: 72, ward: "MED-A", specimen: "urine", organism: "Escherichia coli", markers: 1 });
  });
  it("reads a complete row into markers and susceptibility results", () => {
    const { rows, problems } = parse(csv("P1,F,70,2025-05-19,2025-05-12,MED-A,urine,Escherichia coli,1,0,0,0,R,S,,,,R,,S,R,S,S,,"));
    expect(problems).toEqual([]);
    expect(rows[0]).toMatchObject({ patient: "P1", sex: "F", age: 70, date: "2025-05-19", admission: "2025-05-12", ward: "MED-A", markers: 1 });
    expect(rows[0]?.sus.slice(0, 3)).toBe("RS-");
    expect(rows[0]?.sus).toHaveLength(13);
  });
  it("accepts common spellings and normalises case", () => {
    const { rows, problems } = parse(csv(row({ sex: "male", ward: "icu", spec: "Urine", org: "escherichia COLI" })));
    expect(problems).toEqual([]);
    expect(rows[0]).toMatchObject({ sex: "M", ward: "ICU", specimen: "urine", organism: "Escherichia coli" });
  });
  it("handles Excel files: byte-order mark, semicolons and Windows line endings", () => {
    const text = "﻿" + [templateHead().join(";"), row().replace(/,/g, ";")].join("\r\n");
    const { rows, problems } = parse(text);
    expect(problems).toEqual([]);
    expect(rows).toHaveLength(1);
  });
});

describe("bulk upload: problems are reported, never guessed", () => {
  const issue = (r: string) => parse(csv(r)).problems[0] ?? "";
  it("does not turn an unknown sex into female", () => {
    expect(issue(row({ sex: "X" }))).toContain('sex "X" must be F or M');
  });
  it("does not turn a missing age into 0, and rejects impossible ages", () => {
    expect(issue(row({ age: "" }))).toContain("age");
    expect(issue(row({ age: "130" }))).toContain("0–120");
    expect(issue(row({ age: "7.5" }))).toContain("whole number");
  });
  it("rejects badly written, impossible and future dates", () => {
    expect(issue(row({ date: "19/05/2025" }))).toContain("YYYY-MM-DD");
    expect(issue(row({ date: "2025-02-30" }))).toContain("YYYY-MM-DD");
    expect(issue(row({ date: "2027-01-01", adm: "" }))).toContain("in the future");
    expect(issue(row({ adm: "2025-06-01" }))).toContain("after sample_date");
  });
  it("rejects unknown wards, specimens and organisms instead of saving invisible records", () => {
    expect(issue(row({ ward: "SPACE" }))).toContain('unknown ward "SPACE"');
    expect(issue(row({ spec: "sputum" }))).toContain("specimen");
    expect(issue(row({ org: "E coli" }))).toContain("unknown organism");
  });
  it("does not silently drop intermediate or invalid antibiotic results", () => {
    expect(issue(row({}, "0,0,0,0", "I,,,,,,,,,,,,"))).toContain('"I" is not used');
    expect(issue(row({}, "0,0,0,0", "x,,,,,,,,,,,,"))).toContain("must be S, R or empty");
    expect(issue(row({}, "2,0,0,0"))).toContain("esbl");
  });
  it("lists every problem of a row together", () => {
    const p = issue(row({ sex: "?", age: "", ward: "NOPE" }));
    expect(p).toMatch(/Row 2: .*sex.*age.*ward/);
  });
  it("keeps the good rows when some rows are bad", () => {
    const { rows, problems } = parse(csv(row({ patient: "P1" }), row({ patient: "P2", ward: "NOPE" }), row({ patient: "P3" })));
    expect(rows.map((r) => r.patient)).toEqual(["P1", "P3"]);
    expect(problems).toHaveLength(1);
  });
  it("refuses a file without the columns it needs, and an empty file", () => {
    expect(parseUpload("patient_id,ward\nP1,ICU").problems[0]).toContain("sample_date");
    expect(parseUpload("").problems.length).toBe(1);
  });
  it("refuses files larger than one all-or-nothing save", () => {
    const big = csv(...Array.from({ length: MAX_UPLOAD_ROWS + 1 }, (_, i) => row({ patient: `P${i}` })));
    expect(parse(big).problems[0]).toContain(`at most ${MAX_UPLOAD_ROWS}`);
  });
});

describe("bulk upload: no duplicates", () => {
  it("skips a repeated isolate inside the same file", () => {
    const { rows, duplicates } = parse(csv(row(), row()));
    expect(rows).toHaveLength(1);
    expect(duplicates).toBe(1);
  });
  it("skips isolates already in the database, so uploading a file twice is safe", () => {
    const first = parse(csv(row({ patient: "P1" }), row({ patient: "P2" })));
    const existing = new Set(first.rows.map(recordKey));
    const again = parse(csv(row({ patient: "P1" }), row({ patient: "P2" }), row({ patient: "P3" })), existing);
    expect(again.rows.map((r) => r.patient)).toEqual(["P3"]);
    expect(again.duplicates).toBe(2);
    expect(again.problems[0]).toContain("already in the database");
  });
});
