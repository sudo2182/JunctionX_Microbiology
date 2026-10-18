/**
 * Space-time scan statistics after Kulldorff (SaTScan):
 *  - "stp": space-time permutation model (cases only, Kulldorff 2005)
 *  - "bernoulli": cases (e.g. resistant) vs controls (susceptible)
 * Cylinders = zone (location set) x contiguous week window. Significance by Monte Carlo.
 */
export type ScanModel = "stp" | "bernoulli";

export type ScanInput = {
  locations: string[];
  zones: number[][]; // each zone = list of location indices
  weeks: number; // T
  cases: number[][]; // [loc][t]
  totals?: number[][]; // bernoulli: population per cell
  model: ScanModel;
  maxWindow: number;
  prospective: boolean; // windows must end at last week
  replications: number;
  seed?: number;
  maxClusters?: number;
  includeOverlapping?: boolean;
};

export type Cluster = {
  zone: string[];
  start: number;
  end: number;
  observed: number;
  expected: number;
  rr: number;
  llr: number;
  p: number;
};

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const xlogx = (x: number) => (x > 0 ? x * Math.log(x) : 0);

type Cand = { z: number; a: number; b: number; c: number; e: number; llr: number };

function scanAll(inp: ScanInput, cases: number[][], keepAll: boolean): { max: number; cands: Cand[] } {
  const { zones, weeks: T, model, maxWindow, prospective } = inp;
  const L = cases.length;
  const cum = cases.map((row) => {
    const c = new Float64Array(T + 1);
    for (let t = 0; t < T; t++) c[t + 1] = c[t] + row[t];
    return c;
  });
  const locTot = cum.map((c) => c[T]);
  const timeCum = new Float64Array(T + 1);
  for (let t = 0; t < T; t++) {
    let s = 0;
    for (let l = 0; l < L; l++) s += cases[l][t];
    timeCum[t + 1] = timeCum[t] + s;
  }
  const C = timeCum[T];
  let popCum: Float64Array[] = [];
  let N = 0;
  if (model === "bernoulli" && inp.totals) {
    popCum = inp.totals.map((row) => {
      const c = new Float64Array(T + 1);
      for (let t = 0; t < T; t++) c[t + 1] = c[t] + row[t];
      return c;
    });
    N = popCum.reduce((s, c) => s + c[T], 0);
  }
  const cands: Cand[] = [];
  let max = 0;
  if (C === 0) return { max, cands };
  const base = model === "bernoulli" ? xlogx(C) + xlogx(N - C) - xlogx(N) : 0;
  for (let z = 0; z < zones.length; z++) {
    const zone = zones[z];
    const zTot = zone.reduce((s, l) => s + locTot[l], 0);
    for (let b = T - 1; b >= 0; b--) {
      if (prospective && b !== T - 1) break;
      for (let a = b; a >= Math.max(0, b - maxWindow + 1); a--) {
        let c = 0;
        let n = 0;
        for (const l of zone) {
          c += cum[l][b + 1] - cum[l][a];
          if (model === "bernoulli") n += popCum[l][b + 1] - popCum[l][a];
        }
        let e: number;
        let llr = 0;
        if (model === "stp") {
          e = (zTot * (timeCum[b + 1] - timeCum[a])) / C;
          if (c > e && c > 0) llr = c * Math.log(c / e) + (C - c > 0 ? (C - c) * Math.log((C - c) / (C - e)) : 0);
        } else {
          e = N > 0 ? (n * C) / N : 0;
          if (n > 0 && n < N && c / n > (C - c) / (N - n)) {
            llr = xlogx(c) + xlogx(n - c) - xlogx(n) + xlogx(C - c) + xlogx(N - n - (C - c)) - xlogx(N - n) - base;
          }
        }
        if (llr > max) max = llr;
        if (keepAll && llr > 0) cands.push({ z, a, b, c, e, llr });
      }
    }
  }
  return { max, cands };
}

export function runScan(inp: ScanInput): Cluster[] {
  const { cases, weeks: T, replications } = inp;
  const real = scanAll(inp, cases, true);
  const rand = rng(inp.seed ?? 12345);
  const maxes: number[] = [];
  const L = cases.length;

  if (inp.model === "stp") {
    // flatten cases into (loc, t) pairs, shuffle times
    const locs: number[] = [];
    const times: number[] = [];
    for (let l = 0; l < L; l++) for (let t = 0; t < T; t++) for (let k = 0; k < cases[l][t]; k++) (locs.push(l), times.push(t));
    for (let r = 0; r < replications; r++) {
      for (let i = times.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [times[i], times[j]] = [times[j], times[i]];
      }
      const sim = Array.from({ length: L }, () => new Array(T).fill(0));
      for (let i = 0; i < locs.length; i++) sim[locs[i]][times[i]]++;
      maxes.push(scanAll(inp, sim, false).max);
    }
  } else {
    const totals = inp.totals;
    if (!totals) throw new Error("Bernoulli scans require population totals.");
    const cells: number[] = [];
    let C = 0;
    for (let l = 0; l < L; l++)
      for (let t = 0; t < T; t++) {
        C += cases[l][t];
        for (let k = 0; k < totals[l][t]; k++) cells.push(l * T + t);
      }
    for (let r = 0; r < replications; r++) {
      const sim = Array.from({ length: L }, () => new Array(T).fill(0));
      // partial Fisher-Yates: pick C individuals as cases
      for (let i = 0; i < C; i++) {
        const j = i + Math.floor(rand() * (cells.length - i));
        [cells[i], cells[j]] = [cells[j], cells[i]];
        const cell = cells[i];
        sim[Math.floor(cell / T)][cell % T]++;
      }
      maxes.push(scanAll(inp, sim, false).max);
    }
  }

  // most likely cluster + non-overlapping secondary clusters (no shared locations)
  const sorted = real.cands.sort((x, y) => y.llr - x.llr);
  const used = new Set<number>();
  const out: Cluster[] = [];
  for (const c of sorted) {
    const zone = inp.zones[c.z];
    if (!inp.includeOverlapping && zone.some((l) => used.has(l))) continue;
    zone.forEach((l) => used.add(l));
    const rank = maxes.filter((m) => m >= c.llr).length;
    out.push({
      zone: zone.map((l) => inp.locations[l]),
      start: c.a,
      end: c.b,
      observed: c.c,
      expected: c.e,
      rr: c.e > 0 ? c.c / c.e : Infinity,
      llr: c.llr,
      p: (rank + 1) / (replications + 1),
    });
    if (out.length >= (inp.maxClusters ?? 5)) break;
  }
  return out;
}

export function singleZones(n: number) {
  return Array.from({ length: n }, (_, i) => [i]);
}
export function neighbourZones(locations: string[], neighbours: Record<string, string[]>) {
  const zones: number[][] = singleZones(locations.length);
  const seen = new Set<string>();
  locations.forEach((loc, i) => {
    for (const nb of neighbours[loc] ?? []) {
      const j = locations.indexOf(nb);
      if (j < 0) continue;
      const k = [i, j].sort().join(",");
      if (!seen.has(k)) (seen.add(k), zones.push([i, j].sort()));
    }
  });
  return zones;
}
