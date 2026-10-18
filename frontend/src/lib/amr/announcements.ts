import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/** One ECDC RSS item, as stored by the announcements checker (api.announcements). */
export type Announcement = {
  id: number;
  title: string;
  url: string;
  published: string | null;
  firstDetected: string;
  summary: string;
  category: "relevant" | "review" | "unrelated";
  terms: string[];
  feed: string;
};

export type AnnouncementState = {
  status: "loading" | "ready" | "error";
  items: Announcement[];
  lastCheck: string | null; // last successful check, from bench.import_runs via api.external_sources
  attribution: string;
  error?: string;
};

const SOURCE = "ecdc_rss";
const category = (c: string | null): Announcement["category"] => (c === "relevant" || c === "review" ? c : "unrelated");

/** Reads the announcements and the last successful check. Kept apart from the main store: a failure here must not hide the surveillance data. */
export async function loadAnnouncements(): Promise<Omit<AnnouncementState, "status">> {
  const api = supabase.schema("api");
  const [rows, source] = await Promise.all([
    api
      .from("announcements")
      .select("announcement_id, title, article_url, published_at, first_detected_at, summary, relevance_category, matched_terms, feed_name, attribution")
      .eq("source_id", SOURCE)
      .order("published_at", { ascending: false, nullsFirst: false })
      .limit(1000),
    api.from("external_sources").select("last_import_at, attribution").eq("source_id", SOURCE).maybeSingle(),
  ]);
  if (rows.error) throw new Error(rows.error.message);
  if (source.error) throw new Error(source.error.message);
  return {
    items: (rows.data ?? []).map((r) => ({
      id: r.announcement_id ?? 0,
      title: r.title ?? "",
      url: r.article_url ?? "",
      published: r.published_at,
      firstDetected: r.first_detected_at ?? "",
      summary: r.summary ?? "",
      category: category(r.relevance_category),
      terms: Array.isArray(r.matched_terms) ? r.matched_terms.filter((t): t is string => typeof t === "string") : [],
      feed: r.feed_name ?? "",
    })),
    lastCheck: source.data?.last_import_at ?? null,
    attribution: source.data?.attribution ?? "Source: ECDC",
  };
}

export function useAnnouncements(): AnnouncementState {
  const [state, setState] = useState<AnnouncementState>({ status: "loading", items: [], lastCheck: null, attribution: "" });
  useEffect(() => {
    let live = true;
    loadAnnouncements()
      .then((d) => live && setState({ status: "ready", ...d }))
      .catch((e: unknown) => live && setState({ status: "error", items: [], lastCheck: null, attribution: "", error: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, []);
  return state;
}

/** Hours since the last successful check, or null when there has been none. */
export function hoursSince(iso: string | null, now = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, (now - t) / 3_600_000) : null;
}
