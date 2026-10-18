import { TOOL_NAMES, TOOL_SPECS } from "./tool-specs";
import { corpusNumbers, ungroundedNumbers } from "./grounding";

/**
 * Server-only: talks to the Gemini API with the key from the environment. The system prompt and the tool
 * list are fixed here; the browser only supplies the conversation and its tool results.
 */

export type Part = {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  thoughtSignature?: string;
  thought?: boolean;
};
export type Content = { role: "user" | "model"; parts: Part[] };

export const DEFAULT_MODEL = "gemini-3.8-flash";

export const SYSTEM_PROMPT = `You are the AMR Watch assistant inside an antimicrobial-resistance surveillance dashboard used by hospital doctors and laboratory staff. The data is the synthetic TYKS dataset, not real patients.

Rules:
1. Every number you state must come from a tool result in this conversation (or the user's message). Never estimate, recall from memory or compute new statistics (no differences, averages or ratios of your own). If you need a figure, call a tool. If no tool provides it, say the dashboard cannot answer that.
2. With every percentage give n tested and, when provided, the 95% confidence interval. If a result is not reportable, say there were too few isolates (give n) instead of a percentage.
3. When the user does not specify a period, use the tool defaults (latest reporting week, 4-week window) and say which period you used.
4. A significant cluster or rising trend is a statistical signal for review, not a confirmed outbreak. Mention relevant limitations (small n, synthetic data, estimated occupancy).
5. No individual patient treatment advice (drug, dose, duration for a specific patient). Describe what the aggregate data shows and refer to local guidelines, the laboratory report and the infection/stewardship team.
6. For "how/why/what does this mean/what should I do" questions, call search_methods and base the explanation and steps on it. Cite only sources returned by tools, as markdown links [label](url). Never invent references.
7. Each tool result has an evidence link; end with "Check it:" and those links as markdown, e.g. [Ward resistance · ICU](/wards?ward=ICU&date=2026-09-21).
8. If a tool returns an error, fix the input (e.g. pick the organism the user meant) or ask the user to clarify. Do not guess values.

Style: answer first in one or two sentences, then key figures as a short bullet list, then caveats, then "Check it:". Plain English, concise. Use markdown bold, bullets and links only.`;

const CORRECTION = (bad: string[]) =>
  `Your answer contains figures that do not appear in any tool result: ${bad.join(", ")}. Rewrite the answer using only numbers from the tool results above (call another tool if you need a figure). Do not explain the correction.`;

export class AssistantError extends Error {
  constructor(message: string, readonly status: number, readonly retryable = false) {
    super(message);
  }
}

const RETRY_STATUSES = new Set([500, 503, 504]);
const RETRY_DELAYS_MS = [1000, 3000, 6000];

/** Gemini sometimes answers "high demand" (503) for a few seconds; retry those instead of failing the question. */
async function generate(contents: Content[], key: string, model: string): Promise<Content> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await generateOnce(contents, key, model);
    } catch (e) {
      const retryable = e instanceof AssistantError && e.retryable && attempt < RETRY_DELAYS_MS.length;
      if (!retryable) throw e;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
}

async function generateOnce(contents: Content[], key: string, model: string): Promise<Content> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      tools: [{ functionDeclarations: TOOL_SPECS }],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      generationConfig: { maxOutputTokens: 4096 },
    }),
  });
  const body = (await res.json().catch(() => null)) as {
    candidates?: { content?: Content; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
    error?: { message?: string; status?: string };
  } | null;
  if (!res.ok) {
    const msg = body?.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 429) throw new AssistantError("The Gemini quota or rate limit was reached. Wait a minute and try again.", 429);
    if (res.status === 400 || res.status === 404) throw new AssistantError(`Gemini rejected the request (${model}): ${msg}`, 502);
    if (res.status === 401 || res.status === 403) throw new AssistantError("Gemini refused the API key. Check GEMINI_API_KEY.", 502);
    if (RETRY_STATUSES.has(res.status)) throw new AssistantError("Gemini is busy right now (high demand). Try again in a minute.", 503, true);
    throw new AssistantError(`Gemini error: ${msg}`, 502);
  }
  const content = body?.candidates?.[0]?.content;
  if (!content?.parts?.length) {
    const reason = body?.promptFeedback?.blockReason ?? body?.candidates?.[0]?.finishReason ?? "no content";
    throw new AssistantError(`Gemini returned no answer (${reason}).`, 502);
  }
  return { role: "model", parts: content.parts };
}

const answerText = (c: Content) => c.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("\n");
const callsIn = (c: Content) => c.parts.filter((p) => p.functionCall);

/** Text the answer may draw numbers from: tool results and the user's own messages. */
function groundingSources(contents: Content[]): number[] {
  const texts: string[] = [];
  for (const c of contents)
    for (const p of c.parts) {
      if (p.functionResponse) texts.push(JSON.stringify(p.functionResponse.response));
      if (c.role === "user" && p.text) texts.push(p.text);
      if (p.functionCall) texts.push(JSON.stringify(p.functionCall.args ?? {}));
    }
  return corpusNumbers(texts);
}

/**
 * One assistant step. Returns the new turns to append to the conversation: either a model turn with tool calls
 * for the browser to run, or a final answer that passed the grounding check. One automatic correction is
 * attempted; figures still unmatched are reported. All turns are returned (not just the last) because Gemini
 * validates the thought signatures of tool calls against the exact history that produced them.
 */
export async function assistantStep(contents: Content[], key: string, model: string): Promise<{ turns: Content[]; unverified: string[] }> {
  const first = await generate(contents, key, model);
  for (const p of callsIn(first)) if (!TOOL_NAMES.has(p.functionCall!.name)) throw new AssistantError(`The model asked for an unknown tool (${p.functionCall!.name}).`, 502);
  if (callsIn(first).length) return { turns: [first], unverified: [] };

  const sources = groundingSources(contents);
  const bad = ungroundedNumbers(answerText(first), sources);
  if (!bad.length) return { turns: [first], unverified: [] };

  const correction: Content = { role: "user", parts: [{ text: CORRECTION(bad) }] };
  const retry = await generate([...contents, first, correction], key, model);
  for (const p of callsIn(retry)) if (!TOOL_NAMES.has(p.functionCall!.name)) throw new AssistantError(`The model asked for an unknown tool (${p.functionCall!.name}).`, 502);
  const turns = [first, correction, retry];
  if (callsIn(retry).length) return { turns, unverified: [] };
  return { turns, unverified: ungroundedNumbers(answerText(retry), sources) };
}
