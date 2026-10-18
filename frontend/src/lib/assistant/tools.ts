import { ANTIBIOTICS, MARKERS, ORGANISMS, SPECIMENS, WARDS, weekIndex, weekStart } from "@/lib/amr/reference";
import { antibioticApplicability, commonAntibiotics, GUIDELINE_URL } from "@/lib/amr/applicability";
import { firstIsolates, MIN_ISOLATES } from "@/lib/amr/stats";
import { markerRates, wardOverview } from "@/lib/amr/occupancy";
import { clusterScan, wardMatrix, wardTrend, wilson } from "@/lib/amr/surveillance";
import { feedEntries, sourceInfo } from "@/lib/amr/alert-sources";
import { latestSampleDate, maxWeek, type Alert, type IsolateRecord, type StayRecord } from "@/lib/amr/store";
import type { Announcement } from "@/lib/amr/announcements";
import { searchKnowledge } from "./knowledge";

/**
 * Executes the assistant's tool calls in the browser, on the data the dashboard has already loaded and with
 * the same functions the pages use, so the assistant's numbers match what users see on screen.
 */

export type ToolContext = {
  records: IsolateRecord[];
  stays: StayRecord[];
  alerts: Alert[];
  announcements: () => Promise<Announcement[]>;
};

export type Evidence = { label: string; href: string };
export type ToolOutput = { result: Record<string, unknown>; evidence?: Evidence };

class ToolInputError extends Error {}

type Args = Record<string, unknown>;
const str = (a: Args, k: string) => (typeof a[k] === "string" && (a[k] as string).trim() ? (a[k] as string).trim() : undefined);
const num = (a: Args, k: string) => {
  const v = typeof a[k] === "string" ? Number(a[k]) : a[k];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};
const bool = (a: Args, k: string) => a[k] === true || a[k] === "true";
const round1 = (v: number | null | undefined) => (v == null ? null : Math.round(v * 10) / 10);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Maps what the user typed ("E. coli", "klebsiella", "all") to an organism in the data. */
export function resolveOrganism(input: string | undefined, allowAll = true): string {
  if (!input || (allowAll && ["all", "any", "all organisms"].includes(norm(input)))) {
    if (allowAll) return "all";
    throw new ToolInputError("An organism is required.");
  }
  const q = norm(input);
  const exact = ORGANISMS.find((o) => norm(o) === q);
  if (exact) return exact;
  const abbreviated = ORGANISMS.find((o) => {
    const [genus, species = ""] = norm(o).split(" ");
    return q === `${genus[0]} ${species}` || q === `${genus[0]}${species}` || q === species;
  });
  if (abbreviated) return abbreviated;
  const partial = ORGANISMS.filter((o) => norm(o).includes(q));
  if (partial.length === 1) return partial[0];
  throw new ToolInputError(
    partial.length > 1
      ? `"${input}" matches several organisms: ${partial.join(", ")}. Ask which one.`
      : `Unknown organism "${input}". Known organisms: ${ORGANISMS.join(", ")}.`,
  );
}

export function resolveAntibiotic(input: string | undefined): string {
  if (!input) throw new ToolInputError("An antibiotic is required.");
  const q = norm(input);
  const hit = ANTIBIOTICS.find((a) => norm(a.code) === q || norm(a.name) === q) ?? ANTIBIOTICS.filter((a) => norm(a.name).includes(q)).at(0);
  if (!hit) throw new ToolInputError(`Unknown antibiotic "${input}". Known: ${ANTIBIOTICS.map((a) => `${a.name} (${a.code})`).join(", ")}.`);
  return hit.code;
}

export function resolveWard(input: string | undefined): string {
  if (!input || ["all", "hospital", "all wards", "total", "everywhere"].includes(norm(input))) return "all";
  const q = norm(input);
  const hit = WARDS.find((w) => norm(w.code) === q || norm(w.name) === q) ?? WARDS.filter((w) => norm(w.name).includes(q)).at(0);
  if (!hit) throw new ToolInputError(`Unknown ward "${input}". Known: ${WARDS.map((w) => `${w.name} (${w.code})`).join(", ")}.`);
  return hit.code;
}

const snap = (v: number | undefined, allowed: number[], fallback: number) =>
  v == null ? fallback : allowed.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), allowed[0]);

function date(a: Args, k: string): string | undefined {
  const v = str(a, k);
  if (v === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(`${v}T00:00:00Z`))) throw new ToolInputError(`${k} must be a date YYYY-MM-DD.`);
  return v;
}

