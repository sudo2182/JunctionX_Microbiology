// Row types for the read-only Supabase `api` views (BUILD_PLAN.md section 4.3).
// These are the contract between the pipeline and the dashboard: both the mock source and the
// Supabase source return exactly these shapes. Column names are snake_case to match Postgres.

export type Specimen = "urine" | "blood" | "wound" | "all";
export type ScopeType = "hospital" | "ward" | "setting" | "onset";
/** WHONET antibiotic code, or a phenotype marker. */
export type MarkerCode = string;
export const PHENOTYPE_CODES = ["ESBL", "MRSA", "VRE", "CPE"] as const;

export interface Scope {
  scope_type: ScopeType;
  /** 'ALL' for hospital, ward_code for ward, 'inpatient'|'ed'|'primary_care', 'hospital'|'community'|'outpatient'. */
  scope_value: string;
}

/** api.replay_status: single row. */
export interface ReplayStatus {
  cursor_week_idx: number;
  cursor_label: string; // '2025-W26'
  week_start: string; // ISO date of the Monday
  last_run_at: string | null;
  run_status: "ok" | "failed" | "running";
  run_url: string | null;
  isolates_this_week: number;
}

/** api.rate_series: one row per end week x window x combination x scope (thin select on agg.rates). */
export interface RateRow extends Scope {
  end_week_idx: number;
  week_label: string;
  window_weeks: number; // 1, 4, 13, 52
  organism: string;
  antibiotic_code: MarkerCode;
  specimen: Specimen;
  n_tested: number;
  n_resistant: number;
  pct_r: number | null; // 0..100, null when n_tested = 0
  wilson_low: number | null;
  wilson_high: number | null;
  reportable: boolean; // n_tested >= 30
}

/** api.current_vs_baseline: section A tiles at the cursor. */
export interface CurrentVsBaseline extends Scope {
  organism: string;
  antibiotic_code: MarkerCode;
  specimen: Specimen;
  cursor_week_idx: number;
  /** 4, or auto-widened to 13 when the 4-week window has fewer than 30 isolates. */
  window_weeks: number;
  n_cur: number;
  x_cur: number;
  pct_cur: number | null;
  ci_cur_low: number | null;
  ci_cur_high: number | null;
  reportable_cur: boolean;
  n_base: number; // the 52 weeks before the current window
  x_base: number;
  pct_base: number | null;
  ci_base_low: number | null;
  ci_base_high: number | null;
  reportable_base: boolean;
  delta_pp: number | null;
  /** true when the two Wilson intervals do not overlap (the only case the arrow is coloured). */
  ci_separated: boolean;
}

/** api.antibiogram: organism x antibiotic for a scope, %S for 4 and 52 weeks. */
export interface AntibiogramRow extends Scope {
  organism: string;
  antibiotic_code: string;
  specimen: Specimen;
  n_4w: number;
  s_4w: number;
  pct_s_4w: number | null;
  n_52w: number;
  s_52w: number;
  pct_s_52w: number | null;
  is_intrinsic: boolean;
}

/** api.heatmap: organism x antibiotic for the chosen window and scope. */
export interface HeatmapCell extends Scope {
  window_weeks: number;
  organism: string;
  antibiotic_code: string;
  specimen: Specimen;
  n_tested: number;
  n_resistant: number;
  pct_r: number | null;
  wilson_low: number | null;
  wilson_high: number | null;
  reportable: boolean;
  is_intrinsic: boolean;
}

/** api.ward_comparison: forest plot rows. */
export interface WardComparisonRow {
  organism: string;
  antibiotic_code: MarkerCode;
  specimen: Specimen;
  window_weeks: number;
  ward_code: string;
  ward_name: string;
  n_tested: number;
  n_resistant: number;
  pct_r: number | null;
  wilson_low: number | null;
  wilson_high: number | null;
  reportable: boolean;
  hospital_pct_r: number | null;
}

export type AlertType = "rate" | "count" | "sentinel" | "drift";
export type Severity = "critical" | "high" | "medium" | "low";
export type Confidence = "high" | "medium" | "low";
export type AlertStatus = "open" | "escalated" | "resolved";

