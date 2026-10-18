import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { applyWaitingChange, waitingCultures, type CultureChange, type CultureRequest } from "./cultures";

export type Connection = "connecting" | "live" | "offline";

const POLL_MS = 30_000;

/**
 * The lab's waiting list, kept current from Supabase: realtime changes on culture_requests (row-level security
 * lets only lab accounts see every request) plus a 30-second refresh as a safety net if the socket drops.
 */
export function useLabWorklist() {
  const [waiting, setWaiting] = useState<CultureRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const known = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    try {
      const rows = await waitingCultures();
      rows.forEach((r) => known.current.add(r.id));
      setWaiting(rows);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const channel = supabase
      .channel(`lab-worklist-${crypto.randomUUID()}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "culture_requests" }, (payload) => {
        const change = payload as unknown as CultureChange;
        if (change.eventType === "INSERT" && change.new.status === "pending" && change.new.id && !known.current.has(change.new.id)) {
          known.current.add(change.new.id);
          toast.info(`New culture request ${change.new.culture_id ?? ""} from ${change.new.ward_code ?? "a ward"}`);
        }
        setWaiting((list) => applyWaitingChange(list, change));
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          setConnection("live");
          void refresh(); // catch anything sent while (re)connecting
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") setConnection("offline");
      });
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      window.clearInterval(timer);
      void supabase.removeChannel(channel);
    };
  }, [refresh]);

  return { waiting, loading, error, connection, refresh };
}
