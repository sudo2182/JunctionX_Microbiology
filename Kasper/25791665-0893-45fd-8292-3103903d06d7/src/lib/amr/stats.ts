import { ANTIBIOTICS } from "./reference";
import type { IsolateRecord } from "./store";

export const MIN_ISOLATES = 30;

/** First isolate per patient per organism per specimen type within the given set. */
export function firstIsolates(records: IsolateRecord[]): IsolateRecord[] {
  const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date));
  const seen = new Set<string>();
  return sorted.filter((r) => {
    const k = `${r.patient}|${r.organism}|${r.specimen}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function resistance(records: IsolateRecord[], code: string) {
  const i = ANTIBIOTICS.findIndex((a) => a.code === code);
  let n = 0;
  let r = 0;
  for (const rec of records) {
    const c = rec.sus[i];
    if (c === "S" || c === "R") {
      n++;
      if (c === "R") r++;
    }
  }
  return { n, r, pct: n ? (100 * r) / n : null, reportable: n >= MIN_ISOLATES };
}
