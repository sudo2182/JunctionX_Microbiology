import { afterEach, describe, expect, it, vi } from "vitest";
import { assistantStep, AssistantError, SYSTEM_PROMPT, type Content } from "@/lib/assistant/gemini.server";

const reply = (parts: Content["parts"], status = 200) =>
  new Response(JSON.stringify(status === 200 ? { candidates: [{ content: { role: "model", parts } }] } : { error: { message: "quota" } }), { status });

const history: Content[] = [
  { role: "user", parts: [{ text: "E. coli ceftriaxone in ICU?" }] },
  { role: "model", parts: [{ functionCall: { name: "resistance_rate", args: { organism: "E. coli" } }, thoughtSignature: "sig" }] },
  { role: "user", parts: [{ functionResponse: { name: "resistance_rate", response: { percent_resistant: 20, tested: 35 } } }] },
];

afterEach(() => vi.unstubAllGlobals());

describe("assistantStep", () => {
  it("sends the fixed system prompt and tools, with the key in a header (never the URL)", async () => {
    const fetchMock = vi.fn(async () => reply([{ text: "20% resistant (n=35)." }]));
    vi.stubGlobal("fetch", fetchMock);
    const out = await assistantStep(history, "test-key", "gemini-test");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
    expect(url).not.toContain("test-key");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
    const body = JSON.parse(init.body as string);
    expect(body.systemInstruction.parts[0].text).toBe(SYSTEM_PROMPT);
    expect(body.tools[0].functionDeclarations.length).toBeGreaterThan(5);
    expect(body.contents[1].parts[0].thoughtSignature).toBe("sig");
    expect(out).toEqual({ turns: [{ role: "model", parts: [{ text: "20% resistant (n=35)." }] }], unverified: [] });
  });

  it("asks once for a correction when the answer contains a figure no tool returned", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply([{ text: "About 47.3% are resistant." }]))
      .mockResolvedValueOnce(reply([{ text: "20% are resistant (n=35)." }]));
    vi.stubGlobal("fetch", fetchMock);
    const out = await assistantStep(history, "k", "m");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(retryBody.contents.at(-1).parts[0].text).toContain("47.3");
    expect(out.turns).toHaveLength(3);
    expect(out.unverified).toEqual([]);
  });

  it("reports figures that are still unverified after the correction", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply([{ text: "About 47.3% are resistant." }])));
    expect((await assistantStep(history, "k", "m")).unverified).toEqual(["47.3"]);
  });

  it("passes tool calls straight back without a grounding check", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply([{ functionCall: { name: "compare_wards", args: {} } }])));
    const out = await assistantStep(history, "k", "m");
    expect(out.turns[0].parts[0].functionCall?.name).toBe("compare_wards");
  });

  it("refuses tools that are not declared", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply([{ functionCall: { name: "run_sql", args: {} } }])));
    await expect(assistantStep(history, "k", "m")).rejects.toThrow("unknown tool");
  });

  it("retries a temporary high-demand error and then succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply([], 503))
      .mockResolvedValueOnce(reply([{ text: "20% resistant (n=35)." }]));
    vi.stubGlobal("fetch", fetchMock);
    const pending = assistantStep(history, "k", "m");
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).turns[0].parts[0].text).toContain("20%");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("gives up with a friendly message if Gemini stays busy", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => reply([], 503)));
    const pending = assistantStep(history, "k", "m");
    const check = expect(pending).rejects.toThrow("busy");
    await vi.advanceTimersByTimeAsync(11_000);
    await check;
    vi.useRealTimers();
  });

  it("explains quota errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply([], 429)));
    await expect(assistantStep(history, "k", "m")).rejects.toBeInstanceOf(AssistantError);
  });
});
