import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { AssistantError, DEFAULT_MODEL, assistantStep, type Content } from "@/lib/assistant/gemini.server";

/**
 * POST /api/assistant — one step of the assistant conversation.
 * Only signed-in users with a dashboard role may call it; the Gemini key stays on the server.
 */

const part = z
  .object({
    text: z.string().max(20_000).optional(),
    functionCall: z.object({ name: z.string().max(64), args: z.record(z.unknown()).optional() }).optional(),
    functionResponse: z.object({ name: z.string().max(64), response: z.record(z.unknown()) }).optional(),
    thoughtSignature: z.string().max(100_000).optional(),
    thought: z.boolean().optional(),
  })
  .strict();
const body = z.object({
  contents: z.array(z.object({ role: z.enum(["user", "model"]), parts: z.array(part).min(1).max(24) })).min(1).max(80),
});

const MAX_BODY_BYTES = 600_000;
const RATE = { requests: 40, perMs: 5 * 60_000 };
// Best effort: per server instance, which is enough to stop a runaway loop from burning the quota.
const recent = new Map<string, number[]>();

function rateLimited(userId: string): boolean {
  const now = Date.now();
  const hits = (recent.get(userId) ?? []).filter((t) => now - t < RATE.perMs);
  hits.push(now);
  recent.set(userId, hits);
  return hits.length > RATE.requests;
}

const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** Verifies the Supabase session token and that the user holds a dashboard role. */
async function authorise(request: Request): Promise<string> {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"];
  if (!url || !key) throw new AssistantError("Server is missing SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY.", 500);
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (token.split(".").length !== 3) throw new AssistantError("Sign in to use the assistant.", 401);
  const supabase = createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // getClaims throws (rather than returning an error) on some malformed tokens; both mean "not signed in".
  const claims = await supabase.auth.getClaims(token).catch(() => null);
  const userId = claims?.data?.claims?.sub;
  if (!claims || claims.error || !userId) throw new AssistantError("Your session has expired. Sign in again.", 401);
  const roles = await (supabase as unknown as { from: (t: string) => { select: (c: string) => { eq: (c: string, v: string) => PromiseLike<{ data: unknown[] | null }> } } })
    .from("user_roles").select("role").eq("user_id", userId);
  if (!roles.data?.length) throw new AssistantError("Your account has no dashboard access.", 403);
  return userId;
}

export const Route = createFileRoute("/api/assistant")({
  server: {
    handlers: {
      GET: () => json(405, { error: "Use POST." }),
      POST: async ({ request }) => {
        try {
          const userId = await authorise(request);
          const apiKey = process.env["GEMINI_API_KEY"];
          if (!apiKey) return json(503, { error: "The assistant is not configured yet: GEMINI_API_KEY is missing on the server." });
          if (rateLimited(userId)) return json(429, { error: "Too many questions in a short time. Wait a few minutes." });

          const raw = await request.text();
          if (raw.length > MAX_BODY_BYTES) return json(413, { error: "The conversation is too long. Start a new one." });
          const parsed = body.safeParse(JSON.parse(raw || "null"));
          if (!parsed.success) return json(400, { error: "Malformed conversation." });

          const model = process.env["GEMINI_MODEL"] || DEFAULT_MODEL;
          const step = await assistantStep(parsed.data.contents as Content[], apiKey, model);
          return json(200, { ...step, model });
        } catch (e) {
          if (e instanceof AssistantError) return json(e.status, { error: e.message });
          if (e instanceof SyntaxError) return json(400, { error: "Malformed request." });
          console.error("[assistant]", e instanceof Error ? e.message : e);
          return json(500, { error: "The assistant failed unexpectedly." });
        }
      },
    },
  },
});
