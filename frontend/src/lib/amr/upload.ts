import { ANTIBIOTICS, MARKERS, ORGANISMS, SPECIMENS, WARDS } from "./reference";
import type { NewRecord } from "./store";

// Built on call, not at import: ANTIBIOTICS is replaced by the database's list once it loads.
export const templateHead = () => ["patient_id", "sex", "age", "sample_date", "admission_date", "ward", "specimen", "organism", ...MARKERS.map((m) => m.key), ...ANTIBIOTICS.map((a) => a.code)];
const EXAMPLE_AST: Record<string, string> = { AMP: "R", MEC: "S", CRO: "R", MEM: "S", CIP: "R", TMP: "S", NIT: "S" };
export const templateExample = () => ["P012345", "F", "72", "2025-05-19", "2025-05-12", "MED-A", "urine", "Escherichia coli", "1", "0", "0", "0", ...ANTIBIOTICS.map((a) => EXAMPLE_AST[a.code] ?? "")];

/** One upload is saved in a single database request, so it is all-or-nothing; this keeps that request small. */
export const MAX_UPLOAD_ROWS = 2000;

function splitLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Excel in Finnish/European locales saves ";"-separated CSV; some tools use tabs. Pick what the header uses. */
function detectSeparator(header: string): string {
  const count = (c: string) => header.split(c).length - 1;
  return [",", ";", "\t"].reduce((best, c) => (count(c) > count(best) ? c : best), ",");
}

const isIsoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

/** Same isolate = same patient, sample date, ward, specimen and organism. */
export const recordKey = (r: { patient: string; date: string; ward: string; specimen: string; organism: string }) =>
  [r.patient, r.date, r.ward, r.specimen, r.organism].map((v) => v.trim().toLowerCase()).join("|");

export type ParseOptions = {
  /** recordKey() of records already in the database, so re-uploading a file does not create duplicates. */
  existing?: ReadonlySet<string>;
  /** "Today" as YYYY-MM-DD (sample dates may not be later). Defaults to the current UTC date. */
  today?: string;
};

export type ParseResult = { rows: NewRecord[]; problems: string[]; duplicates: number };

/**
 * Turns uploaded CSV text into records. Every value is checked against the dashboard's reference lists; a row with
 * any problem is skipped (never guessed) and reported with all of its problems, so the user can fix the file.
 */
export function parseUpload(text: string, opts: ParseOptions = {}): ParseResult {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { rows: [], problems: ["The file needs a header row and at least one record."], duplicates: 0 };
  if (lines.length - 1 > MAX_UPLOAD_ROWS) return { rows: [], problems: [`The file has ${lines.length - 1} rows; upload at most ${MAX_UPLOAD_ROWS} at a time.`], duplicates: 0 };
  const sep = detectSeparator(lines[0]);
  const head = splitLine(lines[0], sep).map((h) => h.trim().toLowerCase());
  const at = (name: string) => head.indexOf(name.toLowerCase());
  const required = ["patient_id", "sex", "age", "sample_date", "ward", "specimen", "organism"];
  const missing = required.filter((r) => at(r) < 0);
  if (missing.length) return { rows: [], problems: [`Missing column(s): ${missing.join(", ")}. Download the template for the expected header.`], duplicates: 0 };

  const rows: NewRecord[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  let duplicates = 0;

  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i], sep);
    const get = (name: string) => (at(name) >= 0 ? (cells[at(name)] ?? "").trim() : "");
    const issues: string[] = [];

    const patient = get("patient_id");
    if (!patient) issues.push("patient_id is empty");
    else if (!/^[A-Za-z0-9_-]{1,32}$/.test(patient)) issues.push(`patient_id "${patient}" may only contain letters, digits, - and _ (max 32)`);

    const sexRaw = get("sex").toLowerCase();
    const sex = ["f", "female", "woman", "w"].includes(sexRaw) ? "F" : ["m", "male", "man"].includes(sexRaw) ? "M" : null;
    if (!sex) issues.push(`sex "${get("sex")}" must be F or M`);

    const ageRaw = get("age");
    const age = Number(ageRaw);
    if (ageRaw === "" || !Number.isInteger(age) || age < 0 || age > 120) issues.push(`age "${ageRaw}" must be a whole number 0–120`);

    const date = get("sample_date");
    if (!isIsoDate(date)) issues.push(`sample_date "${date}" must be a date written YYYY-MM-DD`);
    else if (date > today) issues.push(`sample_date ${date} is in the future`);

    const admission = get("admission_date");
    if (admission && !isIsoDate(admission)) issues.push(`admission_date "${admission}" must be YYYY-MM-DD or empty`);
    else if (admission && isIsoDate(date) && admission > date) issues.push(`admission_date ${admission} is after sample_date ${date}`);

    const ward = WARDS.find((w) => w.code.toLowerCase() === get("ward").toLowerCase())?.code;
    if (!ward) issues.push(`unknown ward "${get("ward")}"`);

    const specimen = SPECIMENS.find((s) => s === get("specimen").toLowerCase());
    if (!specimen) issues.push(`specimen "${get("specimen")}" must be one of ${SPECIMENS.join(", ")}`);

    const organism = ORGANISMS.find((o) => o.toLowerCase() === get("organism").toLowerCase());
    if (!organism) issues.push(`unknown organism "${get("organism")}" (use the full name, e.g. Escherichia coli)`);

    let markers = 0;
    for (const m of MARKERS) {
      const v = get(m.key).toLowerCase();
      if (["1", "true", "yes", "y"].includes(v)) markers |= m.bit;
      else if (!["", "0", "false", "no", "n"].includes(v)) issues.push(`${m.key} "${get(m.key)}" must be 0 or 1`);
    }

    const sus = ANTIBIOTICS.map((a) => {
      const v = get(a.code).toUpperCase();
      if (v === "R" || v === "S") return v;
      if (v === "" || v === "-") return "-";
      issues.push(v === "I" ? `${a.code} "I" is not used in this dataset: enter S or R, or leave empty` : `${a.code} "${get(a.code)}" must be S, R or empty`);
      return "-";
    }).join("");

    if (issues.length) {
      problems.push(`Row ${i + 1}: ${issues.join("; ")}`);
      continue;
    }
    const row: NewRecord = { patient, sex: sex!, age, date, admission: admission || undefined, ward: ward!, specimen: specimen!, organism: organism!, markers, sus };
    const key = recordKey(row);
    if (seen.has(key)) { duplicates++; problems.push(`Row ${i + 1}: same isolate as an earlier row in this file (skipped)`); continue; }
    if (opts.existing?.has(key)) { duplicates++; problems.push(`Row ${i + 1}: already in the database (skipped)`); continue; }
    seen.add(key);
    rows.push(row);
  }
  return { rows, problems, duplicates };
}
