import { ANTIBIOTICS, MARKERS, ORGANISMS, WARDS, weekStart } from "@/lib/amr/reference";
import { commonAntibiotics } from "@/lib/amr/applicability";
import { firstIsolates, MIN_ISOLATES } from "@/lib/amr/stats";
import { clusterScan, spatialByWard, spatialSeries, wardMatrix, wardTrend, wilson, type ClusterScanOptions } from "@/lib/amr/surveillance";
import type { wardOverview } from "@/lib/amr/occupancy";
import { latestSampleDate, type IsolateRecord } from "@/lib/amr/store";
import type { FeedEntry } from "@/lib/amr/alert-sources";
import { sourceInfo } from "@/lib/amr/alert-sources";
import type { Announcement } from "@/lib/amr/announcements";
import type { CultureRequest } from "@/lib/amr/cultures";
import { COUNTRY, REGION, SPECIMEN_LABEL, finresSeries, freshness, incidenceSeries, notificationShare, yearRange, type ExternalData } from "@/lib/amr/external";
import type { ReportDoc, Section, Source, Table } from "./report";

/**
 * One builder per dashboard page. Each takes the page's current data and filter settings and returns a report whose
 * numbers come from the same functions the page draws with. Key facts are written by code, not by a language model.
 */

const wardName = (code: string) => WARDS.find((w) => w.code === code)?.name ?? code;
const abxName = (code: string) => ANTIBIOTICS.find((a) => a.code === code)?.name ?? code;
const orgLabel = (org: string) => (org === "all" ? "all organisms" : org);
const pctText = (r: number, n: number) => (n >= MIN_ISOLATES ? `${((100 * r) / n).toFixed(1)}% (${r}/${n})` : n === 0 ? "–" : `n=${n}`);
const isMonthEnd = (iso: string) => { const t = new Date(`${iso}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.getUTCDate() === 1; };
const minusDays = (iso: string, d: number) => { const t = new Date(`${iso}T00:00:00Z`); t.setUTCDate(t.getUTCDate() - d); return t.toISOString().slice(0, 10); };

const TYKS: Source = { label: "Synthetic TYKS hospital microbiology export (JunctionX hackathon dataset), released by a weekly replay; plus records added from the dashboard" };
const COMMON_METHODS = [
  `Percentages use the first isolate per patient, organism and specimen type in the period, and are reported only when at least ${MIN_ISOLATES} isolates were tested (CLSI M39 convention); otherwise the count is shown (n=…).`,
  "% resistant = resistant ÷ (resistant + susceptible). Untested isolates are excluded from the denominator, never counted as susceptible.",
  "Antibiotic applicability follows a conservative subset of EUCAST breakpoint tables (expected-resistant, screen-only and urinary-only agents are not reported as treatment rates).",
];
const COMMON_LIMITS = [
  "Local data are synthetic and do not describe real patients or events.",
  "Small numbers give wide confidence intervals; compare intervals, not single percentages.",
];

// ── Hospital atlas ───────────────────────────────────────────────────────────

type WardRow = ReturnType<typeof wardOverview>[number];

export function buildAtlasReport(i: { wards: WardRow[]; asOf: string; latestSample: string; feed: FeedEntry[]; external: ExternalData | null; now?: Date }): ReportDoc {
  const now = i.now ?? new Date();
  const totalPatients = i.wards.reduce((n, w) => n + w.occupancy, 0);
  const positive = i.wards.reduce((n, w) => n + w.patients, 0);
  const byMarker = MARKERS.map((m) => ({ label: m.label, n: i.wards.reduce((s, w) => s + (w.markers.find((x) => x.key === m.key)?.patients ?? 0), 0) }));
  const top = [...i.wards].sort((a, b) => b.patients - a.patients)[0];
  const since = minusDays(now.toISOString().slice(0, 10), 30);
  const recentAlerts = i.feed.filter((e) => e.date >= since);
  const warnings = recentAlerts.filter((e) => e.severity === "warning" || e.category === "relevant").length;

  const sections: Section[] = [
    {
      id: "situation",
      heading: `Ward situation on ${i.asOf}`,
      blocks: [
        { type: "facts", items: [
          { label: "estimated patients (all locations)", value: totalPatients.toLocaleString("en-GB") },
          { label: "marker-positive patients", value: positive.toLocaleString("en-GB") },
          ...byMarker.map((m) => ({ label: `${m.label}-positive patients`, value: String(m.n) })),
        ] },
        { type: "figure", figure: { kind: "bar", caption: `Estimated marker-positive patients by location, ${i.asOf}`, unit: "patients", items: i.wards.map((w) => ({ label: w.name, value: w.patients })) } },
        { type: "table", table: {
          caption: `Estimated patients and marker-positive patients by location, ${i.asOf}`,
          columns: ["Location", "Setting", "Est. patients", "Marker-positive", ...MARKERS.map((m) => m.label)],
          rows: i.wards.map((w) => [w.name, w.institution === "hospital" ? "Hospital" : "Primary care", w.occupancy, w.patients, ...MARKERS.map((m) => w.markers.find((x) => x.key === m.key)?.patients ?? 0)]),
          note: "Estimated from culture episodes (no admission register); a patient may carry more than one marker.",
        } },
      ],
    },
    {
      id: "rates",
      heading: "Marker-positive share of first isolates, last 28 days",
      blocks: [{ type: "table", table: {
        caption: `Marker-positive % of first isolates by location, ${minusDays(i.asOf, 27)} to ${i.asOf}`,
        columns: ["Location", ...MARKERS.map((m) => m.label)],
        rows: i.wards.map((w) => [w.name, ...w.rates.map((r) => pctText(r.positive, r.n))]),
        note: `Shown as % (positive/first isolates); n=… when fewer than ${MIN_ISOLATES} first isolates.`,
      } }],
    },
    {
      id: "alerts",
      heading: "Alerts and news",
      blocks: [
        { type: "text", text: `${i.feed.length} items in the feed; ${recentAlerts.length} dated in the 30 days before ${now.toISOString().slice(0, 10)} (the feed is real-time), of which ${warnings} at warning level or flagged AMR-relevant.` },
        { type: "table", table: {
          caption: "Most recent alerts and announcements",
          columns: ["Date", "Source", "Level", "Title"],
          rows: i.feed.slice(0, 20).map((e) => [e.date || "–", sourceInfo(e.source).label, e.severity ?? (e.category === "relevant" ? "AMR relevant" : e.category === "review" ? "needs review" : "–"), e.title]),
          note: "ECDC items are real European news; local alerts concern the synthetic data.",
        } },
      ],
    },
  ];

  const sources: Source[] = [TYKS, { label: "ECDC RSS feeds (announcements), checked daily", url: "https://www.ecdc.europa.eu/en/news-events" }];
  const keyFacts = [
    `${totalPatients.toLocaleString("en-GB")} patients estimated across ${i.wards.length} locations on ${i.asOf}; ${positive} marker-positive (${byMarker.map((m) => `${m.label} ${m.n}`).join(", ")}).`,
    top && top.patients > 0 ? `Most marker-positive patients: ${top.name} (${top.patients} of ${top.occupancy} estimated).` : "No estimated marker-positive patients on this date.",
    `${recentAlerts.length} feed items in the 30 days before ${now.toISOString().slice(0, 10)}, ${warnings} at warning level or flagged AMR-relevant.`,
  ];

  if (i.external) {
    const ctx = i.external.context;
    const inc = incidenceSeries(ctx, "esbl-ecoli", "blood_csf");
    const last = [...inc].reverse().find((p) => p.region != null);
    const fin = finresSeries(i.external.bench, "Escherichia coli|CRO|blood");
    const nidr = i.external.sources.find((s) => s.source_id === "thl_nidr");
    const finSrc = i.external.sources.find((s) => s.source_id === "thl_finres");
    const shares = (["blood_csf", "carriage"] as const).map((sp) => ({ sp, share: notificationShare(ctx, REGION.code, sp) }));
    sections.push({
      id: "thl",
      heading: "National and regional context (THL, real data)",
      blocks: [
        { type: "text", text: `Reference data from the Finnish Institute for Health and Welfare. Register data ${yearRange(ctx)}, collected ${freshness(nidr).lastImport?.slice(0, 10) ?? "–"}; Finres data ${yearRange(i.external.bench)}, collected ${freshness(finSrc).lastImport?.slice(0, 10) ?? "–"}. Not directly comparable with the synthetic local data.` },
        { type: "figure", figure: { kind: "line", caption: `ESBL E. coli bloodstream infections per 100,000 population, ${REGION.label} vs ${COUNTRY.label}`, unit: "per 100,000", x: inc.map((p) => String(p.year)), series: [{ name: REGION.label, values: inc.map((p) => p.region), emphasis: true }, { name: COUNTRY.label, values: inc.map((p) => p.country) }] } },
        { type: "table", table: {
          caption: `Notified cases by resistance type, ${REGION.label}, latest year`,
          columns: ["Finding type", "Year", "ESBL", "MRSA", "VRE", "CPE", "Total"],
          rows: shares.map(({ sp, share }) => [SPECIMEN_LABEL[sp], share.year == null ? "–" : String(share.year), ...["ESBL", "MRSA", "VRE", "CPE"].map((l) => share.slices.find((s) => s.label === l)?.cases ?? 0), share.total]),
          note: "Bloodstream and carriage findings are separate notifications and are not added together.",
        } },
        { type: "figure", figure: { kind: "line", caption: "E. coli bloodstream isolates resistant to ceftriaxone, Finland (THL Finres)", unit: "% resistant", x: fin.map((p) => String(p.year)), series: [{ name: "Finland", values: fin.map((p) => p.pct) }], note: `n tested ${fin.map((p) => `${p.year}: ${p.n ?? "–"}`).slice(-3).join(", ")}.` } },
      ],
    });
    if (last) keyFacts.push(`THL: ESBL E. coli bloodstream infections in ${REGION.label} ${last.region?.toFixed(1)} per 100,000 in ${last.year} (${last.regionCases} cases) vs ${last.country?.toFixed(1)} in ${COUNTRY.label}.`);
    for (const s of [nidr, finSrc]) if (s) sources.push({ label: `${s.attribution ?? s.name}${s.licence ? ` (${s.licence})` : ""}`, ...(s.landing_url ? { url: s.landing_url } : {}) });
  }

  return {
    id: "hospital-atlas",
    title: "Hospital ward atlas report",
    subtitle: "Estimated resistant-bacteria carriage by ward, alerts, and national context",
    period: `Situation on ${i.asOf}; marker rates over the preceding 28 days`,
    dataAsOf: `latest sample ${i.latestSample}`,
    keyFacts,
    sections,
    methods: [
      "Occupancy is estimated from culture episodes: each culture places the patient in that ward, a culture elsewhere transfers them, and a stay is assumed to last 3 days (ED, surgery), 14 days (other wards) or 6 months (health centres).",
      "Marker-positive patients are estimated occupants with an ESBL, MRSA, VRE or CPE-positive isolate during that stay.",
      COMMON_METHODS[0],
    ],
    limitations: [...COMMON_LIMITS, "Occupancy and stay lengths are assumptions, not measured; this is not a bed-occupancy or isolation recommendation."],
    sources,
  };
}

// ── Spatial & trends ─────────────────────────────────────────────────────────

export function buildSpatialReport(i: { records: IsolateRecord[]; organisms: string[]; antibiotic: string | null; fromWeek: number; toWeek: number; uncomplicatedUTI: boolean; lastWeek: number }): ReportDoc {
  const by = spatialByWard(i.records, i);
  const series = spatialSeries(i.records, i);
  const metric = i.antibiotic ? `% resistant to ${abxName(i.antibiotic)}` : "isolate count";
  const period = `${weekStart(i.fromWeek)} to ${weekStart(i.toWeek)} (${i.toWeek - i.fromWeek + 1} weeks)`;
  const value = (c: { n: number; tested: number; pos: number }) => (i.antibiotic ? (c.tested >= MIN_ISOLATES ? (100 * c.pos) / c.tested : null) : c.n);
  const ranked = WARDS.map((w) => ({ w, v: value(by[w.code]) })).filter((x) => x.v != null).sort((a, b) => (b.v as number) - (a.v as number));
  const topWards = [...WARDS].sort((a, b) => by[b.code].n - by[a.code].n).slice(0, 4);
  const recent = series.slice(-13);
  const total = WARDS.reduce((n, w) => n + by[w.code].n, 0);

  return {
    id: "spatial-trends",
    title: "Spatial and temporal resistance report",
    subtitle: `${i.organisms.join(", ")} · ${metric}${i.uncomplicatedUTI ? " · uncomplicated lower UTI context" : ""}`,
    period,
    dataAsOf: `latest week starting ${weekStart(i.lastWeek)}`,
    keyFacts: [
      `${total.toLocaleString("en-GB")} ${i.antibiotic ? "first isolates" : "isolates"} of ${i.organisms.join(" and ")} across ${WARDS.length} locations in ${period}.`,
      ranked[0] ? `Highest: ${ranked[0].w.name} (${i.antibiotic ? `${(ranked[0].v as number).toFixed(1)}%, ${by[ranked[0].w.code].pos}/${by[ranked[0].w.code].tested} tested` : `${ranked[0].v} isolates`}).` : `No location reached ${MIN_ISOLATES} tested isolates.`,
      ...(i.antibiotic ? [`${WARDS.filter((w) => by[w.code].tested < MIN_ISOLATES).length} of ${WARDS.length} locations had too few tested isolates for a percentage.`] : []),
    ],
    sections: [
      {
        id: "by-location",
        heading: "By location",
        blocks: [
          { type: "figure", figure: { kind: "bar", caption: `${metric} by location, ${period}`, unit: i.antibiotic ? "% resistant" : "isolates", items: ranked.map((x) => ({ label: x.w.name, value: Math.round((x.v as number) * 10) / 10 })) } },
          { type: "table", table: {
            caption: `${metric} by location, ${period}`,
            columns: ["Location", i.antibiotic ? "First isolates" : "Isolates", ...(i.antibiotic ? ["Tested", "Resistant", "% resistant"] : [])],
            rows: WARDS.map((w) => [w.name, by[w.code].n, ...(i.antibiotic ? [by[w.code].tested, by[w.code].pos, pctText(by[w.code].pos, by[w.code].tested)] : [])]),
          } },
        ],
      },
      {
        id: "over-time",
        heading: "Over time (4-week periods)",
        blocks: [
          { type: "figure", figure: { kind: "line", caption: `${metric} per 4 weeks, last ${recent.length} periods, four locations with most isolates`, unit: i.antibiotic ? "% resistant" : "isolates", x: recent.map((s) => s.period.slice(2)), series: topWards.map((w) => ({ name: w.code, values: recent.map((s) => s.byWard[w.code]) })), note: i.antibiotic ? `Gaps: fewer than ${MIN_ISOLATES} tested first isolates in that period.` : undefined } },
          { type: "table", table: {
            caption: `${metric} per 4-week period, last ${recent.length} periods`,
            columns: ["Period from", ...WARDS.map((w) => w.code)],
            rows: recent.map((s) => [s.period, ...WARDS.map((w) => (s.byWard[w.code] == null ? "n<30" : i.antibiotic ? (s.byWard[w.code] as number).toFixed(1) : s.byWard[w.code]))]),
          } },
        ],
      },
    ],
    methods: i.antibiotic ? COMMON_METHODS : ["Isolate counts include every isolate in the period (not de-duplicated)."],
    limitations: COMMON_LIMITS,
    sources: [TYKS],
  };
}

// ── Ward resistance ──────────────────────────────────────────────────────────

export function buildWardsReport(i: { records: IsolateRecord[]; organism: string; endWeek: number; windowWeeks: number; uncomplicatedUTI: boolean; antibiotic: string; lastWeek: number }): ReportDoc {
  // Same agents as the Ward resistance page: those with a supported breakpoint for every selected organism.
  const available = commonAntibiotics(i.organism === "all" ? ORGANISMS : [i.organism], i.uncomplicatedUTI);
  const rows = wardMatrix(i.records, { organism: i.organism, endWeek: i.endWeek, windowWeeks: i.windowWeeks, uncomplicatedUTI: i.uncomplicatedUTI });
  const codes = available.map((a) => a.code);
  const from = weekStart(Math.max(0, i.endWeek - i.windowWeeks + 1));
  const to = weekStart(i.endWeek);
  const sel = rows.map((r) => ({ ward: r.ward, cell: r.cells.find((c) => c.code === i.antibiotic)! }));
  const total = sel.find((s) => s.ward.code === "TOTAL")!.cell;
  const ci = total.reportable ? wilson(total.r, total.n) : null;
  const ranked = sel.filter((s) => s.ward.code !== "TOTAL" && s.cell.reportable).sort((a, b) => (b.cell.pct ?? 0) - (a.cell.pct ?? 0));
  const span = Math.min(26, i.lastWeek + 1);
  const trendX: string[] = [];
  const trendY: (number | null)[] = [];
  for (let t = i.lastWeek - span + 1; t <= i.lastWeek; t++) {
    if (t < i.windowWeeks - 1) continue;
    const c = wardMatrix(i.records, { organism: i.organism, endWeek: t, windowWeeks: i.windowWeeks, uncomplicatedUTI: i.uncomplicatedUTI }).at(-1)!.cells.find((x) => x.code === i.antibiotic)!;
    trendX.push(weekStart(t).slice(5));
    trendY.push(c.reportable && c.pct != null ? Math.round(c.pct * 10) / 10 : null);
  }
  const perWardTrend = wardTrend(i.records, { organism: i.organism, antibiotic: i.antibiotic, windowWeeks: i.windowWeeks, uncomplicatedUTI: i.uncomplicatedUTI, lastWeek: i.lastWeek, maxPoints: 13 });

  const matrix: Table = {
    caption: `% resistant by ward and antibiotic, ${orgLabel(i.organism)}, ${from} to ${to}`,
    columns: ["Ward", "First isolates", ...codes],
    rows: rows.map((r) => [r.ward.name, r.n, ...codes.map((c) => { const x = r.cells.find((y) => y.code === c)!; return pctText(x.r, x.n); })]),
    note: `Cells show % (resistant/tested); n=… below ${MIN_ISOLATES} tested; – no results. Only agents with a supported EUCAST breakpoint for ${orgLabel(i.organism)} are listed.`,
  };

  return {
    id: "ward-resistance",
    title: "Ward resistance report",
    subtitle: `${orgLabel(i.organism)} · rolling ${i.windowWeeks}-week window${i.uncomplicatedUTI ? " · uncomplicated lower UTI context" : ""}`,
    period: `${from} to ${to}`,
    dataAsOf: `latest week starting ${weekStart(i.lastWeek)}`,
    keyFacts: [
      total.reportable
        ? `${abxName(i.antibiotic)}: ${total.pct!.toFixed(1)}% of ${orgLabel(i.organism)} first isolates resistant hospital-wide (${total.r}/${total.n}; 95% CI ${ci!.low.toFixed(1)}–${ci!.high.toFixed(1)}%).`
        : `${abxName(i.antibiotic)}: too few tested first isolates hospital-wide for a percentage (n=${total.n}).`,
      ranked[0] ? `Highest ward: ${ranked[0].ward.name} ${ranked[0].cell.pct!.toFixed(1)}% (${ranked[0].cell.r}/${ranked[0].cell.n}); lowest: ${ranked.at(-1)!.ward.name} ${ranked.at(-1)!.cell.pct!.toFixed(1)}%.` : `No ward reached ${MIN_ISOLATES} tested isolates for ${abxName(i.antibiotic)}.`,
      `${sel.filter((s) => s.ward.code !== "TOTAL" && !s.cell.reportable).length} of ${WARDS.length} locations had too few tested isolates for a percentage.`,
    ],
    sections: [
      { id: "matrix", heading: "Resistance by ward and antibiotic", blocks: [{ type: "table", table: matrix }] },
      {
        id: "selected",
        heading: `${abxName(i.antibiotic)} by ward`,
        blocks: [
          { type: "figure", figure: { kind: "bar", caption: `% resistant to ${abxName(i.antibiotic)} by ward (reportable wards), ${from} to ${to}`, unit: "% resistant", items: ranked.map((s) => ({ label: s.ward.name, value: Math.round(s.cell.pct! * 10) / 10 })) } },
          { type: "table", table: {
            caption: `% resistant to ${abxName(i.antibiotic)} with 95% confidence intervals, ${from} to ${to}`,
            columns: ["Ward", "Tested", "Resistant", "% resistant", "95% CI"],
            rows: sel.map((s) => { const c = wilson(s.cell.r, s.cell.n); return [s.ward.name, s.cell.n, s.cell.r, s.cell.reportable ? s.cell.pct!.toFixed(1) : `n<${MIN_ISOLATES}`, s.cell.reportable && c ? `${c.low.toFixed(1)}–${c.high.toFixed(1)}` : "–"]; }),
            note: "Wilson score 95% intervals.",
          } },
        ],
      },
      {
        id: "trend",
        heading: `${abxName(i.antibiotic)} over time`,
        blocks: [
          { type: "figure", figure: { kind: "line", caption: `Hospital-wide % resistant to ${abxName(i.antibiotic)}, rolling ${i.windowWeeks}-week window, last ${trendX.length} weeks`, unit: "% resistant", x: trendX, series: [{ name: "All wards", values: trendY }], note: `Gaps: fewer than ${MIN_ISOLATES} tested first isolates.` } },
          { type: "table", table: {
            caption: `% resistant to ${abxName(i.antibiotic)} by ward, last ${perWardTrend.length} weeks (rolling ${i.windowWeeks}-week window)`,
            columns: ["Week from", ...WARDS.map((w) => w.code)],
            rows: perWardTrend.map((p) => [p.week, ...WARDS.map((w) => (p.byWard[w.code].pct == null ? `n=${p.byWard[w.code].n}` : (p.byWard[w.code].pct as number).toFixed(1)))]),
          } },
        ],
      },
    ],
    methods: [...COMMON_METHODS, "Confidence intervals: Wilson score 95%."],
    limitations: COMMON_LIMITS,
    sources: [TYKS, { label: "EUCAST clinical breakpoint tables", url: "https://www.eucast.org/bacteria/clinical-breakpoints-and-interpretation/clinical-breakpoint-tables/" }],
  };
}

// ── Cluster detection ────────────────────────────────────────────────────────

export function buildDetectionReport(i: { records: IsolateRecord[]; settings: ClusterScanOptions; caseLabel: string; pLimit: number }): ReportDoc {
  const r = clusterScan(i.records, i.settings);
  const shown = r.clusters.filter((c) => c.p <= i.pLimit);
  const sig = r.clusters.filter((c) => c.p < 0.05);
  const period = `${weekStart(r.start)} to ${weekStart(i.settings.lastWeek)} (${i.settings.studyWeeks} weeks)`;
  const model = i.settings.model === "stp" ? "space-time permutation" : "Bernoulli";
  return {
    id: "cluster-detection",
    title: "Cluster detection report",
    subtitle: `${i.caseLabel} · ${orgLabel(i.settings.organism)} · ${model} scan, ${i.settings.prospective ? "prospective" : "retrospective"}`,
    period,
    dataAsOf: `latest week starting ${weekStart(i.settings.lastWeek)}`,
    keyFacts: [
      `${r.cases.toLocaleString("en-GB")} cases (${i.caseLabel}) in the study period across ${r.locations.length} locations.`,
      sig.length ? `${sig.length} candidate cluster${sig.length === 1 ? "" : "s"} significant at p < 0.05; strongest: ${sig[0].zone.map(wardName).join(" + ")}, ${weekStart(r.start + sig[0].start)} to ${weekStart(r.start + sig[0].end)} (${sig[0].observed} observed vs ${sig[0].expected.toFixed(1)} expected, RR ${sig[0].rr.toFixed(2)}).` : "No candidate cluster significant at p < 0.05.",
      "A significant cluster is a statistical signal for infection-control review, not a confirmed outbreak.",
    ],
    sections: [
      {
        id: "settings",
        heading: "Analysis settings",
        blocks: [{ type: "facts", items: [
          { label: "probability model", value: model },
          { label: "case definition", value: i.caseLabel },
          { label: "study period", value: `${i.settings.studyWeeks} weeks` },
          { label: "max cluster length", value: `${i.settings.maxWindow} weeks` },
          { label: "Monte Carlo replications", value: String(i.settings.replications) },
        ] }],
      },
      {
        id: "clusters",
        heading: "Candidate clusters",
        blocks: [
          { type: "figure", figure: { kind: "bar", caption: "Relative risk of candidate clusters (top 10)", unit: "relative risk", items: shown.slice(0, 10).map((c, k) => ({ label: `#${k + 1} ${c.zone.join("+")}`, value: Math.round(c.rr * 100) / 100 })) } },
          { type: "table", table: {
            caption: `Candidate clusters${i.pLimit < 1 ? ` with p ≤ ${i.pLimit}` : ""}, ${period}`,
            columns: ["#", "Location(s)", "Period", "Observed", "Expected", "RR", "LLR", "p-value", "Significant"],
            rows: shown.map((c, k) => [k + 1, c.zone.map(wardName).join(" + "), `${weekStart(r.start + c.start)} to ${weekStart(r.start + c.end)}`, c.observed, +c.expected.toFixed(1), +c.rr.toFixed(2), +c.llr.toFixed(2), c.p.toFixed(3), c.p < 0.05 ? "yes" : "no"]),
            note: "RR = relative risk; LLR = log-likelihood ratio. p-values from Monte Carlo replication (seeded, reproducible).",
          } },
        ],
      },
    ],
    methods: [
      `Scan statistic over wards and weeks (${model} model). The space-time permutation model detects a ward whose share of cases rises in a recent period using case data only (Kulldorff et al., PLoS Med 2005); Bernoulli compares cases with non-cases among tested isolates.`,
      "Significance from Monte Carlo replications; p < 0.05 labelled significant. Prospective scans only consider clusters still ongoing in the last week.",
    ],
    limitations: [...COMMON_LIMITS, "Multiple overlapping candidates are listed; they are not independent findings.", "Clusters need epidemiological and laboratory (e.g. typing) confirmation."],
    sources: [TYKS, { label: "Kulldorff M, et al. A space–time permutation scan statistic for disease outbreak detection. PLoS Med 2005;2(3):e59", url: "https://doi.org/10.1371/journal.pmed.0020059" }],
  };
}