/** The evidence JSON stored with each firing (BUILD_PLAN.md section 7.4). */
export interface AlertEvidence {
  type: AlertType;
  week_idx: number;
  organism: string;
  marker: MarkerCode;
  specimen: Specimen;
  scope: { type: ScopeType; value: string };
  current: {
    weeks: string;
    window_weeks: number;
    n?: number;
    x?: number;
    pct?: number;
    ci?: [number, number] | null;
    k?: number;
  };
  baseline?: {
    weeks: string;
    n?: number;
    x?: number;
    pct?: number;
    ci?: [number, number] | null;
    count_52w?: number;
    expected_4w?: number;
  };
  effect?: { abs_pp?: number; ratio?: number };
  test: { name: string; p?: number; q?: number };
  rule: string;
  distinct_patients: number | null;
  breakdown: { ward?: Record<string, number>; specimen?: Record<string, number>; onset?: Record<string, number> };
  co_resistance: Record<string, number>;
  hospital_onset_share: number | null;
  severity_points: number;
  severity: Severity;
  confidence: Confidence;
  rank_score: number;
}

/** api.alerts: one row per episode (agg.alert_episodes + latest firing). */
export interface AlertEpisode {
  episode_id: string;
  /** Stable public id used in deep links and the RSS feed, e.g. A-2025W24-URO-ECOLI-URINE-ESBL. */
  alert_id: string;
  type: AlertType;
  organism: string;
  marker: MarkerCode;
  specimen: Specimen;
  scope_type: ScopeType;
  scope_value: string;
  opened_week_idx: number;
  last_fired_week_idx: number;
  status: AlertStatus;
  severity: Severity;
  severity_points: number;
  confidence: Confidence;
  rank: number;
  headline: string;
  n_firings: number;
}

/** api.alert_detail: the episode, its latest evidence, and every firing. */
export interface AlertDetail extends AlertEpisode {
  evidence: AlertEvidence;
  firings: { week_idx: number; week_label: string; severity: Severity; confidence: Confidence }[];
}

/** api.benchmarks */
export interface BenchmarkRow {
  source: string;
  country: string;
  year: number;
  organism: string;
  antibiotic_code: string;
  specimen_scope: "invasive" | "urine" | "all";
  n_tested: number | null;
  pct_r: number;
  ci_low: number | null;
  ci_high: number | null;
  source_url: string | null;
}

/** api.data_quality: one row per replay run (week). */
export interface DataQualityRun {
  run_id: string;
  week_idx: number;
  week_label: string;
  run_at: string | null;
  run_url: string | null;
  duration_s: number | null;
  cultures_released: number;
  isolates_released: number;
  ast_released: number;
  rows_rejected: number;
  intrinsic_excluded: number;
  non_reportable: number;
  checks: { name: string; status: "pass" | "warn" | "fail"; value: number | null; detail: string }[];
  /** 52-week first-isolate de-duplication by organism|specimen: [all isolates, first isolates]. */
  dedup_52w: Record<string, [number, number]>;
}

/** api.ref_* views */
export interface Antibiotic {
  antibiotic_code: string;
  antibiotic: string;
  class: string;
  reported_for: "all" | "urine";
}
export interface Ward {
  ward_code: string;
  ward_en: string;
  ward_fi: string;
  ward_type: "in" | "out";
  institution: string;
}
export interface RefData {
  antibiotics: Antibiotic[];
  wards: Ward[];
  organisms: string[];
  intrinsic: { organism: string; antibiotic_code: string }[];
  phenotypes: { code: string; organisms: string[] }[];
  weeks: { week_idx: number; label: string; week_start: string }[];
}

export interface Combo {
  organism: string;
  antibiotic_code: MarkerCode;
  specimen: Specimen;
}

/** Everything the UI needs; implemented by the mock and the Supabase sources. */
export interface DataSource {
  readonly kind: "mock" | "supabase";
  replayStatus(): Promise<ReplayStatus>;
  ref(): Promise<RefData>;
  currentVsBaseline(combos: Combo[], scope: Scope): Promise<CurrentVsBaseline[]>;
  rateSeries(combo: Combo, scope: Scope, windowWeeks: number): Promise<RateRow[]>;
  antibiogram(specimen: Specimen, scope: Scope): Promise<AntibiogramRow[]>;
  heatmap(specimen: Specimen, scope: Scope, windowWeeks: number): Promise<HeatmapCell[]>;
  wardComparison(combo: Combo, windowWeeks: number): Promise<WardComparisonRow[]>;
  alerts(): Promise<AlertEpisode[]>;
  alertDetail(episodeId: string): Promise<AlertDetail | null>;
  benchmarks(combo: Combo): Promise<BenchmarkRow[]>;
  dataQuality(limit: number): Promise<DataQualityRun[]>;
}
