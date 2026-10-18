import { getData } from "@/lib/data";

export async function ReplayBanner() {
  const data = getData();
  const s = await data.replayStatus();
  const updated = s.last_run_at
    ? new Date(s.last_run_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })
    : null;
  return (
    <div className="flex items-center gap-2 text-sm text-ink-2" title={`Replay cursor at week ${s.cursor_week_idx} of 156`}>
      <span
        className={`inline-block h-2 w-2 rounded-full ${s.run_status === "failed" ? "bg-critical" : "bg-good"}`}
        aria-hidden
      />
      <span>
        Data through <strong className="text-ink">{s.cursor_label}</strong>
        {updated && <> · updated {updated}</>} · <span className="num">{s.isolates_this_week}</span> isolates this week
      </span>
      {data.kind === "mock" && (
        <span className="rounded border border-line px-1.5 py-0.5 text-xs text-muted" title="No Supabase keys set; reading local mock data">
          mock data
        </span>
      )}
    </div>
  );
}
