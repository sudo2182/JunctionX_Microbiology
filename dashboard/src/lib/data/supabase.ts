import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { MIN_N } from "../stats";
import type {
  AlertDetail,
  AlertEpisode,
  AlertEvidence,
  AntibiogramRow,
  BenchmarkRow,
  Combo,
  CurrentVsBaseline,
  DataQualityRun,
  DataSource,
  HeatmapCell,
  RateRow,
  RefData,
  ReplayStatus,
  Scope,
  WardComparisonRow,
} from "./types";

// Supabase source: thin selects on the read-only `api` views (supabase/migrations/*_api_views.sql)
// with the anon key. The views' column names differ in places from the UI row types in ./types.ts,
// so each method maps one to the other here; nothing outside this file knows the view columns.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiClient = SupabaseClient<any, "api", "api">;
let client: ApiClient | null = null;
function api(): ApiClient {
  if (!client) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client = createClient<any, "api">(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      db: { schema: "api" },
      auth: { persistSession: false },
    }) as ApiClient;
  }
  return client;
}

async function rows<T>(q: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw new Error(`Supabase api view query failed: ${error.message}`);
  return (data ?? []) as T[];
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));

// ---------------------------------------------------------------------------- view row shapes
interface ReplayStatusView {
  cursor_week_idx: number;
  data_through: string | null;
  week_start: string | null;
  last_run_status: "running" | "success" | "failed" | null;
  last_run_finished_at: string | null;
  last_run_url: string | null;
  isolates_this_week: number;
}
interface RateView {
  end_week_idx: number;
  end_week: string;
  window_weeks: number;
  organism: string;
  antibiotic_code: string;
  specimen: RateRow["specimen"];
  scope_type: RateRow["scope_type"];
  scope_value: string;
  n_tested: number;
  n_resistant: number;
  pct_r: number | null;
  wilson_low: number | null;
  wilson_high: number | null;
  reportable: boolean;
}
interface CvbView extends Combo, Scope {
  end_week_idx: number;
  current_window_weeks: number;
  n_current: number;
  x_current: number;
  pct_r_current: number | null;
  wilson_low_current: number | null;
  wilson_high_current: number | null;
  reportable_current: boolean;
  n_52w: number;
  x_52w: number;
  pct_r_52w: number | null;
  wilson_low_52w: number | null;
  wilson_high_52w: number | null;
  reportable_52w: boolean;
  delta_pp: number | null;
  ci_separated: boolean;
}
interface AntibiogramView extends Combo, Scope {
  n_4w: number | null;
  x_4w: number | null;
  n_52w: number | null;
  x_52w: number | null;
}
interface WardView extends Omit<RateView, "scope_type" | "scope_value" | "end_week"> {
  ward_code: string;
  ward_en: string;
  hospital_pct_r: number | null;
}
interface AlertView {
  episode_id: string;
  signal_type: AlertEpisode["type"];
  organism: string;
  antibiotic_code: string;
  specimen: AlertEpisode["specimen"];
  scope_type: AlertEpisode["scope_type"];
  scope_value: string;
  opened_week: number;
  last_fired_week: number;
  status: AlertEpisode["status"];
  severity: AlertEpisode["severity"];
  confidence: AlertEpisode["confidence"];
  rank: number;
  explanation: string | null;
  latest_evidence: (Partial<AlertEvidence> & { alert_id?: string }) | null;
}
interface DqView {
  run_id: string;
  week_idx: number;
  week: string;
  check_name: string;
  value: number | null;
  status: "info" | "pass" | "warn" | "fail";
  detail: string | null;
  run_started_at: string | null;
  run_url: string | null;
}

// ---------------------------------------------------------------------------- mappers
const toRate = (r: RateView): RateRow => ({
  ...r,
  week_label: r.end_week,
  pct_r: num(r.pct_r),
  wilson_low: num(r.wilson_low),
  wilson_high: num(r.wilson_high),
});

function toEpisode(a: AlertView): AlertEpisode {
  const ev = a.latest_evidence ?? {};
  return {
    episode_id: a.episode_id,
    alert_id: ev.alert_id ?? a.episode_id,
    type: a.signal_type,
    organism: a.organism,
    marker: a.antibiotic_code,
    specimen: a.specimen,
    scope_type: a.scope_type,
    scope_value: a.scope_value,
    opened_week_idx: a.opened_week,
    last_fired_week_idx: a.last_fired_week,
    status: a.status,
    severity: a.severity,
    severity_points: ev.severity_points ?? 0,
    confidence: a.confidence,
    rank: Number(a.rank),
    headline: a.explanation ?? "",
    n_firings: 0,
  };
}

