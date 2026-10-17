import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { alertHeadline } from "../format";
import { MIN_N, pct, wilson } from "../stats";
import type {
  AlertDetail,
  AlertEpisode,
  AlertEvidence,
  AntibiogramRow,
  Combo,
  CurrentVsBaseline,
  DataQualityRun,
  DataSource,
  HeatmapCell,
  RateRow,
  RefData,
  ReplayStatus,
  Scope,
  Specimen,
  WardComparisonRow,
} from "./types";
import { PHENOTYPE_CODES } from "./types";

// Mock source: reads the compact JSON written by scripts/build_mock.py and returns rows shaped
// exactly like the api views. The replay cursor comes from MOCK_CURSOR_WEEK (default 91 = 2025-W26,
// during the planted Urology ESBL outbreak; 130 = 2026-W13 shows the ICU MRSA cluster).

interface RawRef {
  weeks: RefData["weeks"];
  antibiotics: RefData["antibiotics"];
  wards: RefData["wards"];
  organisms: { organism: string; enterobacterales: boolean }[];
  intrinsic: RefData["intrinsic"];
  phenotypes: RefData["phenotypes"];
}
interface RawQuality {
  week_idx: number;
  label: string;
  cultures: number;
  isolates: number;
  ast_results: number;
  rejected: number;
  intrinsic_flagged: number;
  non_reportable: number;
  volume_vs_median: number | null;
  isolates_without_ast: number;
  invalid_results: number;
  dedup_52w: Record<string, [number, number]>;
}

const MOCK_DIR = path.join(process.cwd(), "src", "mock");

interface Store {
  ref: RawRef;
  series: Record<string, [number[], number[]]>;
  firings: AlertEvidence[];
  quality: RawQuality[];
}

let store: Store | null = null;
function load(): Store {
  if (store) return store;
  const read = (f: string) => readFileSync(path.join(MOCK_DIR, f), "utf8");
  store = {
    ref: JSON.parse(read("ref.json")),
    series: JSON.parse(gunzipSync(readFileSync(path.join(MOCK_DIR, "series.json.gz"))).toString("utf8")),
    firings: JSON.parse(read("firings.json")),
    quality: JSON.parse(read("quality.json")),
  };
  return store;
}

function cursor(): number {
  const n = Number(process.env.MOCK_CURSOR_WEEK ?? 91);
  const max = load().ref.weeks.length;
  return Number.isFinite(n) ? Math.min(Math.max(56, Math.round(n)), max) : 91;
}

const key = (c: Combo, s: Scope, w: number) =>
  `${c.organism}|${c.antibiotic_code}|${c.specimen}|${s.scope_type}|${s.scope_value}|${w}`;

/** [n, x] for a combination, scope and window ending at week t (1-based). */
function at(c: Combo, s: Scope, w: number, t: number): [number, number] {
  const ser = load().series[key(c, s, w)];
  if (!ser || t < 1) return [0, 0];
  return [ser[0][t - 1] ?? 0, ser[1][t - 1] ?? 0];
}

function rate(n: number, x: number) {
  const ci = wilson(x, n);
  return { pct: pct(x, n), lo: ci?.[0] ?? null, hi: ci?.[1] ?? null };
}

function label(t: number): string {
  return load().ref.weeks[t - 1]?.label ?? `#${t}`;
}

function isIntrinsic(organism: string, code: string) {
  return load().ref.intrinsic.some((i) => i.organism === organism && i.antibiotic_code === code);
}

function testedCodes(organism: string, specimen: Specimen, scope: Scope): string[] {
  const prefix = `${organism}|`;
  const suffix = `|${specimen}|${scope.scope_type}|${scope.scope_value}|52`;
  const codes = new Set<string>();
  for (const k of Object.keys(load().series)) {
    if (k.startsWith(prefix) && k.endsWith(suffix)) codes.add(k.slice(prefix.length, k.length - suffix.length));
  }
  return [...codes];
}

const isPhenotype = (c: string) => (PHENOTYPE_CODES as readonly string[]).includes(c);

function abxName(code: string) {
  return load().ref.antibiotics.find((a) => a.antibiotic_code === code)?.antibiotic ?? code;
}

