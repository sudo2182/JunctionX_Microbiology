export const START_DATE = "2023-10-02"; // Monday of ISO week 2023-40
const DAY = 86_400_000;
const START_MS = Date.parse(START_DATE + "T00:00:00Z");

export type Ward = { code: string; name: string; type: string; institution: string };
export type Antibiotic = { code: string; name: string; cls: string };

// Built-in copies of ref.wards / ref.antibiotics / ref.organisms, in display order. They only cover the
// moment before the database answers: store.ts replaces their contents with the api.ref_* rows on load
// (setReference), and the analytics pages stay behind DataGate until then.
export const WARDS: Ward[] = [
  { code: "ED", name: "Emergency department", type: "out", institution: "hospital" },
  { code: "MED-A", name: "Internal medicine A", type: "in", institution: "hospital" },
  { code: "MED-B", name: "Internal medicine B", type: "in", institution: "hospital" },
  { code: "SURG", name: "Surgery", type: "in", institution: "hospital" },
  { code: "URO", name: "Urology", type: "in", institution: "hospital" },
  { code: "ICU", name: "Intensive care unit", type: "in", institution: "hospital" },
  { code: "GER", name: "Geriatrics", type: "in", institution: "hospital" },
  { code: "PHC-N", name: "Health centre North", type: "out", institution: "primary_care" },
  { code: "PHC-S", name: "Health centre South", type: "out", institution: "primary_care" },
];

export const ANTIBIOTICS: Antibiotic[] = [
  { code: "AMP", name: "Ampicillin", cls: "Penicillins" },
  { code: "MEC", name: "Mecillinam", cls: "Penicillins (urine)" },
  { code: "TZP", name: "Piperacillin-tazobactam", cls: "Penicillins + BLI" },
  { code: "FOX", name: "Cefoxitin (screen)", cls: "MRSA screen" },
  { code: "CXM", name: "Cefuroxime", cls: "Cephalosporin 2G" },
  { code: "CRO", name: "Ceftriaxone", cls: "Cephalosporin 3G" },
  { code: "CAZ", name: "Ceftazidime", cls: "Cephalosporin 3G" },
  { code: "MEM", name: "Meropenem", cls: "Carbapenems" },
  { code: "CIP", name: "Ciprofloxacin", cls: "Fluoroquinolones" },
  { code: "TMP", name: "Trimethoprim", cls: "Trimethoprim (urine)" },
  { code: "NIT", name: "Nitrofurantoin", cls: "Nitrofurans (urine)" },
  { code: "VAN", name: "Vancomycin", cls: "Glycopeptides" },
  { code: "CLI", name: "Clindamycin", cls: "Lincosamides" },
];

export const ORGANISMS: string[] = [
  "Escherichia coli",
  "Staphylococcus aureus",
  "Enterococcus faecalis",
  "Klebsiella pneumoniae",
  "Proteus mirabilis",
  "Pseudomonas aeruginosa",
  "Citrobacter freundii",
  "Klebsiella oxytoca",
  "Staphylococcus saprophyticus",
];

/** Keeps the built-in display order; codes the dashboard has not seen before go last, alphabetically. */
function inDisplayOrder<T>(rows: T[], key: (r: T) => string, known: string[]): T[] {
  const rank = (r: T) => {
    const i = known.indexOf(key(r));
    return i < 0 ? known.length : i;
  };
  return [...rows].sort((a, b) => rank(a) - rank(b) || key(a).localeCompare(key(b)));
}

/** Swaps the database's reference rows into the shared arrays, in place, so every importer sees them. */
export function setReference(ref: { wards: Ward[]; antibiotics: Antibiotic[]; organisms: string[] }) {
  if (!ref.wards.length || !ref.antibiotics.length || !ref.organisms.length) {
    throw new Error("Reference tables (wards, antibiotics, organisms) came back empty");
  }
  const wards = inDisplayOrder(ref.wards, (w) => w.code, WARDS.map((w) => w.code));
  const antibiotics = inDisplayOrder(ref.antibiotics, (a) => a.code, ANTIBIOTICS.map((a) => a.code));
  const organisms = inDisplayOrder(ref.organisms, (o) => o, ORGANISMS);
  WARDS.splice(0, WARDS.length, ...wards);
  ANTIBIOTICS.splice(0, ANTIBIOTICS.length, ...antibiotics);
  ORGANISMS.splice(0, ORGANISMS.length, ...organisms);
}


export const SPECIMENS = ["urine", "blood", "wound"] as const;

export const MARKERS = [
  { key: "esbl", label: "ESBL", bit: 1 },
  { key: "mrsa", label: "MRSA", bit: 2 },
  { key: "vre", label: "VRE", bit: 4 },
  { key: "cpe", label: "CPE", bit: 8 },
] as const;

export function weekIndex(date: string): number {
  return Math.floor((Date.parse(date + "T00:00:00Z") - START_MS) / DAY / 7);
}
export function weekStart(idx: number): string {
  return new Date(START_MS + idx * 7 * DAY).toISOString().slice(0, 10);
}
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY);
}
export function shortOrg(o: string) {
  const [g, s] = o.split(" ");
  return s ? `${g[0]}. ${s}` : o;
}
