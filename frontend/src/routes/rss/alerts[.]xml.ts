import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { FEED_LIMIT, renderAlertsRss, type AlertRow } from "@/lib/amr/alert-rss";

/**
 * GET /rss/alerts.xml — public RSS feed of the alerts posted from the dashboard (no sign-in needed).
 * Reads public.news_items with the publishable key, which may only read that table (row-level security).
 * Cached briefly at the edge so a busy feed reader cannot hammer the database.
 */
export const Route = createFileRoute("/rss/alerts.xml")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = process.env["SUPABASE_URL"];
        const key = process.env["SUPABASE_PUBLISHABLE_KEY"];
        if (!url || !key) return new Response("Feed not configured: SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY missing.", { status: 503 });
        const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
        const { data, error } = await supabase
          .from("news_items")
          .select("id, title, summary, url, region, organism, severity, alert_date, source, posted_at")
          .order("posted_at", { ascending: false })
          .limit(FEED_LIMIT);
        if (error) {
          console.error("[rss] news_items:", error.message);
          return new Response("The alert feed is temporarily unavailable.", { status: 502, headers: { "cache-control": "no-store" } });
        }
        const body = renderAlertsRss((data ?? []) as AlertRow[], { siteUrl: new URL(request.url).origin });
        return new Response(body, {
          headers: {
            "content-type": "application/rss+xml; charset=utf-8",
            "cache-control": "public, max-age=60, s-maxage=60, stale-while-revalidate=300",
            "access-control-allow-origin": "*",
          },
        });
      },
    },
  },
});