function episodes(): AlertDetail[] {
  const t = cursor();
  const { ref, firings } = load();
  const groups = new Map<string, AlertEvidence[][]>();
  for (const f of firings.filter((f) => f.week_idx <= t)) {
    const k = [f.type, f.organism, f.marker, f.specimen, f.scope.type, f.scope.value].join("|");
    const eps = groups.get(k) ?? [];
    const last = eps.at(-1);
    // A key that fires again within 2 weeks continues its episode; 2 silent weeks resolve it.
    if (last && f.week_idx - last.at(-1)!.week_idx <= 2) last.push(f);
    else eps.push([f]);
    groups.set(k, eps);
  }
  const out: AlertDetail[] = [];
  const short = (s: string) => {
    const [genus, species = ""] = s.split(" ");
    return (genus[0] + species).toUpperCase();
  };
  for (const eps of groups.values()) {
    for (const fs of eps) {
      const first = fs[0];
      const latest = fs.at(-1)!;
      const peak = fs.reduce((a, b) => (b.rank_score > a.rank_score ? b : a));
      const resolved = t - latest.week_idx >= 2;
      const escalated = !resolved && latest.severity_points + latest.rank_score > first.severity_points + first.rank_score;
      // Same id scheme as the feed and the engine: A-<opened week>-<scope>-<organism>-<specimen>-<marker>.
      const id = [
        "A",
        label(first.week_idx).replace("-", ""),
        first.scope.type === "hospital" ? "HOSP" : first.scope.value,
        short(first.organism),
        first.specimen.toUpperCase(),
        first.marker,
        ...(first.type === "rate" ? [] : [first.type.toUpperCase()]),
      ].join("-");
      const ev = resolved ? peak : latest;
      out.push({
        episode_id: id,
        alert_id: id,
        type: first.type,
        organism: first.organism,
        marker: first.marker,
        specimen: first.specimen,
        scope_type: first.scope.type,
        scope_value: first.scope.value,
        opened_week_idx: first.week_idx,
        last_fired_week_idx: latest.week_idx,
        status: resolved ? "resolved" : escalated ? "escalated" : "open",
        severity: ev.severity,
        severity_points: ev.severity_points,
        confidence: ev.confidence,
        rank: ev.rank_score,
        headline: alertHeadline(ev, ref.wards, abxName),
        n_firings: fs.length,
        evidence: ev,
        firings: fs.map((f) => ({
          week_idx: f.week_idx,
          week_label: label(f.week_idx),
          severity: f.severity,
          confidence: f.confidence,
        })),
      });
    }
  }
  // Same order as the inbox and the RSS feed: active first, then rank, then recency.
  return out.sort(
    (a, b) =>
      Number(a.status === "resolved") - Number(b.status === "resolved") ||
      b.rank - a.rank ||
      b.last_fired_week_idx - a.last_fired_week_idx,
  );
}

