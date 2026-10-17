import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type {
  AlertDetail,
  AlertEpisode,
  AntibiogramRow,
  BenchmarkRow,
  CurrentVsBaseline,
  DataQualityRun,
  DataSource,
  HeatmapCell,
  RateRow,
  RefData,
  ReplayStatus,
  WardComparisonRow,
} from "./types";

// Supabase source: thin selects on the read-only `api` views with the anon key.
// Column names match ./types.ts; if a view's columns change, change them there and here only.

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

export const supabaseSource: DataSource = {
  kind: "supabase",

  async replayStatus() {
    const [r] = await rows<ReplayStatus>(api().from("replay_status").select("*").limit(1));
    if (!r) throw new Error("api.replay_status returned no row");
    return r;
  },

  async ref(): Promise<RefData> {
    const [antibiotics, wards, organisms, intrinsic, weeks] = await Promise.all([
      rows<RefData["antibiotics"][number]>(api().from("ref_antibiotics").select("*")),
      rows<RefData["wards"][number]>(api().from("ref_wards").select("*")),
      rows<{ organism: string }>(api().from("ref_organisms").select("organism")),
      rows<RefData["intrinsic"][number]>(api().from("ref_intrinsic_resistance").select("organism, antibiotic_code")),
      rows<RefData["weeks"][number]>(api().from("ref_weeks").select("week_idx, label, week_start").order("week_idx")),
    ]);
    return {
      antibiotics,
      wards,
      organisms: organisms.map((o) => o.organism).sort(),
      intrinsic,
      weeks,
      phenotypes: [
        { code: "ESBL", organisms: ["Escherichia coli", "Klebsiella pneumoniae"] },
        { code: "MRSA", organisms: ["Staphylococcus aureus"] },
        { code: "VRE", organisms: ["Enterococcus faecalis"] },
      ],
    };
  },

  async currentVsBaseline(combos, scope) {
    if (!combos.length) return [];
    const all = await rows<CurrentVsBaseline>(
      api()
        .from("current_vs_baseline")
        .select("*")
        .eq("scope_type", scope.scope_type)
        .eq("scope_value", scope.scope_value)
        .in("organism", [...new Set(combos.map((c) => c.organism))])
        .in("antibiotic_code", [...new Set(combos.map((c) => c.antibiotic_code))]),
    );
    // Keep the caller's order, and return an empty row for combinations the view has nothing for.
    return combos.map(
      (c) =>
        all.find((r) => r.organism === c.organism && r.antibiotic_code === c.antibiotic_code && r.specimen === c.specimen) ?? {
          ...c,
          ...scope,
          cursor_week_idx: 0,
          window_weeks: 4,
          n_cur: 0,
          x_cur: 0,
          pct_cur: null,
          ci_cur_low: null,
          ci_cur_high: null,
          reportable_cur: false,
          n_base: 0,
          x_base: 0,
          pct_base: null,
          ci_base_low: null,
          ci_base_high: null,
          reportable_base: false,
          delta_pp: null,
          ci_separated: false,
        },
    );
  },

  async rateSeries(combo, scope, windowWeeks) {
    return rows<RateRow>(
      api()
        .from("rate_series")
        .select("*")
        .eq("organism", combo.organism)
        .eq("antibiotic_code", combo.antibiotic_code)
        .eq("specimen", combo.specimen)
        .eq("scope_type", scope.scope_type)
        .eq("scope_value", scope.scope_value)
        .eq("window_weeks", windowWeeks)
        .order("end_week_idx"),
    );
  },

  async antibiogram(specimen, scope) {
    return rows<AntibiogramRow>(
      api()
        .from("antibiogram")
        .select("*")
        .eq("specimen", specimen)
        .eq("scope_type", scope.scope_type)
        .eq("scope_value", scope.scope_value),
    );
  },

  async heatmap(specimen, scope, windowWeeks) {
    return rows<HeatmapCell>(
      api()
        .from("heatmap")
        .select("*")
        .eq("specimen", specimen)
        .eq("scope_type", scope.scope_type)
        .eq("scope_value", scope.scope_value)
        .eq("window_weeks", windowWeeks),
    );
  },

  async wardComparison(combo, windowWeeks) {
    return rows<WardComparisonRow>(
      api()
        .from("ward_comparison")
        .select("*")
        .eq("organism", combo.organism)
        .eq("antibiotic_code", combo.antibiotic_code)
        .eq("specimen", combo.specimen)
        .eq("window_weeks", windowWeeks),
    );
  },

  async alerts() {
    return rows<AlertEpisode>(api().from("alerts").select("*").order("rank", { ascending: false }));
  },

  async alertDetail(id) {
    const [r] = await rows<AlertDetail>(
      api().from("alert_detail").select("*").or(`alert_id.eq.${id},episode_id.eq.${id}`).limit(1),
    );
    return r ?? null;
  },

  async benchmarks(combo) {
    return rows<BenchmarkRow>(
      api().from("benchmarks").select("*").eq("organism", combo.organism).eq("antibiotic_code", combo.antibiotic_code),
    );
  },

  async dataQuality(limit) {
    return rows<DataQualityRun>(
      api().from("data_quality").select("*").order("week_idx", { ascending: false }).limit(limit),
    );
  },
};