const CHECK_LABEL: Record<string, string> = {
  volume_vs_trailing_median: "Weekly volume vs trailing median",
  isolates_without_ast: "Every isolate has susceptibility rows",
  sample_date_after_week_end: "No sample dates after the week end",
  onset_unknown: "Onset could be derived",
  first_isolate_removed_4w: "First-isolate de-duplication (4 weeks)",
};

let cursorCache: { at: number; value: number } | null = null;
async function cursor(): Promise<number> {
  if (cursorCache && Date.now() - cursorCache.at < 10_000) return cursorCache.value;
  const [r] = await rows<{ cursor_week_idx: number }>(api().from("replay_status").select("cursor_week_idx").limit(1));
  cursorCache = { at: Date.now(), value: r?.cursor_week_idx ?? 0 };
  return cursorCache.value;
}

async function intrinsic() {
  return rows<{ organism: string; antibiotic_code: string }>(
    api().from("ref_intrinsic_resistance").select("organism, antibiotic_code"),
  );
}

export const supabaseSource: DataSource = {
  kind: "supabase",

  async replayStatus() {
    const [r] = await rows<ReplayStatusView>(api().from("replay_status").select("*").limit(1));
    if (!r) throw new Error("api.replay_status returned no row");
    return {
      cursor_week_idx: r.cursor_week_idx,
      cursor_label: r.data_through ?? "no data yet",
      week_start: r.week_start ?? "",
      last_run_at: r.last_run_finished_at,
      run_status: r.last_run_status === "failed" ? "failed" : r.last_run_status === "running" ? "running" : "ok",
      run_url: r.last_run_url,
      isolates_this_week: r.isolates_this_week ?? 0,
    } satisfies ReplayStatus;
  },

  async ref(): Promise<RefData> {
    const [antibiotics, wards, organisms, intr, weeks, phenos] = await Promise.all([
      rows<RefData["antibiotics"][number]>(api().from("ref_antibiotics").select("*")),
      rows<RefData["wards"][number]>(api().from("ref_wards").select("*")),
      rows<{ name: string }>(api().from("ref_organisms").select("name")),
      intrinsic(),
      rows<RefData["weeks"][number]>(api().from("ref_weeks").select("week_idx, label, week_start").order("week_idx")),
      rows<{ marker: string; organism: string }>(api().from("ref_phenotypes").select("marker, organism")),
    ]);
    const byMarker = new Map<string, string[]>();
    for (const p of phenos) byMarker.set(p.marker, [...(byMarker.get(p.marker) ?? []), p.organism]);
    return {
      antibiotics,
      wards,
      organisms: organisms.map((o) => o.name).sort(),
      intrinsic: intr,
      weeks,
      phenotypes: [...byMarker].map(([code, orgs]) => ({ code, organisms: orgs })),
    };
  },

  async currentVsBaseline(combos, scope) {
    if (!combos.length) return [];
    const all = await rows<CvbView>(
      api()
        .from("current_vs_baseline")
        .select("*")
        .eq("scope_type", scope.scope_type)
        .eq("scope_value", scope.scope_value)
        .in("organism", [...new Set(combos.map((c) => c.organism))])
        .in("antibiotic_code", [...new Set(combos.map((c) => c.antibiotic_code))]),
    );
    // Keep the caller's order; the view has no row when the 4-week window is empty.
    return combos.map((c): CurrentVsBaseline => {
      const r = all.find((x) => x.organism === c.organism && x.antibiotic_code === c.antibiotic_code && x.specimen === c.specimen);
      return {
        ...c,
        ...scope,
        cursor_week_idx: r?.end_week_idx ?? 0,
        window_weeks: r?.current_window_weeks ?? 4,
        n_cur: r?.n_current ?? 0,
        x_cur: r?.x_current ?? 0,
        pct_cur: num(r?.pct_r_current),
        ci_cur_low: num(r?.wilson_low_current),
        ci_cur_high: num(r?.wilson_high_current),
        reportable_cur: r?.reportable_current ?? false,
        n_base: r?.n_52w ?? 0,
        x_base: r?.x_52w ?? 0,
        pct_base: num(r?.pct_r_52w),
        ci_base_low: num(r?.wilson_low_52w),
        ci_base_high: num(r?.wilson_high_52w),
        reportable_base: r?.reportable_52w ?? false,
        delta_pp: num(r?.delta_pp),
        ci_separated: r?.ci_separated ?? false,
      };
    });
  },

  async rateSeries(combo, scope, windowWeeks) {
    const r = await rows<RateView>(
      api()
        .from("rate_series")
        .select("*")
        .eq("organism", combo.organism)
        .eq("antibiotic_code", combo.antibiotic_code)
        .eq("specimen", combo.specimen)
        .eq("scope_type", scope.scope_type)
        .eq("scope_value", scope.scope_value)
        .eq("window_weeks", windowWeeks)
        .order("end_week_idx")
        .limit(200),
    );
    return r.map(toRate);
  },

  async antibiogram(specimen, scope) {
    const [r, intr] = await Promise.all([
      rows<AntibiogramView>(
        api()
          .from("antibiogram")
          .select("organism, antibiotic_code, specimen, scope_type, scope_value, n_4w, x_4w, n_52w, x_52w")
          .eq("specimen", specimen)
          .eq("scope_type", scope.scope_type)
          .eq("scope_value", scope.scope_value),
      ),
      intrinsic(),
    ]);
    const out: AntibiogramRow[] = r.map((x) => {
      const n4 = x.n_4w ?? 0;
      const n52 = x.n_52w ?? 0;
      const s4 = n4 - (x.x_4w ?? 0);
      const s52 = n52 - (x.x_52w ?? 0);
      return {
        organism: x.organism,
        antibiotic_code: x.antibiotic_code,
        specimen,
        ...scope,
        n_4w: n4,
        s_4w: s4,
        pct_s_4w: n4 ? (s4 / n4) * 100 : null,
        n_52w: n52,
        s_52w: s52,
        pct_s_52w: n52 ? (s52 / n52) * 100 : null,
        is_intrinsic: false,
      };
    });
    const organisms = new Set(out.map((x) => x.organism));
    for (const i of intr.filter((i) => organisms.has(i.organism))) {
      out.push({ ...i, specimen, ...scope, n_4w: 0, s_4w: 0, pct_s_4w: null, n_52w: 0, s_52w: 0, pct_s_52w: null, is_intrinsic: true });
    }
    return out;
  },

  async heatmap(specimen, scope, windowWeeks) {
    const t = await cursor();
    const [r, intr] = await Promise.all([
      rows<RateView>(
        api()
          .from("heatmap")
          .select("*")
          .eq("end_week_idx", t)
          .eq("specimen", specimen)
          .eq("scope_type", scope.scope_type)
          .eq("scope_value", scope.scope_value)
          .eq("window_weeks", windowWeeks),
      ),
      intrinsic(),
    ]);
    const cells: HeatmapCell[] = r.map((x) => ({ ...toRate(x), is_intrinsic: false }));
    const organisms = new Set(cells.map((c) => c.organism));
    for (const i of intr.filter((i) => organisms.has(i.organism))) {
      cells.push({
        ...i,
        specimen,
        ...scope,
        window_weeks: windowWeeks,
        n_tested: 0,
        n_resistant: 0,
        pct_r: null,
        wilson_low: null,
        wilson_high: null,
        reportable: false,
        is_intrinsic: true,
      });
    }
    return cells;
  },

  async wardComparison(combo, windowWeeks) {
    const t = await cursor();
    const r = await rows<WardView>(
      api()
        .from("ward_comparison")
        .select("*")
        .eq("end_week_idx", t)
        .eq("organism", combo.organism)
        .eq("antibiotic_code", combo.antibiotic_code)
        .eq("specimen", combo.specimen)
        .eq("window_weeks", windowWeeks),
    );
    return r.map(
      (x): WardComparisonRow => ({
        ...combo,
        window_weeks: windowWeeks,
        ward_code: x.ward_code,
        ward_name: x.ward_en,
        n_tested: x.n_tested,
        n_resistant: x.n_resistant,
        pct_r: num(x.pct_r),
        wilson_low: num(x.wilson_low),
        wilson_high: num(x.wilson_high),
        reportable: x.reportable ?? x.n_tested >= MIN_N,
        hospital_pct_r: num(x.hospital_pct_r),
      }),
    );
  },

  async alerts() {
    const r = await rows<AlertView>(api().from("alerts").select("*").order("rank", { ascending: false }));
    // Active first, then rank, then recency (same order as the RSS feed).
    const active = (s: string) => s === "open" || s === "escalated";
    return r
      .map(toEpisode)
      .sort(
        (a, b) =>
          Number(!active(a.status)) - Number(!active(b.status)) ||
          b.rank - a.rank ||
          b.last_fired_week_idx - a.last_fired_week_idx,
      );
  },

  async alertDetail(id) {
    // The public id (alert_id) lives inside the evidence JSON; accept either it or the episode_id.
    const safe = id.replace(/[^A-Za-z0-9_-]/g, "");
    const [a] = await rows<AlertView>(
      api().from("alerts").select("*").or(`episode_id.eq.${safe},latest_evidence->>alert_id.eq.${safe}`).limit(1),
    );
    if (!a) return null;
    const firings = await rows<{ week_idx: number; week: string; evidence: AlertEvidence }>(
      api().from("alert_detail").select("week_idx, week, evidence").eq("episode_id", a.episode_id).order("week_idx"),
    );
    const ep = toEpisode(a);
    return {
      ...ep,
      n_firings: firings.length,
      evidence: (firings.at(-1)?.evidence ?? a.latest_evidence) as AlertEvidence,
      firings: firings.map((f) => ({
        week_idx: f.week_idx,
        week_label: f.week,
        severity: f.evidence?.severity ?? ep.severity,
        confidence: f.evidence?.confidence ?? ep.confidence,
      })),
    } satisfies AlertDetail;
  },

  async benchmarks(combo) {
    return rows<BenchmarkRow>(
      api()
        .from("benchmarks")
        .select("*")
        .eq("organism", combo.organism)
        .eq("antibiotic_code", combo.antibiotic_code)
        .in("specimen", [combo.specimen, "all"]),
    );
  },

  async dataQuality(limit) {
    // api.data_quality is long (one row per run x check); pivot to one row per run.
    const weeks = await rows<{ week_idx: number }>(
      api().from("data_quality").select("week_idx").order("week_idx", { ascending: false }).limit(limit * 20),
    );
    const keep = [...new Set(weeks.map((w) => w.week_idx))].slice(0, limit);
    if (!keep.length) return [];
    const [r, runs] = await Promise.all([
      rows<DqView>(api().from("data_quality").select("*").in("week_idx", keep)),
      rows<{ run_id: string; started_at: string | null; finished_at: string | null }>(
        api().from("pipeline_runs").select("run_id, started_at, finished_at"),
      ),
    ]);
    const byRun = new Map<string, DqView[]>();
    for (const x of r) byRun.set(x.run_id, [...(byRun.get(x.run_id) ?? []), x]);
    const out: DataQualityRun[] = [];
    for (const [run_id, checks] of byRun) {
      const v = (name: string) => Number(checks.find((c) => c.check_name === name)?.value ?? 0);
      const run = runs.find((x) => x.run_id === run_id);
      const dur =
        run?.started_at && run.finished_at ? Math.round((Date.parse(run.finished_at) - Date.parse(run.started_at)) / 1000) : null;
      out.push({
        run_id,
        week_idx: checks[0].week_idx,
        week_label: checks[0].week,
        run_at: checks[0].run_started_at,
        run_url: checks[0].run_url,
        duration_s: dur,
        cultures_released: v("cultures_released"),
        isolates_released: v("isolates_released"),
        ast_released: v("ast_results_released"),
        rows_rejected: v("rows_rejected"),
        intrinsic_excluded: v("ast_intrinsic_excluded"),
        non_reportable: v("ast_not_reportable"),
        checks: checks
          .filter((c) => c.status !== "info")
          .map((c) => ({
            name: CHECK_LABEL[c.check_name] ?? c.check_name,
            status: c.status as "pass" | "warn" | "fail",
            value: num(c.value),
            detail: c.detail ?? "",
          })),
        dedup_52w: {},
      });
    }
    return out.sort((a, b) => b.week_idx - a.week_idx);
  },
};
