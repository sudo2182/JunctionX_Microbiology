import { GUIDELINE_URL } from "@/lib/amr/applicability";

/**
 * What the assistant may say about methods and evidence. Every section describes what this dashboard's code
 * actually does (see the file named in `implementedIn`) and cites only sources that were checked.
 * The assistant retrieves these with the search_methods tool instead of answering from memory.
 */
export type Source = { label: string; url?: string };
export type KnowledgeSection = { id: string; title: string; keywords: string[]; text: string; implementedIn?: string; sources: Source[] };

const CLSI_M39: Source = { label: "CLSI M39, Analysis and Presentation of Cumulative Antimicrobial Susceptibility Test Data, 5th ed. (2022)", url: "https://clsi.org/standards/products/microbiology/documents/m39/" };
const BAMFORD: Source = { label: "Bamford C. Reporting of cumulative antimicrobial susceptibility testing data, including antibiograms. S Afr J Infect Dis 2025;40(1):775 (summary of CLSI M39)", url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC12506590/" };
const EUCAST_BP: Source = { label: "EUCAST clinical breakpoint tables", url: GUIDELINE_URL };
const EUCAST_ER: Source = { label: "EUCAST Expected resistant phenotypes v1.2 (13 January 2023)", url: "https://www.eucast.org/expert_rules_and_expected_phenotypes/expected_phenotypes" };
const KULLDORFF: Source = { label: "Kulldorff M, et al. A space–time permutation scan statistic for disease outbreak detection. PLoS Med 2005;2(3):e59", url: "https://doi.org/10.1371/journal.pmed.0020059" };
const WILSON: Source = { label: "Wilson EB. Probable inference, the law of succession, and statistical inference. J Am Stat Assoc 1927;22:209–212", url: "https://doi.org/10.1080/01621459.1927.10502953" };
const SATSCAN: Source = { label: "SaTScan software and user guide", url: "https://www.satscan.org/" };
const PPS_BE: Source = { label: "Sciensano/ECDC point prevalence survey definitions (onset on day 3 or later, admission day = day 1)", url: "https://www.healthybelgium.be/images/KCE/2024/QS1.pdf" };
const LOCAL: Source = { label: "AMR Watch methods (this dashboard's own rule, not an external standard)" };

export const KNOWLEDGE: KnowledgeSection[] = [
  {
    id: "data-source",
    title: "Where the data comes from",
    keywords: ["data", "source", "synthetic", "tyks", "dataset", "real", "replay", "refresh", "updated", "pipeline", "submitted", "pending"],
    text:
      "All isolate data is the synthetic TYKS microbiology export supplied for the hackathon (156 ISO weeks, 2023-W40 to 2026-W39). It is not real patient data, so findings must not be presented as real clinical events. A weekly replay releases the data one week at a time into the database; the dashboard reads the released isolates plus records added from the dashboard itself (marked 'new'/pending until the pipeline ingests them). Reference lists (wards, organisms, antibiotics) come from the database reference tables.",
    implementedIn: "src/lib/amr/store.ts",
    sources: [LOCAL],
  },
  {
    id: "first-isolate",
    title: "First-isolate rule (deduplication)",
    keywords: ["first isolate", "duplicate", "deduplication", "repeat", "same patient", "copy strain", "per patient", "count"],
    text:
      "Resistance percentages use only the first isolate per patient, per organism and per specimen type within the selected window, so repeat cultures from one patient do not inflate resistance. CLSI M39 recommends the first isolate of a species per patient per analysis period, and notes it should be counted once even across different specimen types; this dashboard is slightly less strict because it keeps one isolate per specimen type. Isolate counts on the Spatial & trends map ('Isolate count') are all isolates, not first isolates.",
    implementedIn: "src/lib/amr/stats.ts (firstIsolates)",
    sources: [CLSI_M39, BAMFORD],
  },
  {
    id: "minimum-isolates",
    title: "Why some cells show n=… instead of a percentage (minimum 30)",
    keywords: ["30", "minimum", "small sample", "n=", "not reportable", "too few", "hidden", "gap", "missing percentage"],
    text:
      "A percentage is only shown when at least 30 first isolates were tested for that organism–antibiotic combination in that ward and window; otherwise the cell shows the count (n=…) and trend lines have gaps. Small samples give unstable percentages: for 90% susceptibility the 95% confidence interval is about 74–97% at n=30 but 57–100% at n=10. CLSI M39 recommends reporting only organisms with at least 30 isolates and including 95% confidence intervals.",
    implementedIn: "src/lib/amr/stats.ts (MIN_ISOLATES, resistance)",
    sources: [CLSI_M39, BAMFORD],
  },
  {
    id: "resistance-percent",
    title: "How % resistant is calculated",
    keywords: ["percent", "%", "resistance rate", "calculate", "numerator", "denominator", "how", "formula", "tested"],
    text:
      "% resistant = resistant results ÷ (resistant + susceptible results) among first isolates in the window, × 100. Isolates without a result for that antibiotic are not counted in the denominator (never treated as susceptible). Only organism–antibiotic combinations with a supported EUCAST clinical breakpoint are calculated; others show N/A, ER, Screen, Review or 'UTI only'. Windows are rolling: 1, 4, 13 or 52 weeks ending at the selected reporting week. The assistant also reports a Wilson 95% confidence interval, which the dashboard table does not display.",
    implementedIn: "src/lib/amr/surveillance.ts (wardMatrix), src/lib/amr/stats.ts (resistance)",
    sources: [WILSON, CLSI_M39],
  },
  {
    id: "confidence-interval",
    title: "Confidence intervals (uncertainty)",
    keywords: ["confidence", "interval", "uncertainty", "ci", "wilson", "significant", "precision", "range"],
    text:
      "The assistant gives Wilson score 95% intervals for percentages. The interval shows the range of resistance proportions compatible with the observed counts; it is wide when n is small. Two wards whose intervals overlap substantially should not be described as different.",
    implementedIn: "src/lib/amr/surveillance.ts (wilson)",
    sources: [WILSON, BAMFORD],
  },
  {
    id: "applicability",
    title: "Which antibiotics are shown for which organism (EUCAST applicability)",
    keywords: ["eucast", "breakpoint", "n/a", "er", "expected resistant", "screen", "review", "uti only", "urinary", "applicable", "why not shown", "cefoxitin", "intrinsic"],
    text:
      "Each organism–antibiotic pair is classified with a conservative subset of the EUCAST 2026 breakpoint tables: applicable (percentage calculated); expected resistant (ER, e.g. Klebsiella and Citrobacter freundii with ampicillin, so a percentage would be meaningless and susceptible results need laboratory review); screen (cefoxitin is a resistance screen, not a treatment); urinary ('UTI only', e.g. pivmecillinam, trimethoprim and nitrofurantoin, shown only when the 'uncomplicated lower UTI' switch is on); review (needs expert interpretation); unsupported (N/A, no supported breakpoint). This is surveillance logic, not prescribing advice.",
    implementedIn: "src/lib/amr/applicability.ts",
    sources: [EUCAST_BP, EUCAST_ER],
  },
  {
    id: "markers",
    title: "Resistance markers: ESBL, MRSA, VRE, CPE",
    keywords: ["esbl", "mrsa", "vre", "cpe", "marker", "carbapenemase", "phenotype", "flag"],
    text:
      "ESBL (extended-spectrum beta-lactamase producer), MRSA (methicillin-resistant Staphylococcus aureus), VRE (vancomycin-resistant enterococcus) and CPE (carbapenemase-producing Enterobacterales) are flags recorded by the laboratory on each isolate. Marker rates are positive first isolates ÷ all first isolates in the set, shown only when there are at least 30 first isolates.",
    implementedIn: "src/lib/amr/occupancy.ts (markerRates)",
    sources: [LOCAL, CLSI_M39],
  },
  {
    id: "hospital-onset",
    title: "Hospital-onset vs community-onset",
    keywords: ["onset", "hospital-onset", "community", "nosocomial", "acquired", "day 3", "admission"],
    text:
      "An isolate is hospital-onset when the sample was taken on or after the 3rd hospital day, counting the admission day as day 1; earlier samples are community-onset and outpatient samples are outpatient. This follows the day-3 convention of the ECDC point prevalence survey definitions.",
    implementedIn: "src/lib/amr/store.ts (isHospitalOnset)",
    sources: [PPS_BE],
  },
  {
    id: "atlas",
    title: "Hospital atlas: estimated occupancy and marker-positive patients",
    keywords: ["atlas", "occupancy", "patients in ward", "estimated", "stay", "bed", "current", "positive patients", "transfer"],
    text:
      "The dataset has no admission/discharge register, so ward occupancy is an estimate built from culture episodes: each culture places the patient in that ward, a culture in another ward transfers them, and the stay is assumed to last 3 days (ED, surgery), 14 days (other wards) or 6 months (health centres) from the culture date. Marker-positive patients are estimated occupants with a marker-positive isolate during that stay. The 28-day marker rates per ward use first isolates from the 28 days before the selected date. These durations are this dashboard's assumptions, not measured lengths of stay.",
    implementedIn: "src/lib/amr/occupancy.ts",
    sources: [LOCAL],
  },
  {
    id: "cluster-detection",
    title: "Cluster detection (SaTScan-style scan statistic)",
    keywords: ["cluster", "satscan", "outbreak", "scan", "space-time", "permutation", "bernoulli", "p-value", "relative risk", "rr", "llr", "signal"],
    text:
      "The Cluster detection page runs a scan statistic over wards and weeks. The space-time permutation model flags a ward whose share of cases rises in a recent period relative to its usual share, using only case data; the Bernoulli model compares cases with non-cases among tested isolates. Significance comes from Monte Carlo replications (seeded, so results are reproducible); p < 0.05 is labelled significant. A statistically significant cluster is a signal for investigation, not a confirmed outbreak: it needs epidemiological and laboratory (e.g. typing) confirmation. Prospective scans only consider clusters still ongoing in the last week.",
    implementedIn: "src/lib/amr/satscan.ts, src/lib/amr/surveillance.ts (clusterScan)",
    sources: [KULLDORFF, SATSCAN],
  },
  {
    id: "alerts",
    title: "Alerts feed and ECDC announcements",
    keywords: ["alert", "feed", "news", "ecdc", "announcement", "rss", "warning", "watch", "severity", "internal"],
    text:
      "The feed merges alerts stored in the dashboard database (posted by staff, sent from cluster detection, or generated automatically) with ECDC RSS announcements classified as AMR-relevant or needing review. ECDC items are real-world European news checked once a day, not local TYKS findings; local alerts concern the synthetic data. Severity is info, watch or warning as set by the poster or rule.",
    implementedIn: "src/lib/amr/alert-sources.ts, src/lib/amr/announcements.ts",
    sources: [LOCAL],
  },
  {
    id: "risk-predictor",
    title: "Patient risk estimate (doctor page)",
    keywords: ["risk", "predict", "naive bayes", "probability", "baseline", "estimate", "patient risk"],
    text:
      "The doctor page's risk estimate is a naive Bayes model trained on the dashboard's isolates: it multiplies how much each known factor (age band, sex, ward, specimen, organism, care setting, onset) changes the odds compared with the baseline rate, skipping unknown factors. It has not been validated and must not guide treatment; local guidelines and the laboratory result decide therapy.",
    implementedIn: "src/lib/amr/risk.ts",
    sources: [LOCAL],
  },
  {
    id: "interpretation",
    title: "How to interpret a change safely",
    keywords: ["increase", "decrease", "trend", "change", "worse", "better", "compare", "significant change", "interpret", "investigate", "steps", "what should"],
    text:
      "Before concluding resistance changed: (1) check n in both periods — percentages from fewer than 30 isolates are not reported and small n gives wide intervals; (2) compare confidence intervals rather than point estimates; (3) look at the trend over several windows instead of one week; (4) check whether the organism mix or specimen mix changed; (5) check for repeat isolates from a few patients (the first-isolate rule handles repeats within the window only); (6) for a suspected cluster, run Cluster detection and treat a significant result as a signal for infection-control review, not a confirmed outbreak. Treatment decisions follow local guidelines and the laboratory report.",
    sources: [CLSI_M39, BAMFORD, KULLDORFF],
  },
];

/** Keyword retrieval over a small, curated corpus: enough here, and fully predictable. */
export function searchKnowledge(query: string, limit = 3): KnowledgeSection[] {
  const q = query.toLowerCase();
  const words = q.split(/[^a-z0-9%=/-]+/).filter((w) => w.length > 2);
  const scored = KNOWLEDGE.map((s) => {
    let score = 0;
    for (const k of s.keywords) if (q.includes(k)) score += k.includes(" ") ? 3 : 2;
    const hay = `${s.title} ${s.text}`.toLowerCase();
    for (const w of words) if (hay.includes(w)) score += 1;
    return { s, score };
  });
  return scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.s);
}