const latestDate = latestSampleDate;
const wardName = (code: string) => (code === "all" ? "All locations" : WARDS.find((w) => w.code === code)?.name ?? code);
const abxName = (code: string) => ANTIBIOTICS.find((a) => a.code === code)?.name ?? code;

function rateFields(c: { n: number; r: number; pct: number | null; reportable: boolean }) {
  const ci = wilson(c.r, c.n);
  return {
    tested: c.n,
    resistant: c.r,
    percent_resistant: c.reportable ? round1(c.pct) : null,
    ci95_percent: c.reportable && ci ? { low: round1(ci.low), high: round1(ci.high) } : null,
    reportable: c.reportable,
    ...(c.reportable ? {} : { note: `Too few tested first isolates (n=${c.n}; minimum ${MIN_ISOLATES}) for a reliable percentage.` }),
  };
}

function windowOf(records: IsolateRecord[], a: Args) {
  const last = maxWeek(records);
  const d = date(a, "end_date");
  const endWeek = d ? Math.max(0, Math.min(last, weekIndex(d))) : last;
  const windowWeeks = snap(num(a, "window_weeks"), [1, 4, 13, 52], 4);
  return { endWeek, windowWeeks, from: weekStart(Math.max(0, endWeek - windowWeeks + 1)), to: weekStart(endWeek) };
}

