/**
 * The fixed set of tools the assistant may call, declared in the Gemini function-calling format.
 * The model never sees raw data or writes queries: it can only ask for one of these, and the browser
 * answers with the same calculations the dashboard pages use (see tools.ts).
 */

type Prop = { type: "string" | "integer" | "boolean"; description: string; enum?: string[] };
export type ToolSpec = { name: string; description: string; parameters: { type: "object"; properties: Record<string, Prop>; required?: string[] } };

const organism: Prop = { type: "string", description: 'Organism as the user wrote it, e.g. "E. coli", "Klebsiella pneumoniae", or "all".' };
const antibiotic: Prop = { type: "string", description: 'Antibiotic name or code, e.g. "ceftriaxone" or "CRO".' };
const ward: Prop = { type: "string", description: 'Ward code or name, e.g. "ICU", "Geriatrics", or "all" for the whole hospital and health centres.' };
const endDate: Prop = { type: "string", description: "Reporting week as a date YYYY-MM-DD; the week containing it is used. Omit for the latest week in the data." };
const windowWeeks: Prop = { type: "integer", description: "Rolling window length in weeks: 1, 4, 13 or 52. Omit for 4." };
const uti: Prop = { type: "boolean", description: "Uncomplicated lower UTI context: also include urinary-only agents (pivmecillinam, trimethoprim, nitrofurantoin). Omit for false." };
const fromDate: Prop = { type: "string", description: "Start date YYYY-MM-DD (inclusive)." };
const toDate: Prop = { type: "string", description: "End date YYYY-MM-DD (inclusive). Omit for the latest sample date." };

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "data_overview",
    description: "What data the dashboard holds: date range, latest reporting week, isolate and patient counts, wards, organisms, antibiotics, markers. Call first when unsure what exists or which period is current.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "resistance_rate",
    description: "% resistant for one organism–antibiotic combination in one ward (or all) over a rolling window, exactly as on the Ward resistance page, with n tested, Wilson 95% CI, reportability (n ≥ 30) and EUCAST applicability.",
    parameters: { type: "object", properties: { organism, antibiotic, ward, end_date: endDate, window_weeks: windowWeeks, uncomplicated_uti: uti }, required: ["organism", "antibiotic"] },
  },
  {
    name: "compare_wards",
    description: "% resistant for one organism–antibiotic combination in every ward side by side (one column of the Ward resistance table), each with n, CI and reportability.",
    parameters: { type: "object", properties: { organism, antibiotic, end_date: endDate, window_weeks: windowWeeks, uncomplicated_uti: uti }, required: ["organism", "antibiotic"] },
  },
  {
    name: "resistance_trend",
    description: "How % resistant changed week by week (rolling window) for one organism–antibiotic in one ward or all wards, with first/last reportable values and the change in percentage points.",
    parameters: {
      type: "object",
      properties: { organism, antibiotic, ward, window_weeks: windowWeeks, last_n_weeks: { type: "integer", description: "How many recent weeks to cover (4–104). Omit for 26." }, uncomplicated_uti: uti },
      required: ["organism", "antibiotic"],
    },
  },
  {
    name: "marker_rates",
    description: "ESBL, MRSA, VRE and CPE: positive first isolates, total first isolates and % for a ward and/or organism over a date range (default: the last 28 days of data, as in the Hospital atlas).",
    parameters: { type: "object", properties: { ward, organism, from_date: fromDate, to_date: toDate } },
  },
  {
    name: "ward_snapshot",
    description: "Hospital atlas on a date: estimated patients currently in each ward, marker-positive patients, organisms involved, and 28-day marker rates. Occupancy is an estimate from culture episodes.",
    parameters: { type: "object", properties: { ward, as_of: { type: "string", description: "Date YYYY-MM-DD. Omit for the latest sample date." } } },
  },
  {
    name: "count_isolates",
    description: "Count isolates matching filters, optionally grouped (by ward, organism, specimen, month, onset or marker). Use for 'how many' questions.",
    parameters: {
      type: "object",
      properties: {
        ward, organism,
        specimen: { type: "string", description: "urine, blood or wound. Omit for all.", enum: ["urine", "blood", "wound"] },
        from_date: fromDate, to_date: toDate,
        group_by: { type: "string", description: "Optional grouping.", enum: ["ward", "organism", "specimen", "month", "onset", "marker"] },
        first_isolates_only: { type: "boolean", description: "Count only the first isolate per patient, organism and specimen. Omit for false (all isolates)." },
      },
    },
  },
  {
    name: "cluster_scan",
    description: "Run the Cluster detection page's space-time scan (deterministic) and return candidate clusters with observed/expected cases, relative risk and p-value. Defaults match the page.",
    parameters: {
      type: "object",
      properties: {
        organism,
        case_definition: { type: "string", description: 'What counts as a case: "esbl", "mrsa", "vre", "cpe", "all" (any isolate), or an antibiotic name/code for resistance to it. Omit for esbl.' },
        model: { type: "string", description: "stp = space-time permutation (default); bernoulli = cases vs non-cases.", enum: ["stp", "bernoulli"] },
        study_weeks: { type: "integer", description: "Study period in weeks: 26, 52, 104 or 156. Omit for 52." },
        max_cluster_weeks: { type: "integer", description: "Maximum cluster length in weeks: 2, 4, 8 or 13. Omit for 4." },
        scan_type: { type: "string", description: "prospective (ongoing clusters, default) or retrospective.", enum: ["prospective", "retrospective"] },
      },
    },
  },
  {
    name: "list_alerts",
    description: "Recent entries of the alerts feed: local alerts (staff posts, cluster detections, automatic flags) and AMR-relevant ECDC announcements, with dates, severity and links.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", description: "Optional filter.", enum: ["all", "local", "ecdc"] },
        limit: { type: "integer", description: "How many entries (1–20). Omit for 10." },
      },
    },
  },
  {
    name: "antibiotic_guidance",
    description: "EUCAST-based applicability of antibiotics for an organism as used by the dashboard (applicable, expected resistant, screen only, UTI only, review, unsupported) with the reason. Surveillance logic, not prescribing advice.",
    parameters: { type: "object", properties: { organism, antibiotic: { ...antibiotic, description: "Optional: one antibiotic; omit for all." }, uncomplicated_uti: uti }, required: ["organism"] },
  },
  {
    name: "search_methods",
    description: "Look up how the dashboard calculates things and the evidence behind it (first-isolate rule, 30-isolate minimum, confidence intervals, EUCAST applicability, onset definition, occupancy estimate, cluster statistics, interpretation steps). Returns text with citable sources.",
    parameters: { type: "object", properties: { query: { type: "string", description: "The methods question in plain words." } }, required: ["query"] },
  },
];

export const TOOL_NAMES = new Set(TOOL_SPECS.map((t) => t.name));
