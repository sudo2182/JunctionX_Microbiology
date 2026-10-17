"use client";

import { useEffect, useState } from "react";

type State = { status: "acknowledged" | "dismissed"; note: string; at: string } | null;

const KEY = "amr-watch:alert-status";

function readAll(): Record<string, State> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}

/**
 * Acknowledge / dismiss with a note. The api views are read-only, so this is kept in the viewer's
 * browser until the pipeline exposes a write path for alert status.
 */
export function AckControl({ alertId, compact = false }: { alertId: string; compact?: boolean }) {
  const [state, setState] = useState<State>(null);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setState(readAll()[alertId] ?? null);
  }, [alertId]);

  function save(next: State) {
    try {
      const all = readAll();
      if (next) all[alertId] = next;
      else delete all[alertId];
      localStorage.setItem(KEY, JSON.stringify(all));
    } catch {
      // storage blocked: keep the in-memory state only
    }
    setState(next);
    setOpen(false);
  }

  if (state) {
    return (
      <span className="inline-flex items-center gap-2 text-xs text-ink-2">
        <span className="rounded-full border border-line bg-white px-2 py-0.5 capitalize">{state.status}</span>
        {!compact && state.note && <span className="italic">“{state.note}”</span>}
        <button type="button" className="text-accent hover:underline" onClick={() => save(null)}>
          undo
        </button>
      </span>
    );
  }
  if (compact && !open) {
    return (
      <button type="button" className="text-xs text-accent hover:underline" onClick={() => setOpen(true)}>
        Acknowledge or dismiss
      </button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-xs">
      <input
        className="w-48 rounded border border-line bg-white px-2 py-1"
        placeholder="Note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <button
        type="button"
        className="rounded border border-line bg-white px-2 py-1 hover:bg-black/5"
        onClick={() => save({ status: "acknowledged", note, at: new Date().toISOString() })}
      >
        Acknowledge
      </button>
      <button
        type="button"
        className="rounded border border-line bg-white px-2 py-1 hover:bg-black/5"
        onClick={() => save({ status: "dismissed", note, at: new Date().toISOString() })}
      >
        Dismiss
      </button>
    </span>
  );
}