// ── Records ──────────────────────────────────────────────────────────────────

export function buildRecordsReport(i: { records: IsolateRecord[]; filterLabel: string }): ReportDoc {
  const recs = i.records;
  const first = firstIsolates(recs);
  const dates = recs.map((r) => r.date).sort();
  const count = (key: (r: IsolateRecord) => string) => {
    const m = new Map<string, number>();
    for (const r of recs) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  };
  const pct = (n: number) => (recs.length ? `${((100 * n) / recs.length).toFixed(1)}%` : "–");
  // Monthly volume over the replayed data only: records entered later from the dashboard would otherwise sit after
  // months with no data yet and look like a collapse. They are still counted everywhere else.
  const replayedTo = latestSampleDate(recs);
  const later = recs.filter((r) => r.date > replayedTo).length;
  const months = count((r) => r.date.slice(0, 7)).filter(([m]) => m <= replayedTo.slice(0, 7)).sort((a, b) => a[0].localeCompare(b[0])).slice(-12);
  const partial = replayedTo && !isMonthEnd(replayedTo) ? ` ${replayedTo.slice(0, 7)} is a partial month (data up to ${replayedTo}).` : "";
  const monthNote = `${partial}${later ? ` ${later} record${later === 1 ? "" : "s"} dated after ${replayedTo} (added from the dashboard) are not shown here.` : ""}`.trim() || undefined;
  const pending = recs.filter((r) => r.pending).length;
  const markerRows = MARKERS.map((m) => { const pos = first.filter((r) => (r.flags & m.bit) !== 0).length; return [m.label, pos, first.length, pctText(pos, first.length)]; });
  return {
    id: "records",
    title: "Isolate records summary",
    subtitle: `Records matching: ${i.filterLabel}`,
    period: dates.length ? `${dates[0]} to ${dates.at(-1)}` : "no records",
    dataAsOf: `latest sample ${dates.at(-1) ?? "–"}`,
    keyFacts: [
      `${recs.length.toLocaleString("en-GB")} isolates from ${new Set(recs.map((r) => r.patient)).size.toLocaleString("en-GB")} patients (${first.length.toLocaleString("en-GB")} first isolates).`,
      `${pending} added from the dashboard and awaiting pipeline ingest.`,
      ...(count((r) => r.organism)[0] ? [`Most common organism: ${count((r) => r.organism)[0][0]} (${pct(count((r) => r.organism)[0][1])} of isolates).`] : []),
    ],
    sections: [
      { id: "organisms", heading: "By organism", blocks: [{ type: "table", table: { caption: "Isolates by organism", columns: ["Organism", "Isolates", "Share"], rows: count((r) => r.organism).map(([k, n]) => [k, n, pct(n)]) } }] },
      { id: "locations", heading: "By location and specimen", blocks: [
        { type: "table", table: { caption: "Isolates by location", columns: ["Location", "Isolates", "Share"], rows: count((r) => r.ward).map(([k, n]) => [wardName(k), n, pct(n)]) } },
        { type: "table", table: { caption: "Isolates by specimen", columns: ["Specimen", "Isolates", "Share"], rows: count((r) => r.specimen).map(([k, n]) => [k, n, pct(n)]) } },
      ] },
      { id: "markers", heading: "Resistance markers", blocks: [{ type: "table", table: { caption: "Marker-positive first isolates", columns: ["Marker", "Positive", "First isolates", "%"], rows: markerRows } }] },
      { id: "monthly", heading: "Monthly volume", blocks: [
        { type: "figure", figure: { kind: "line", caption: "Isolates per month, last 12 months of replayed data", unit: "isolates", x: months.map(([m]) => m), series: [{ name: "Isolates", values: months.map(([, n]) => n) }], note: monthNote } },
        { type: "table", table: { caption: "Isolates per month", columns: ["Month", "Isolates"], rows: months.map(([m, n]) => [m, n]) } },
      ] },
    ],
    methods: ["Counts include every isolate matching the page's filters; marker percentages use first isolates (per patient, organism, specimen) over the whole selection.", COMMON_METHODS[0]],
    limitations: COMMON_LIMITS,
    sources: [TYKS],
  };
}

