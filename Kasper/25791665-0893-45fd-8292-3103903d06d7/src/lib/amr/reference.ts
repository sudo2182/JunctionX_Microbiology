export const START_DATE = "2023-10-02"; // Monday of ISO week 2023-40
const DAY = 86_400_000;
const START_MS = Date.parse(START_DATE + "T00:00:00Z");

export const WARDS = [
  { code: "ED", name: "Emergency department", type: "out", institution: "hospital" },
  { code: "MED-A", name: "Internal medicine A", type: "in", institution: "hospital" },
  { code: "MED-B", name: "Internal medicine B", type: "in", institution: "hospital" },
  { code: "SURG", name: "Surgery", type: "in", institution: "hospital" },
  { code: "URO", name: "Urology", type: "in", institution: "hospital" },
  { code: "ICU", name: "Intensive care unit", type: "in", institution: "hospital" },
  { code: "GER", name: "Geriatrics", type: "in", institution: "hospital" },
  { code: "PHC-N", name: "Health centre North", type: "out", institution: "primary_care" },
  { code: "PHC-S", name: "Health centre South", type: "out", institution: "primary_care" },
] as const;

export const ANTIBIOTICS = [
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
] as const;

export const ORGANISMS = [
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