export const mockSource: DataSource = {
  kind: "mock",

  async replayStatus(): Promise<ReplayStatus> {
    const t = cursor();
    const w = load().ref.weeks[t - 1];
    const q = load().quality[t - 1];
    return {
      cursor_week_idx: t,
      cursor_label: w.label,
      week_start: w.week_start,
      last_run_at: null,
      run_status: "ok",
      run_url: null,
      isolates_this_week: q?.isolates ?? 0,
    };
  },

  async ref(): Promise<RefData> {
    const r = load().ref;
    return { ...r, organisms: r.organisms.map((o) => o.organism) };
  },

  async currentVsBaseline(combos, scope) {
    const t = cursor();
    return combos.map((c): CurrentVsBaseline => {
      let w = 4;
      let [n, x] = at(c, scope, 4, t);
      if (n < MIN_N) {
        const [n13, x13] = at(c, scope, 13, t);
        if (n13 > n) [w, n, x] = [13, n13, x13];
      }
      const [nb, xb] = at(c, scope, 52, t - w);
      const cur = rate(n, x);
      const base = rate(nb, xb);
      return {
        ...c,
        ...scope,
        cursor_week_idx: t,
        window_weeks: w,
        n_cur: n,
        x_cur: x,
        pct_cur: cur.pct,
        ci_cur_low: cur.lo,
        ci_cur_high: cur.hi,
        reportable_cur: n >= MIN_N,
        n_base: nb,
        x_base: xb,
        pct_base: base.pct,
        ci_base_low: base.lo,
        ci_base_high: base.hi,
        reportable_base: nb >= MIN_N,
        delta_pp: cur.pct != null && base.pct != null ? cur.pct - base.pct : null,
        ci_separated:
          cur.lo != null && base.lo != null && (cur.lo > (base.hi ?? 0) || (cur.hi ?? 0) < base.lo),
      };
    });
  },

  async rateSeries(combo, scope, windowWeeks) {
    const t = cursor();
    const rows: RateRow[] = [];
    for (let i = 1; i <= t; i++) {
      const [n, x] = at(combo, scope, windowWeeks, i);
      const r = rate(n, x);
      rows.push({
        ...combo,
        ...scope,
        end_week_idx: i,
        week_label: label(i),
        window_weeks: windowWeeks,
        n_tested: n,
        n_resistant: x,
        pct_r: r.pct,
        wilson_low: r.lo,
        wilson_high: r.hi,
        reportable: n >= MIN_N,
      });
    }
    return rows;
  },

  async antibiogram(specimen, scope) {
    const t = cursor();
    const rows: AntibiogramRow[] = [];
    for (const organism of load().ref.organisms.map((o) => o.organism)) {
      const codes = testedCodes(organism, specimen, scope).filter((c) => !isPhenotype(c));
      for (const code of codes) {
        const c = { organism, antibiotic_code: code, specimen };
        const [n4, x4] = at(c, scope, 4, t);
        const [n52, x52] = at(c, scope, 52, t);
        if (n52 === 0) continue;
        rows.push({
          ...c,
          ...scope,
          n_4w: n4,
          s_4w: n4 - x4,
          pct_s_4w: pct(n4 - x4, n4),
          n_52w: n52,
          s_52w: n52 - x52,
          pct_s_52w: pct(n52 - x52, n52),
          is_intrinsic: false,
        });
      }
      for (const i of load().ref.intrinsic.filter((i) => i.organism === organism)) {
        if (rows.some((r) => r.organism === organism)) {
          rows.push({
            organism,
            antibiotic_code: i.antibiotic_code,
            specimen,
            ...scope,
            n_4w: 0,
            s_4w: 0,
            pct_s_4w: null,
            n_52w: 0,
            s_52w: 0,
            pct_s_52w: null,
            is_intrinsic: true,
          });
        }
      }
    }
    return rows;
  },

  async heatmap(specimen, scope, windowWeeks) {
    const t = cursor();
    const cells: HeatmapCell[] = [];
    for (const organism of load().ref.organisms.map((o) => o.organism)) {
      for (const code of testedCodes(organism, specimen, scope)) {
        const c = { organism, antibiotic_code: code, specimen };
        const [n, x] = at(c, scope, windowWeeks, t);
        const r = rate(n, x);
        cells.push({
          ...c,
          ...scope,
          window_weeks: windowWeeks,
          n_tested: n,
          n_resistant: x,
          pct_r: r.pct,
          wilson_low: r.lo,
          wilson_high: r.hi,
          reportable: n >= MIN_N,
          is_intrinsic: false,
        });
      }
      for (const i of load().ref.intrinsic.filter((i) => i.organism === organism)) {
        cells.push({
          organism,
          antibiotic_code: i.antibiotic_code,
          specimen,
          ...scope,
          window_weeks: windowWeeks,
          n_tested: 0,
          n_resistant: 0,
          pct_r: null,
          wilson_low: null,
          wilson_high: null,
          reportable: false,
          is_intrinsic: isIntrinsic(organism, i.antibiotic_code),
        });
      }
    }
    return cells;
  },

  async wardComparison(combo, windowWeeks) {
    const t = cursor();
    const [hn, hx] = at(combo, { scope_type: "hospital", scope_value: "ALL" }, windowWeeks, t);
    const hospital = pct(hx, hn);
    return load().ref.wards.map((w): WardComparisonRow => {
      const [n, x] = at(combo, { scope_type: "ward", scope_value: w.ward_code }, windowWeeks, t);
      const r = rate(n, x);
      return {
        ...combo,
        window_weeks: windowWeeks,
        ward_code: w.ward_code,
        ward_name: w.ward_en,
        n_tested: n,
        n_resistant: x,
        pct_r: r.pct,
        wilson_low: r.lo,
        wilson_high: r.hi,
        reportable: n >= MIN_N,
        hospital_pct_r: hospital,
      };
    });
  },

  async alerts(): Promise<AlertEpisode[]> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    return episodes().map(({ evidence, firings, ...ep }) => ep);
  },

  async alertDetail(id) {
    return episodes().find((e) => e.episode_id === id || e.alert_id === id) ?? null;
  },

  async benchmarks() {
    // No benchmark data is mocked: national numbers must come from the real THL/ECDC loads.
    return [];
  },

  async dataQuality(limit) {
    const t = cursor();
    return load()
      .quality.filter((q) => q.week_idx <= t)
      .slice(-limit)
      .reverse()
      .map(
        (q): DataQualityRun => ({
          run_id: `mock-${q.label}`,
          week_idx: q.week_idx,
          week_label: q.label,
          run_at: null,
          run_url: null,
          duration_s: null,
          cultures_released: q.cultures,
          isolates_released: q.isolates,
          ast_released: q.ast_results,
          rows_rejected: q.rejected,
          intrinsic_excluded: q.intrinsic_flagged,
          non_reportable: q.non_reportable,
          checks: [
            {
              name: "Weekly volume vs trailing 8-week median",
              status: q.volume_vs_median == null ? "warn" : q.volume_vs_median < 0.5 ? "fail" : "pass",
              value: q.volume_vs_median,
              detail: "Fails below 50% of the trailing median",
            },
            {
              name: "Every isolate has susceptibility rows",
              status: q.isolates_without_ast === 0 ? "pass" : "warn",
              value: q.isolates_without_ast,
              detail: "Isolates released without any AST result",
            },
            {
              name: "Every result is S or R",
              status: q.invalid_results === 0 ? "pass" : "fail",
              value: q.invalid_results,
              detail: "Results outside {S, R}",
            },
            { name: "No future sample dates", status: "pass", value: 0, detail: "Sample dates after the run date" },
          ],
          dedup_52w: q.dedup_52w,
        }),
      );
  },
};