// ── ECDC announcements ───────────────────────────────────────────────────────

export function buildAnnouncementsReport(i: { items: Announcement[]; filterLabel: string; lastCheck: string | null; attribution: string }): ReportDoc {
  const by = (c: Announcement["category"]) => i.items.filter((a) => a.category === c).length;
  const dates = i.items.map((a) => (a.published ?? a.firstDetected ?? "").slice(0, 10)).filter(Boolean).sort();
  return {
    id: "ecdc-announcements",
    title: "ECDC announcements digest",
    subtitle: `Items shown: ${i.filterLabel}`,
    period: dates.length ? `${dates[0]} to ${dates.at(-1)}` : "no items",
    dataAsOf: `feeds last checked ${i.lastCheck ? i.lastCheck.replace("T", " ").slice(0, 16) + " UTC" : "never"}`,
    keyFacts: [
      `${i.items.length} ECDC items: ${by("relevant")} AMR-relevant, ${by("review")} needing review, ${by("unrelated")} unrelated.`,
      "Classification is keyword-based; items marked 'needs review' should be read before being acted on.",
    ],
    sections: [{
      id: "items",
      heading: "Announcements",
      blocks: [{ type: "table", table: {
        caption: "ECDC announcements, newest first",
        columns: ["Published", "Category", "Title", "Matched terms", "Link"],
        rows: i.items.map((a) => [(a.published ?? "").slice(0, 10) || "–", a.category === "relevant" ? "AMR relevant" : a.category === "review" ? "needs review" : "unrelated", a.title, a.terms.join(", ") || "–", a.url]),
      } }],
    }],
    methods: ["ECDC RSS feeds are checked once a day; each item is classified by matching AMR-related terms in its title and summary."],
    limitations: ["Real-world European news, not local findings. Keyword classification can miss or over-include items."],
    sources: [{ label: i.attribution || "Source: ECDC", url: "https://www.ecdc.europa.eu/en/news-events" }],
  };
}