const TOOLS: Record<string, (a: Args, ctx: ToolContext) => Promise<ToolOutput> | ToolOutput> = {
  data_overview: (_a, { records, alerts }) => {
    const dates = records.map((r) => r.date).sort();
    const last = maxWeek(records);
    return {
      result: {
        notice: "Synthetic TYKS hospital microbiology data, released by a weekly replay. Not real patients.",
        isolates_total: records.length,
        isolates_added_from_dashboard_pending: records.filter((r) => r.pending).length,
        patients: new Set(records.map((r) => r.patient)).size,
        first_sample_date: dates[0] ?? null,
        last_sample_date: dates.at(-1) ?? null,
        latest_reporting_week_starts: weekStart(last),
        weeks_of_data: last + 1,
        wards: WARDS.map((w) => ({ code: w.code, name: w.name, setting: w.type === "in" ? "inpatient" : "outpatient" })),
        organisms: ORGANISMS,
        antibiotics: ANTIBIOTICS.map((x) => ({ code: x.code, name: x.name, class: x.cls })),
        specimens: SPECIMENS,
        markers: MARKERS.map((m) => m.label),
        alerts_in_feed: alerts.length,
        minimum_isolates_for_percentage: MIN_ISOLATES,
      },
      evidence: { label: "Records", href: "/records" },
    };
  },

  resistance_rate: (a, { records }) => {
    const organism = resolveOrganism(str(a, "organism"));
    const code = resolveAntibiotic(str(a, "antibiotic"));
    const ward = resolveWard(str(a, "ward"));
    const w = windowOf(records, a);
    const uti = bool(a, "uncomplicated_uti");
    const rows = wardMatrix(records, { organism, endWeek: w.endWeek, windowWeeks: w.windowWeeks, uncomplicatedUTI: uti });
    const row = rows.find((r) => r.ward.code === (ward === "all" ? "TOTAL" : ward))!;
    const cell = row.cells.find((c) => c.code === code)!;
    return {
      result: {
        organism, antibiotic: `${abxName(code)} (${code})`, ward: wardName(ward),
        period: { from_week_starting: w.from, to_week_starting: w.to, window_weeks: w.windowWeeks },
        uncomplicated_uti_context: uti,
        first_isolates_in_scope: row.n,
        ...rateFields(cell),
        eucast_status: cell.status,
        ...(cell.status === "applicable" ? {} : { why_not_calculated: cell.reason }),
        confidence_level_percent: 95,
        minimum_isolates: MIN_ISOLATES,
      },
      evidence: { label: `Ward resistance · ${ward === "all" ? "Total" : ward} · week of ${w.to}`, href: `/wards?${ward === "all" ? "" : `ward=${ward}&`}date=${w.to}` },
    };
  },

  compare_wards: (a, { records }) => {
    const organism = resolveOrganism(str(a, "organism"));
    const code = resolveAntibiotic(str(a, "antibiotic"));
    const w = windowOf(records, a);
    const uti = bool(a, "uncomplicated_uti");
    const rows = wardMatrix(records, { organism, endWeek: w.endWeek, windowWeeks: w.windowWeeks, uncomplicatedUTI: uti });
    const status = rows[0].cells.find((c) => c.code === code)!;
    return {
      result: {
        organism, antibiotic: `${abxName(code)} (${code})`,
        period: { from_week_starting: w.from, to_week_starting: w.to, window_weeks: w.windowWeeks },
        eucast_status: status.status,
        ...(status.status === "applicable" ? {} : { why_not_calculated: status.reason }),
        wards: rows.map((r) => ({ ward: r.ward.name, code: r.ward.code, first_isolates: r.n, ...rateFields(r.cells.find((c) => c.code === code)!) })),
        confidence_level_percent: 95,
        minimum_isolates: MIN_ISOLATES,
      },
      evidence: { label: `Ward resistance · week of ${w.to}`, href: `/wards?date=${w.to}` },
    };
  },

  resistance_trend: (a, { records }) => {
    const organism = resolveOrganism(str(a, "organism"));
    const code = resolveAntibiotic(str(a, "antibiotic"));
    const ward = resolveWard(str(a, "ward"));
    const windowWeeks = snap(num(a, "window_weeks"), [1, 4, 13, 52], 4);
    const uti = bool(a, "uncomplicated_uti");
    const span = Math.max(4, Math.min(104, Math.round(num(a, "last_n_weeks") ?? 26)));
    const last = maxWeek(records);
    const step = Math.ceil(span / 26); // at most ~26 points back to the model
    let points: { week: string; tested: number; resistant: number; percent_resistant: number | null }[];
    if (ward === "all") {
      points = [];
      for (let t = last - span + 1; t <= last; t += step) {
        if (t < windowWeeks - 1) continue;
        const total = wardMatrix(records, { organism, endWeek: t, windowWeeks, uncomplicatedUTI: uti }).at(-1)!;
        const c = total.cells.find((x) => x.code === code)!;
        points.push({ week: weekStart(t), tested: c.n, resistant: c.r, percent_resistant: c.reportable ? round1(c.pct) : null });
      }
    } else {
      points = wardTrend(records, { organism, antibiotic: code, windowWeeks, uncomplicatedUTI: uti, lastWeek: last, maxPoints: span })
        .filter((_, i, all) => (all.length - 1 - i) % step === 0)
        .map((p) => ({ week: p.week, tested: p.byWard[ward].n, resistant: p.byWard[ward].r, percent_resistant: p.byWard[ward].pct }));
    }
    const reportable = points.filter((p) => p.percent_resistant != null);
    const first = reportable[0];
    const lastP = reportable.at(-1);
    const values = reportable.map((p) => p.percent_resistant as number);
    return {
      result: {
        organism, antibiotic: `${abxName(code)} (${code})`, ward: wardName(ward), window_weeks: windowWeeks, uncomplicated_uti_context: uti,
        points,
        summary: reportable.length
          ? {
              first_reportable: first, last_reportable: lastP,
              change_percentage_points: round1((lastP!.percent_resistant as number) - (first!.percent_resistant as number)),
              lowest_percent: Math.min(...values), highest_percent: Math.max(...values),
              reportable_points: reportable.length, total_points: points.length,
            }
          : { note: `No week had at least ${MIN_ISOLATES} tested first isolates, so no percentages can be reported.` },
        minimum_isolates: MIN_ISOLATES,
      },
      evidence: { label: `Ward resistance trend${ward === "all" ? "" : ` · ${ward}`}`, href: `/wards${ward === "all" ? "" : `?ward=${ward}`}` },
    };
  },

  marker_rates: (a, { records }) => {
    const ward = resolveWard(str(a, "ward"));
    const organism = resolveOrganism(str(a, "organism"));
    const to = date(a, "to_date") ?? latestDate(records);
    const from = date(a, "from_date") ?? isoMinusDays(to, 27);
    const set = records.filter((r) => (ward === "all" || r.ward === ward) && (organism === "all" || r.organism === organism) && r.date >= from && r.date <= to);
    return {
      result: {
        ward: wardName(ward), organism, from, to,
        markers: markerRates(set).map((m) => ({ marker: m.label, positive_first_isolates: m.positive, first_isolates: m.n, percent: round1(m.pct), reportable: m.n >= MIN_ISOLATES })),
        minimum_isolates: MIN_ISOLATES,
      },
      evidence: { label: "Hospital atlas", href: "/" },
    };
  },

  ward_snapshot: (a, { records, stays }) => {
    const ward = resolveWard(str(a, "ward"));
    const asOf = date(a, "as_of") ?? latestDate(records);
    const rows = wardOverview(stays, records, asOf).filter((w) => ward === "all" || w.code === ward);
    return {
      result: {
        as_of: asOf,
        caveat: "Occupancy is estimated from culture episodes (no admission register): stays are assumed to last 3 days (ED, surgery), 14 days (other wards) or 6 months (health centres).",
        wards: rows.map((w) => ({
          ward: w.name, code: w.code,
          estimated_patients: w.occupancy,
          marker_positive_patients: w.patients,
          by_marker: w.markers.filter((m) => m.patients > 0).map((m) => ({ marker: m.label, patients: m.patients })),
          organisms: w.organisms.slice(0, 6).map((o) => ({ organism: o.organism, patients: o.patients })),
          marker_rates_last_28_days: w.rates.map((m) => ({ marker: m.label, positive: m.positive, first_isolates: m.n, percent: round1(m.pct) })),
        })),
      },
      evidence: { label: `Hospital atlas · ${asOf}`, href: "/" },
    };
  },

  count_isolates: (a, { records }) => {
    const ward = resolveWard(str(a, "ward"));
    const organism = resolveOrganism(str(a, "organism"));
    const specimen = str(a, "specimen");
    if (specimen && !(SPECIMENS as readonly string[]).includes(specimen)) throw new ToolInputError(`specimen must be one of ${SPECIMENS.join(", ")}.`);
    const from = date(a, "from_date");
    const to = date(a, "to_date");
    let set = records.filter((r) => (ward === "all" || r.ward === ward) && (organism === "all" || r.organism === organism) && (!specimen || r.specimen === specimen) && (!from || r.date >= from) && (!to || r.date <= to));
    const firstOnly = bool(a, "first_isolates_only");
    if (firstOnly) set = firstIsolates(set);
    const group = str(a, "group_by");
    const keyOf: Record<string, (r: IsolateRecord) => string[]> = {
      ward: (r) => [r.ward], organism: (r) => [r.organism], specimen: (r) => [r.specimen], month: (r) => [r.date.slice(0, 7)],
      onset: (r) => [r.onset || "unknown"], marker: (r) => { const m = MARKERS.filter((x) => (r.flags & x.bit) !== 0).map((x) => x.label); return m.length ? m : ["none"]; },
    };
    let groups: { group: string; isolates: number }[] | undefined;
    if (group) {
      if (!keyOf[group]) throw new ToolInputError(`group_by must be one of ${Object.keys(keyOf).join(", ")}.`);
      const counts = new Map<string, number>();
      for (const r of set) for (const k of keyOf[group](r)) counts.set(k, (counts.get(k) ?? 0) + 1);
      groups = [...counts].map(([g, n]) => ({ group: group === "ward" ? `${wardName(g)} (${g})` : g, isolates: n })).sort((x, y) => (group === "month" ? x.group.localeCompare(y.group) : y.isolates - x.isolates)).slice(0, 40);
    }
    return {
      result: { ward: wardName(ward), organism, specimen: specimen ?? "all", from: from ?? "start of data", to: to ?? "end of data", first_isolates_only: firstOnly, isolates: set.length, ...(groups ? { group_by: group, groups } : {}) },
      evidence: { label: "Records", href: "/records" },
    };
  },

  cluster_scan: (a, { records }) => {
    const organism = resolveOrganism(str(a, "organism"));
    const rawCase = str(a, "case_definition") ?? "esbl";
    const caseDefinition = rawCase === "all" || MARKERS.some((m) => m.key === rawCase.toLowerCase()) ? rawCase.toLowerCase() : `abx:${resolveAntibiotic(rawCase)}`;
    if (caseDefinition.startsWith("abx:") && !commonAntibiotics(organism === "all" ? ORGANISMS : [organism]).some((x) => `abx:${x.code}` === caseDefinition))
      throw new ToolInputError(`${abxName(caseDefinition.slice(4))} is not a supported case definition for ${organism === "all" ? "all organisms" : organism}; use a marker or a supported antibiotic.`);
    const model = str(a, "model") === "bernoulli" ? "bernoulli" : "stp";
    const studyWeeks = snap(num(a, "study_weeks"), [26, 52, 104, 156], 52);
    const maxWindow = snap(num(a, "max_cluster_weeks"), [2, 4, 8, 13], 4);
    const prospective = str(a, "scan_type") !== "retrospective";
    const last = maxWeek(records);
    const out = clusterScan(records, { model, organism, caseDefinition, studyWeeks, maxWindow, prospective, replications: 199, maxClusters: 20, includeOverlapping: true, lastWeek: last });
    return {
      result: {
        settings: { model, organism, case_definition: caseDefinition, study_period: `${weekStart(out.start)} to ${weekStart(last)}`, study_weeks: studyWeeks, max_cluster_weeks: maxWindow, scan_type: prospective ? "prospective" : "retrospective", monte_carlo_replications: 199 },
        cases_in_study_period: out.cases,
        clusters: out.clusters.slice(0, 10).map((c, i) => ({
          rank: i + 1, wards: c.zone.map(wardName), from_week_starting: weekStart(out.start + c.start), to_week_starting: weekStart(out.start + c.end),
          observed: c.observed, expected: round1(c.expected), relative_risk: Math.round(c.rr * 100) / 100, log_likelihood_ratio: Math.round(c.llr * 100) / 100,
          p_value: Math.round(c.p * 1000) / 1000, significant_at_0_05: c.p < 0.05,
        })),
        interpretation: "A significant cluster is a statistical signal for infection-control review, not a confirmed outbreak.",
      },
      evidence: { label: "Cluster detection (choose the same settings and press Run scan)", href: "/detection" },
    };
  },

  list_alerts: async (a, ctx) => {
    const source = str(a, "source") ?? "all";
    const limit = Math.max(1, Math.min(20, Math.round(num(a, "limit") ?? 10)));
    const announcements = source === "local" ? [] : await ctx.announcements().catch(() => []);
    const entries = feedEntries(source === "ecdc" ? [] : ctx.alerts, announcements, new Set(ctx.records.map((r) => r.id)));
    return {
      result: {
        total_matching: entries.length,
        entries: entries.slice(0, limit).map((e) => ({
          date: e.date || null, source: sourceInfo(e.source).label, title: e.title, severity: e.severity ?? null, ecdc_category: e.category ?? null,
          organism: e.organism ?? null, region: e.region ?? null, summary: e.summary.slice(0, 300),
          link: e.trace.kind === "external" ? e.trace.href : null,
        })),
        note: "ECDC items are real European news; local alerts concern the synthetic dashboard data.",
      },
      evidence: { label: "Alerts feed (Hospital atlas page)", href: "/" },
    };
  },

  antibiotic_guidance: (a) => {
    const organism = resolveOrganism(str(a, "organism"), false);
    const one = str(a, "antibiotic");
    const codes = one ? [resolveAntibiotic(one)] : ANTIBIOTICS.map((x) => x.code);
    const uti = bool(a, "uncomplicated_uti");
    const available = new Set(commonAntibiotics([organism], uti).map((x) => x.code));
    return {
      result: {
        organism, uncomplicated_uti_context: uti,
        antibiotics: codes.map((c) => {
          const app = antibioticApplicability(organism, c);
          return { antibiotic: `${abxName(c)} (${c})`, status: app.status, percentage_shown_on_dashboard: available.has(c), reason: app.reason };
        }),
        disclaimer: "Surveillance applicability from a conservative EUCAST subset; not prescribing advice.",
        guideline: GUIDELINE_URL,
      },
      evidence: { label: "Ward resistance (guidance panel)", href: "/wards" },
    };
  },

  search_methods: (a) => {
    const query = str(a, "query");
    if (!query) throw new ToolInputError("query is required.");
    const hits = searchKnowledge(query);
    return {
      result: hits.length
        ? { sections: hits.map((s) => ({ title: s.title, text: s.text, implemented_in: s.implementedIn ?? null, sources: s.sources })) }
        : { sections: [], note: "No methods section matches; say that this is not documented rather than guessing." },
    };
  },
};

function isoMinusDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Runs one tool call. Bad input comes back as a structured error the model can correct or relay. */
export async function runTool(name: string, args: Args | undefined, ctx: ToolContext): Promise<ToolOutput> {
  const tool = TOOLS[name];
  if (!tool) return { result: { error: `Unknown tool ${name}.` } };
  if (!ctx.records.length) return { result: { error: "The dashboard data has not loaded yet." } };
  try {
    return await tool(args ?? {}, ctx);
  } catch (e) {
    if (e instanceof ToolInputError) return { result: { error: e.message } };
    return { result: { error: `The calculation failed: ${e instanceof Error ? e.message : String(e)}` } };
  }
}
