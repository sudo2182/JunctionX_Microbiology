import { supabase } from "@/integrations/supabase/client";

/** culture_requests is not in the generated Database types yet; use a loosely typed handle. */
type Loose = {
  from: (t: string) => {
    select: (c?: string) => any;
    insert: (r: object) => any;
    update: (r: object) => { eq: (c: string, v: string) => PromiseLike<{ error: { message: string } | null }> };
  };
};
const db = () => supabase as unknown as Loose;

export type CultureRequest = {
  id: string;
  culture_id: string;
  requester_id: string;
  patient_id: string;
  sex: string;
  age_years: number;
  sample_date: string;
  admission_date: string | null;
  ward_code: string;
  specimen: string;
  suspected_organism: string | null;
  note: string | null;
  status: "pending" | "completed";
  result_organism: string | null;
  result_markers: number;
  result_susceptibility: string;
  result_note: string | null;
  created_at: string;
  completed_at: string | null;
};

export type NewCultureRequest = {
  culture_id: string;
  patient_id: string;
  sex: string;
  age_years: number;
  sample_date: string;
  admission_date?: string | undefined;
  ward_code: string;
  specimen: string;
  suspected_organism?: string | undefined;
  note?: string | undefined;
};

export async function sendCultureRequest(userId: string, r: NewCultureRequest) {
  const { error } = await db().from("culture_requests").insert({
    ...r,
    admission_date: r.admission_date || null,
    suspected_organism: r.suspected_organism || null,
    note: r.note || null,
    requester_id: userId,
  });
  if (error) throw new Error(error.message);
}

export async function myCultureRequests(userId: string): Promise<CultureRequest[]> {
  const { data, error } = await db()
    .from("culture_requests")
    .select("*")
    .eq("requester_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as CultureRequest[];
}

export async function waitingCultures(): Promise<CultureRequest[]> {
  const { data, error } = await db()
    .from("culture_requests")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as CultureRequest[];
}

export type IsolateResult = { organism: string; markers: number; susceptibility: string };

/** Lab completes a request: one record_submissions row per organism found in the culture. */
export async function completeCultureRequest(req: CultureRequest, isolates: IsolateResult[], note?: string) {
  if (!isolates.length) throw new Error("Add at least one organism");
  const base = {
    patient_id: req.patient_id,
    sex: req.sex,
    age_years: req.age_years,
    sample_date: req.sample_date,
    admission_date: req.admission_date,
    ward_code: req.ward_code,
    specimen: req.specimen,
    note: [`culture ${req.culture_id}`, note].filter(Boolean).join(" · "),
    source: "lab",
  };
  const batch_id = crypto.randomUUID();
  const { error: insError } = await db()
    .from("record_submissions")
    .insert(isolates.map((i) => ({ ...base, batch_id, organism: i.organism, markers: i.markers, susceptibility: i.susceptibility })));
  if (insError) throw new Error(insError.message);
  const { error } = await db()
    .from("culture_requests")
    .update({
      status: "completed",
      result_organism: isolates.map((i) => i.organism).join(", "),
      result_markers: isolates.reduce((m, i) => m | i.markers, 0),
      result_susceptibility: isolates.map((i) => `${i.organism}=${i.susceptibility}`).join(" | "),
      result_note: note || null,
      completed_at: new Date().toISOString(),
    })
    .eq("id", req.id);
  if (error) throw new Error(error.message);
}

export type CultureChange =
  | { eventType: "INSERT" | "UPDATE"; new: Partial<CultureRequest> }
  | { eventType: "DELETE"; old: Partial<CultureRequest> };

/**
 * Applies one realtime change to the lab's waiting list: pending requests are added or refreshed, anything
 * that left "pending" (completed by any lab user) or was deleted is removed. Oldest first, like the query.
 */
export function applyWaitingChange(list: CultureRequest[], change: CultureChange): CultureRequest[] {
  if (change.eventType === "DELETE") return change.old.id ? list.filter((r) => r.id !== change.old.id) : list;
  const row = change.new as CultureRequest;
  if (!row.id) return list;
  const rest = list.filter((r) => r.id !== row.id);
  if (row.status !== "pending") return rest;
  return [...rest, row].sort((a, b) => a.created_at.localeCompare(b.created_at));
}
