import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "@tanstack/react-router";
import { Bot, Database, RotateCcw, Send, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownLite } from "@/components/amr/markdown-lite";
import { supabase } from "@/integrations/supabase/client";
import { useAmr } from "@/lib/amr/store";
import { loadAnnouncements, type Announcement } from "@/lib/amr/announcements";
import { ask, TOOL_LABELS, type Content, type StepResponse, type ToolUse } from "@/lib/assistant/client";
import type { Evidence } from "@/lib/assistant/tools";

type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; unverified: string[]; evidence: Evidence[]; tools: ToolUse[] }
  | { role: "error"; text: string };

const SUGGESTIONS = [
  "What is E. coli resistance to ceftriaxone in the ICU right now?",
  "Compare wards for Klebsiella pneumoniae and meropenem",
  "Is there an ESBL cluster anywhere in the last year?",
  "Why do some cells show n= instead of a percentage?",
  "What are the latest alerts?",
];

async function post(contents: Content[]): Promise<StepResponse> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session has ended. Sign in again.");
  const res = await fetch("/api/assistant", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ contents }),
  });
  const body = (await res.json().catch(() => null)) as (StepResponse & { error?: string }) | null;
  if (!res.ok || !body) throw new Error(body?.error ?? `The assistant is unavailable (HTTP ${res.status}).`);
  return body;
}

/** Floating "Ask AMR Watch" chat. Answers are computed from the dashboard data already loaded in the browser. */
export function Assistant() {
  const { status, records, stays, alerts } = useAmr();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<Content[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const announcements = useRef<Promise<Announcement[]> | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages, busy]);

  const send = async (question: string) => {
    const q = question.trim().slice(0, 2000);
    if (!q || busy) return;
    if (status !== "ready") {
      setMessages((m) => [...m, { role: "error", text: "The dashboard data is still loading. Try again in a moment." }]);
      return;
    }
    setInput("");
    setMessages((m) => [...m, { role: "user", text: q }]);
    setBusy("Thinking…");
    try {
      const ctx = {
        records, stays, alerts,
        announcements: () => (announcements.current ??= loadAnnouncements().then((r) => r.items)),
      };
      const answer = await ask(history, q, ctx, post, setBusy);
      setHistory(answer.history);
      setMessages((m) => [...m, { role: "assistant", text: answer.text, unverified: answer.unverified, evidence: answer.evidence, tools: answer.tools }]);
    } catch (e) {
      setMessages((m) => [...m, { role: "error", text: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setBusy(null);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };

  const reset = () => {
    setHistory([]);
    setMessages([]);
  };

  if (!open)
    return (
      <Button className="fixed bottom-4 right-4 z-40 gap-2 shadow-lg" onClick={() => setOpen(true)}>
        <Bot className="h-4 w-4" /> Ask AMR Watch
      </Button>
    );

  return (
    <section
      aria-label="AMR Watch assistant"
      className="fixed bottom-4 right-4 z-40 flex h-[min(680px,calc(100vh-6rem))] w-[min(440px,calc(100vw-2rem))] flex-col rounded-lg border bg-card shadow-xl"
    >
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Bot className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">Ask AMR Watch</h2>
        <div className="ml-auto flex gap-1">
          <Button variant="ghost" size="icon" onClick={reset} disabled={!!busy || !messages.length} aria-label="New conversation" title="New conversation">
            <RotateCcw className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => setOpen(false)} aria-label="Close assistant">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div ref={scroller} className="flex-1 space-y-3 overflow-y-auto p-3" aria-live="polite">
        {messages.length === 0 && (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Ask about resistance rates, wards, trends, clusters, alerts or how a number is calculated. Every figure comes from the dashboard's data, with a link to check it.
            </p>
            <div className="flex flex-col gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="rounded-md border px-3 py-2 text-left text-xs hover:border-primary" onClick={() => void send(s)} disabled={!!busy}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="ml-8 rounded-lg bg-primary/10 px-3 py-2 text-sm">{m.text}</div>
          ) : m.role === "error" ? (
            <div key={i} role="alert" className="flex gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-2 text-sm">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" /> {m.text}
            </div>
          ) : (
            <div key={i} className="mr-4 space-y-2 rounded-lg border bg-background px-3 py-2">
              <MarkdownLite text={m.text} />
              {m.unverified.length > 0 && (
                <div className="flex gap-2 rounded border border-warning bg-warning/15 p-2 text-xs">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                  <span>Not found in the data looked up: {m.unverified.join(", ")}. Treat these figures as unverified and check the linked page.</span>
                </div>
              )}
              {m.tools.length > 0 && (
                <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                  <Database className="h-3 w-3" /> Data used:
                  {m.tools.map((t, j) => (
                    <span key={j} className={`rounded border px-1.5 py-0.5 ${t.error ? "border-destructive/50" : ""}`} title={t.error ?? JSON.stringify(t.args)}>
                      {TOOL_LABELS[t.name] ?? t.name}
                    </span>
                  ))}
                </div>
              )}
              {m.evidence.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {m.evidence.map((e) => (
                    <Button key={e.href} size="sm" variant="outline" className="h-7 text-xs" onClick={() => router.history.push(e.href)}>
                      {e.label}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          ),
        )}
        {busy && <div className="text-xs text-muted-foreground">{busy}</div>}
      </div>

      <form onSubmit={submit} className="border-t p-2">
        <div className="flex gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            placeholder={status === "ready" ? "Ask a question about the data…" : "Loading dashboard data…"}
            maxLength={2000}
            rows={2}
            className="min-h-0 resize-none text-sm"
            aria-label="Question"
          />
          <Button type="submit" size="icon" disabled={!!busy || !input.trim()} aria-label="Send">
            <Send className="h-4 w-4" />
          </Button>
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">Synthetic data · Answers use only the dashboard's figures · Not treatment advice</p>
      </form>
    </section>
  );
}
