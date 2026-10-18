import type { AlertEvidence, Scope, ScopeType, Specimen, Ward } from "./data/types";

export function fmtPct(v: number | null | undefined, digits = 1): string {
  return v == null ? "–" : `${v.toFixed(digits)}%`;
}

export function fmtCi(lo: number | null | undefined, hi: number | null | undefined): string {
  return lo == null || hi == null ? "" : `${lo.toFixed(1)}–${hi.toFixed(1)}%`;
}

export function shortOrganism(name: string): string {
  const [genus, ...rest] = name.split(" ");
  return rest.length ? `${genus[0]}. ${rest.join(" ")}` : name;
}

export const SPECIMEN_LABEL: Record<Specimen, string> = {
  urine: "Urine",
  blood: "Blood",
  wound: "Wound",
  all: "All specimens",
};

export const SETTING_LABEL: Record<string, string> = {
  inpatient: "Inpatient",
  ed: "Emergency dept",
  primary_care: "Primary care",
};

export const ONSET_LABEL: Record<string, string> = {
  hospital: "Hospital-onset",
  community: "Community-onset (inpatient)",
  outpatient: "Outpatient",
};

export const PHENOTYPE_LABEL: Record<string, string> = {
  ESBL: "ESBL share",
  MRSA: "MRSA share",
  VRE: "VRE share",
  CPE: "CPE share",
};

export function scopeLabel(scope: Scope | { type: ScopeType; value: string }, wards: Ward[]): string {
  const type = "scope_type" in scope ? scope.scope_type : scope.type;
  const value = "scope_value" in scope ? scope.scope_value : scope.value;
  switch (type) {
    case "hospital":
      return "Whole hospital";
    case "ward":
      return wards.find((w) => w.ward_code === value)?.ward_en ?? value;
    case "setting":
      return SETTING_LABEL[value] ?? value;
    case "onset":
      return ONSET_LABEL[value] ?? value;
  }
}

/** Template sentence for an alert; every number comes from the evidence JSON (BUILD_PLAN 7.4). */
export function alertHeadline(e: AlertEvidence, wards: Ward[], abxName: (c: string) => string): string {
  const where = scopeLabel(e.scope, wards);
  const what = `${shortOrganism(e.organism)} ${e.specimen === "all" ? "" : SPECIMEN_LABEL[e.specimen].toLowerCase()}`.trim();
  const marker = PHENOTYPE_LABEL[e.marker] ?? `${abxName(e.marker)} resistance`;
  const c = e.current;
  const b = e.baseline;
  switch (e.type) {
    case "rate":
    case "drift":
      return (
        `${where}, ${what}: ${marker} rose to ${c.pct?.toFixed(1)}% (${c.x} of ${c.n}` +
        (c.ci ? `, 95% CI ${c.ci[0]}–${c.ci[1]}%` : "") +
        `) in the last ${c.window_weeks} weeks, against ${b?.pct?.toFixed(1)}% (${b?.x} of ${b?.n}) ` +
        "in the previous 52 weeks." +
        (e.distinct_patients ? ` ${e.distinct_patients} different patients` : "") +
        (e.breakdown.onset?.hospital ? `, ${e.breakdown.onset.hospital} hospital-onset.` : e.distinct_patients ? "." : "")
      );
    case "count":
      return (
        `${where}, ${shortOrganism(e.organism)}: ${c.k} ${e.marker} isolates in 4 weeks, ` +
        `against about ${b?.expected_4w?.toFixed(1)} expected (${b?.count_52w} in the previous 52 weeks).` +
        (e.distinct_patients ? ` ${e.distinct_patients} different patients.` : "")
      );
    case "sentinel": {
      const label = e.marker === "MEM" ? "meropenem-resistant" : e.marker;
      return `${where}: ${label} ${shortOrganism(e.organism)} in ${SPECIMEN_LABEL[e.specimen].toLowerCase()} (${c.weeks}). Sentinel event, reported on first occurrence.`;
    }
  }
}
