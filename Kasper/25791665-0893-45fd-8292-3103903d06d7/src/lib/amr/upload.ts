import { ANTIBIOTICS, MARKERS, WARDS } from "./reference";
import type { NewRecord } from "./store";

export const TEMPLATE_HEAD = ["patient_id", "sex", "age", "sample_date", "admission_date", "ward", "specimen", "organism", ...MARKERS.map((m) => m.key), ...ANTIBIOTICS.map((a) => a.code)];
export const TEMPLATE_EXAMPLE = ["P012345", "F", "72", "2025-05-19", "2025-05-12", "MED-A", "urine", "Escherichia coli", "1", "0", "0", "0", "R", "S", "", "", "", "R", "", "S", "R", "S", "S", "", ""];

function splitLine(line: string): string[] {
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
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Turns uploaded CSV text into records, collecting a message for every row that cannot be used. */
export function parseUpload(text: string): { rows: NewRecord[]; problems: string[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { rows: [], problems: ["The file needs a header row and at least one record."] };
  const head = splitLine(lines[0]).map((h) => h.trim().toLowerCase());
  const at = (name: string) => head.indexOf(name.toLowerCase());
  const required = ["patient_id", "sex", "age", "sample_date", "ward", "specimen", "organism"];
  const missing = required.filter((r) => at(r) < 0);
  if (missing.length) return { rows: [], problems: [`Missing column(s): ${missing.join(", ")}`] };
  const rows: NewRecord[] = [];
  const problems: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    const get = (name: string) => (at(name) >= 0 ? (cells[at(name)] ?? "").trim() : "");
    const patient = get("patient_id");
    const age = Number(get("age"));
    const date = get("sample_date");
    if (!patient || !date || Number.isNaN(age)) { problems.push(`Row ${i + 1}: patient_id, age and sample_date are required`); continue; }
    if (!WARDS.some((w) => w.code === get("ward"))) { problems.push(`Row ${i + 1}: unknown ward "${get("ward")}"`); continue; }
    let markers = 0;
    MARKERS.forEach((m) => { if (["1", "true", "yes", "y"].includes(get(m.key).toLowerCase())) markers |= m.bit; });
    const sus = ANTIBIOTICS.map((a) => { const v = get(a.code).toUpperCase(); return v === "R" ? "R" : v === "S" ? "S" : "-"; }).join("");
    rows.push({ patient, sex: get("sex").toUpperCase() === "M" ? "M" : "F", age, date, admission: get("admission_date") || undefined, ward: get("ward"), specimen: get("specimen"), organism: get("organism"), markers, sus });
  }
  return { rows, problems };
}
