import { ANTIBIOTICS, MARKERS, ORGANISMS, WARDS, weekStart } from "./reference";
import { antibioticApplicability, applicableResult, commonAntibiotics } from "./applicability";
import { firstIsolates, MIN_ISOLATES, resistance } from "./stats";
import { runScan, singleZones, type Cluster, type ScanModel } from "./satscan";
import { abxResult, type IsolateRecord } from "./store";

/**
 * Calculations shared by the dashboard pages and the assistant, so both always report the same numbers.
 */

export type CellStatus = "applicable" | "expected-resistant" | "screen" | "urinary" | "review" | "unsupported";

export type WardMatrixOptions = { organism: string; endWeek: number; windowWeeks: number; uncomplicatedUTI: boolean };

export type WardMatrixRow = {
  ward: { code: string; name: string; type: string };
  n: number; // first isolates in the window
  cells: (ReturnType<typeof resistance> & { code: string; status: CellStatus; reason: string })[];
};

/** The "% resistant" table of the Ward resistance page: one row per ward plus a total row. */
export function wardMatrix(records: IsolateRecord[], o: WardMatrixOptions): WardMatrixRow[] {
  const organisms = o.organism === "all" ? ORGANISMS : [o.organism];
  const available = commonAntibiotics(organisms, o.uncomplicatedUTI);
  const pool = records.filter((r) => o.organism === "all" || r.organism === o.organism);
  const inWin = pool.filter((r) => r.week <= o.endWeek && r.week > o.endWeek - o.windowWeeks);
  const set = firstIsolates(inWin);
  const groups = [
    ...WARDS.map((w) => ({ ward: w as { code: string; name: string; type: string }, rs: set.filter((r) => r.ward === w.code) })),
    { ward: { code: "TOTAL", name: "Total · all wards", type: "total" }, rs: set },
  ];
  return groups.map(({ ward, rs }) => ({
    ward,
    n: rs.length,
    cells: ANTIBIOTICS.map((a) => {
      const rules = organisms.map((org) => antibioticApplicability(org, a.code));
      const valid = available.some((x) => x.code === a.code);
      const reason = organisms.map((org, i) => `${org}: ${rules[i].reason}`).join("\n");
      const status: CellStatus = valid
        ? "applicable"
        : rules.every((r) => r.status === "expected-resistant") ? "expected-resistant"
        : rules.every((r) => r.status === "screen") ? "screen"
        : rules.some((r) => r.status === "urinary") && !o.uncomplicatedUTI ? "urinary"
        : rules.some((r) => r.status === "review") ? "review"
        : "unsupported";
      return {
        ...resistance(valid ? rs.filter((r) => applicableResult(r.organism, a.code, r.specimen, o.uncomplicatedUTI)) : [], a.code),
        code: a.code,
        status,
        reason,
      };
    }),
  }));
}

export type TrendPoint = { week: string; weekIndex: number; byWard: Record<string, { n: number; r: number; pct: number | null }> };

/** The trend chart of the Ward resistance page: rolling-window % resistant per ward for each week. */
export function wardTrend(
  records: IsolateRecord[],
  o: { organism: string; antibiotic: string; windowWeeks: number; uncomplicatedUTI: boolean; lastWeek: number; maxPoints?: number },
): TrendPoint[] {
  const pool = records.filter((r) => o.organism === "all" || r.organism === o.organism);
  const points: TrendPoint[] = [];
  for (let t = Math.max(o.windowWeeks - 1, o.lastWeek - ((o.maxPoints ?? 104) - 1)); t <= o.lastWeek; t++) {
    const set = firstIsolates(pool.filter((r) => r.week <= t && r.week > t - o.windowWeeks));
    const byWard: TrendPoint["byWard"] = {};
    for (const w of WARDS) {
      const res = resistance(set.filter((r) => r.ward === w.code && applicableResult(r.organism, o.antibiotic, r.specimen, o.uncomplicatedUTI)), o.antibiotic);
      byWard[w.code] = { n: res.n, r: res.r, pct: res.n >= MIN_ISOLATES && res.pct != null ? +res.pct.toFixed(1) : null };
    }
    points.push({ week: weekStart(t), weekIndex: t, byWard });
  }
  return points;
}

export type ClusterScanOptions = {
  model: ScanModel;
  organism: string; // "all" or an organism name
  caseDefinition: string; // "all", a marker key (esbl, mrsa, vre, cpe) or "abx:<code>"
  studyWeeks: number;
  maxWindow: number;
  prospective: boolean;
  replications: number;
  maxClusters: number;
  includeOverlapping: boolean;
  lastWeek: number;
};

/** The Cluster detection page's SaTScan-style scan. Deterministic: the Monte Carlo generator is seeded. */
export function clusterScan(records: IsolateRecord[], o: ClusterScanOptions): { clusters: Cluster[]; cases: number; start: number; locations: string[] } {
  const T = o.studyWeeks;
  const start = o.lastWeek - T + 1;
  const locations: string[] = WARDS.map((w) => w.code);
  const zones = singleZones(locations.length);
  const marker = MARKERS.find((m) => m.key === o.caseDefinition);
  const code = o.caseDefinition.startsWith("abx:") ? o.caseDefinition.slice(4) : null;
  const isCase = (r: IsolateRecord) => (marker ? (r.flags & marker.bit) > 0 : code ? abxResult(r, code) === "R" : true);
  const inPop = (r: IsolateRecord) => (code ? applicableResult(r.organism, code, r.specimen, false) && abxResult(r, code) !== "-" : true);
  const cases = locations.map(() => new Array<number>(T).fill(0));
  const totals = locations.map(() => new Array<number>(T).fill(0));
  let nCases = 0;
  for (const r of records) {
    if (r.week < start || r.week > o.lastWeek) continue;
    if (o.organism !== "all" && r.organism !== o.organism) continue;
    const l = locations.indexOf(r.ward);
    if (l < 0 || !inPop(r)) continue;
    totals[l][r.week - start]++;
    if (isCase(r)) {
      cases[l][r.week - start]++;
      nCases++;
    }
  }
  const clusters = runScan({
    locations, zones, weeks: T, cases, totals, model: o.model, maxWindow: o.maxWindow, prospective: o.prospective,
    replications: o.replications, maxClusters: o.maxClusters, includeOverlapping: o.includeOverlapping,
  });
  return { clusters, cases: nCases, start, locations };
}

/** Wilson score 95% interval for r resistant out of n tested, in percent. */
export function wilson(r: number, n: number, z = 1.96): { low: number; high: number } | null {
  if (n <= 0) return null;
  const p = r / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half) * 100, high: Math.min(1, centre + half) * 100 };
}