// ── Patients (doctor) and Laboratory ─────────────────────────────────────────

const requestRow = (r: CultureRequest) => [r.culture_id, r.patient_id, wardName(r.ward_code), r.specimen, r.sample_date, r.status, r.result_organism ?? "–"];
const REQUEST_COLUMNS = ["Culture", "Patient", "Ward", "Specimen", "Sample date", "Status", "Result"];

export function buildPatientsReport(i: { requests: CultureRequest[]; email: string | null }): ReportDoc {
  const pending = i.requests.filter((r) => r.status === "pending").length;
  return {
    id: "patients",
    title: "Culture requests report",
    subtitle: `Requests sent by ${i.email ?? "this doctor"}`,
    period: i.requests.length ? `${i.requests.at(-1)!.created_at.slice(0, 10)} to ${i.requests[0].created_at.slice(0, 10)}` : "no requests",
    dataAsOf: new Date().toISOString().slice(0, 10),
    keyFacts: [`${i.requests.length} culture requests: ${pending} waiting for the laboratory, ${i.requests.length - pending} completed.`],
    sections: [{ id: "requests", heading: "My culture requests", blocks: [{ type: "table", table: { caption: "Culture requests, newest first", columns: REQUEST_COLUMNS, rows: i.requests.map(requestRow) } }] }],
    methods: ["Requests are read live from the database; results appear once the laboratory completes the culture."],
    limitations: ["Contains patient identifiers entered by the requester: handle according to local data-protection rules.", ...COMMON_LIMITS.slice(0, 1)],
    sources: [TYKS],
  };
}

export function buildLabReport(i: { waiting: CultureRequest[] }): ReportDoc {
  return {
    id: "laboratory",
    title: "Laboratory worklist",
    subtitle: "Culture requests waiting for results",
    period: i.waiting.length ? `requested ${i.waiting[0].created_at.slice(0, 10)} to ${i.waiting.at(-1)!.created_at.slice(0, 10)}` : "no waiting requests",
    dataAsOf: new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC",
    keyFacts: [`${i.waiting.length} cultures waiting.`],
    sections: [{ id: "waiting", heading: "Waiting list", blocks: [{ type: "table", table: { caption: "Waiting cultures, oldest first", columns: [...REQUEST_COLUMNS.slice(0, 5), "Requested"], rows: i.waiting.map((r) => [...requestRow(r).slice(0, 5), r.created_at.slice(0, 16).replace("T", " ")]) } }] }],
    methods: ["The worklist updates live from the database as doctors send requests."],
    limitations: ["Contains patient identifiers: handle according to local data-protection rules."],
    sources: [TYKS],
  };
}

