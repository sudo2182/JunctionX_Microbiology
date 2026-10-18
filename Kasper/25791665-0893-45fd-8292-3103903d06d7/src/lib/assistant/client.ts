import { runTool, type Evidence, type ToolContext } from "./tools";

/** Gemini conversation turns as exchanged with /api/assistant (kept verbatim, including thought signatures). */
export type Part = {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  thoughtSignature?: string;
  thought?: boolean;
};
export type Content = { role: "user" | "model"; parts: Part[] };
export type StepResponse = { turns: Content[]; unverified: string[] };
export type ToolUse = { name: string; args: Record<string, unknown>; error?: string };

export type Answer = {
  history: Content[];
  text: string;
  unverified: string[];
  evidence: Evidence[];
  tools: ToolUse[];
};

export const MAX_STEPS = 8;

export const TOOL_LABELS: Record<string, string> = {
  data_overview: "Data overview",
  resistance_rate: "Resistance rate",
  compare_wards: "Ward comparison",
  resistance_trend: "Resistance trend",
  marker_rates: "Marker rates",
  ward_snapshot: "Hospital atlas",
  count_isolates: "Isolate counts",
  cluster_scan: "Cluster scan",
  list_alerts: "Alerts feed",
  antibiotic_guidance: "EUCAST applicability",
  search_methods: "Methods & evidence",
};

const textOf = (c: Content) => c.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("\n").trim();

/**
 * Asks one question: the server decides which tools to call, the browser runs them on the loaded dashboard data
 * and sends the results back, until the model answers. The previous history is only replaced on success.
 */
export async function ask(
  history: Content[],
  question: string,
  ctx: ToolContext,
  post: (contents: Content[]) => Promise<StepResponse>,
  onProgress?: (label: string) => void,
): Promise<Answer> {
  let h: Content[] = [...history, { role: "user", parts: [{ text: question }] }];
  const evidence: Evidence[] = [];
  const tools: ToolUse[] = [];
  for (let step = 0; step < MAX_STEPS; step++) {
    onProgress?.(step === 0 ? "Thinking…" : "Writing the answer…");
    const res = await post(h);
    if (!res.turns.length) throw new Error("The assistant returned nothing.");
    h = [...h, ...res.turns];
    const last = res.turns[res.turns.length - 1];
    const calls = last.parts.filter((p) => p.functionCall);
    if (!calls.length) {
      const unique = evidence.filter((e, i) => evidence.findIndex((x) => x.href === e.href) === i);
      return { history: h, text: textOf(last) || "(No answer was returned.)", unverified: res.unverified, evidence: unique, tools };
    }
    const responses: Part[] = [];
    for (const c of calls) {
      const { name, args = {} } = c.functionCall!;
      onProgress?.(`Looking up: ${TOOL_LABELS[name] ?? name}…`);
      const out = await runTool(name, args, ctx);
      const error = typeof out.result["error"] === "string" ? (out.result["error"] as string) : undefined;
      tools.push({ name, args, ...(error ? { error } : {}) });
      if (out.evidence) evidence.push(out.evidence);
      responses.push({ functionResponse: { name, response: { ...out.result, ...(out.evidence ? { evidence_link: out.evidence } : {}) } } });
    }
    h = [...h, { role: "user", parts: responses }];
  }
  throw new Error("That question needed too many lookups. Try asking something more specific.");
}
