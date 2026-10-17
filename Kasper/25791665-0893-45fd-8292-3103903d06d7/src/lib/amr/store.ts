import { useSyncExternalStore } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ANTIBIOTICS, WARDS, daysBetween, setReference, weekIndex } from "./reference";

/** One isolate result, as the laboratory recorded it. */
export type IsolateRecord = {
  id: string;
  patient: string;
  sex: string;
  age: number;
  date: string;
  week: number;
  ward: string;
  specimen: string;
  organism: string;
  flags: number; // bit 1 ESBL, 2 MRSA, 4 VRE, 8 CPE
  sus: string; // one char per antibiotic in ANTIBIOTICS order: S | R | -
  admission: string;
  onset: string;
  setting: string;
  institution: string;
  pending?: boolean; // added from this dashboard, awaiting review
};

/** One culture episode: every sample taken, including those that grew nothing. */
export type StayRecord = {
  id: string;
  patient: string;
  ward: string;
  date: string;
  admission: string;
  institution: string;
  result: string;
  nIsolates: number;
};

export type Alert = {
  id: string;
  title: string;
  summary: string;
  url?: string | undefined;
  region: string;
  organism?: string | undefined;
  severity: "info" | "watch" | "warning";
  date: string;
  source: string;
};

/** What the dashboard is allowed to write. */
export type NewRecord = {
  patient: string;
  sex: string;
  age: number;
  date: string;
  admission?: string | undefined;
  ward: string;
  specimen: string;
  organism: string;
  markers: number;
  sus: string;
  note?: string | undefined;
};

/** Hospital-onset: sample taken on or after the 3rd hospital day (admission day = day 1). */
export function isHospitalOnset(r: Pick<IsolateRecord, "admission" | "date">): boolean {
  return !!r.admission && daysBetween(r.admission, r.date) >= 2;
}

export function abxResult(r: IsolateRecord, code: string): "S" | "R" | "-" {
  const i = ANTIBIOTICS.findIndex((a) => a.code === code);
  return (r.sus[i] ?? "-") as "S" | "R" | "-";
}

const PAGE = 1000; // the data API returns at most this many rows per request
const WAVE = 6; // pages requested at the same time

// Read on every call: ANTIBIOTICS is replaced by the database's list once it loads.
const codes = () => ANTIBIOTICS.map((a) => a.code);

/** "AMP:R,CIP:S" -> fixed-order S/R/- string the analytics modules expect. */
function susString(list: string): string {
  const seen = new Map<string, string>();
  for (const part of (list || "").split(",")) {
    const at = part.indexOf(":");
    if (at > 0) seen.set(part.slice(0, at), part.slice(at + 1));
  }
  return codes().map((c) => (seen.get(c) === "R" ? "R" : seen.get(c) === "S" ? "S" : "-")).join("");
}

/** Fixed-order S/R/- string -> "AMP:R,CIP:S" for storage. */
function susList(sus: string): string {
  return codes().map((c, i) => (sus[i] === "S" || sus[i] === "R" ? `${c}:${sus[i]}` : "")).filter(Boolean).join(",");
}

const wardMeta = (code: string) => WARDS.find((w) => w.code === code);
const careSetting = (code: string) => (code === "ED" ? "ed" : wardMeta(code)?.institution === "primary_care" ? "primary_care" : "inpatient");
const institutionOf = (code: string) => wardMeta(code)?.institution ?? "hospital";

type RecordRow = {
  id: string; patient_id: string; sex: string; age: number; sample_date: string; admission_date: string | null;
  ward: string; specimen: string; organism: string; markers: number; susceptibility: string; onset: string;
  setting: string; institution: string;
};
type StayRow = {
  id: string; patient_id: string; ward: string; institution: string; sample_date: string;
  admission_date: string | null; result: string; n_isolates: number;
};
type SubmissionRow = {
  id: string; patient_id: string; sex: string; age_years: number; sample_date: string; admission_date: string | null;
  ward_code: string; specimen: string; organism: string; markers: number; susceptibility: string;
};
type NewsRow = {
  id: string; title: string; summary: string; url: string | null; region: string; organism: string | null;
  severity: string; alert_date: string; source: string;
};

const toRecord = (r: RecordRow): IsolateRecord => ({
  id: r.id,
  patient: r.patient_id,
  sex: r.sex,
  age: r.age ?? 0,
  date: r.sample_date,
  week: weekIndex(r.sample_date),
  ward: r.ward,
  specimen: r.specimen,
  organism: r.organism,
  flags: r.markers ?? 0,
  sus: susString(r.susceptibility),
  admission: r.admission_date ?? "",
  onset: r.onset || "",
  setting: r.setting || "",
  institution: r.institution || "",
});

const toStay = (r: StayRow): StayRecord => ({
  id: r.id,
  patient: r.patient_id,
  ward: r.ward,
  date: r.sample_date,
  admission: r.admission_date ?? "",
  institution: r.institution || "",
  result: r.result || "",
  nIsolates: r.n_isolates ?? 0,
});

const toSubmitted = (r: SubmissionRow): IsolateRecord => {
  const admission = r.admission_date ?? "";
  return {
    id: r.id,
    patient: r.patient_id,
    sex: r.sex,
    age: r.age_years ?? 0,
    date: r.sample_date,
    week: weekIndex(r.sample_date),
    ward: r.ward_code,
    specimen: r.specimen,
    organism: r.organism,
    flags: r.markers ?? 0,
    sus: susString(r.susceptibility),
    admission,
    onset: isHospitalOnset({ admission, date: r.sample_date }) ? "hospital" : "community",
    setting: careSetting(r.ward_code),
    institution: institutionOf(r.ward_code),
    pending: true,
  };
};

/** A submitted isolate also counts as one positive culture, as addRecords does when it is first saved. */
const toSubmittedStay = (r: IsolateRecord): StayRecord => ({
  id: r.id,
  patient: r.patient,
  ward: r.ward,
  date: r.date,
  admission: r.admission,
  institution: r.institution,
  result: "positive",
  nIsolates: 1,
});

const toAlert = (r: NewsRow): Alert => ({
  id: r.id,
  title: r.title,
  summary: r.summary ?? "",
  url: r.url ?? undefined,
  region: r.region ?? "",
  organism: r.organism ?? undefined,
  severity: (r.severity === "info" || r.severity === "warning" ? r.severity : "watch") as Alert["severity"],
  date: r.alert_date ?? "",
  source: r.source || "news",
});

type Page = { data: unknown[] | null; error: { message: string } | null };

/** Reads a whole table or view in pages — the data API caps every response — WAVE pages at a time. */
async function collect<T>(query: (from: number, to: number) => PromiseLike<Page>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE * WAVE) {
    const pages = await Promise.all(Array.from({ length: WAVE }, (_, k) => query(from + k * PAGE, from + (k + 1) * PAGE - 1)));
    for (const { data, error } of pages) {
      if (error) throw new Error(error.message);
      out.push(...((data ?? []) as T[]));
    }
    if (pages.some((p) => (p.data?.length ?? 0) < PAGE)) return out;
  }
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Wards, antibiotics and organisms from the read-only api.ref_* views (ref.* tables, seeded from the TYKS CSVs). */
async function loadReference() {
  const api = supabase.schema("api");
  const [wards, antibiotics, organisms] = await Promise.all([
    api.from("ref_wards").select("ward_code, ward_en, ward_type, institution"),
    api.from("ref_antibiotics").select("antibiotic_code, antibiotic, class"),
    api.from("ref_organisms").select("name"),
  ]);
  for (const r of [wards, antibiotics, organisms]) if (r.error) throw new Error(r.error.message);
  setReference({
    wards: (wards.data ?? []).flatMap((w) => (w.ward_code ? [{ code: w.ward_code, name: w.ward_en ?? w.ward_code, type: w.ward_type ?? "", institution: w.institution ?? "" }] : [])),
    antibiotics: (antibiotics.data ?? []).flatMap((a) => (a.antibiotic_code ? [{ code: a.antibiotic_code, name: capitalise(a.antibiotic ?? a.antibiotic_code), cls: capitalise(a.class ?? "") }] : [])),
    organisms: (organisms.data ?? []).flatMap((o) => (o.name ? [o.name] : [])),
  });
}

const RECORD_COLS = "id, patient_id, sex, age, sample_date, admission_date, ward, specimen, organism, markers, susceptibility, onset, setting, institution";
const STAY_COLS = "id, patient_id, ward, institution, sample_date, admission_date, result, n_isolates";
const SUB_COLS = "id, patient_id, sex, age_years, sample_date, admission_date, ward_code, specimen, organism, markers, susceptibility";
const NEWS_COLS = "id, title, summary, url, region, organism, severity, alert_date, source";

type State = { status: "idle" | "loading" | "ready" | "error"; records: IsolateRecord[]; stays: StayRecord[]; alerts: Alert[]; error?: string };

let state: State = { status: "idle", records: [], stays: [], alerts: [] };
let pipeline: IsolateRecord[] = [];
let submitted: IsolateRecord[] = [];
let stays: StayRecord[] = [];

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const set = (p: Partial<State>) => {
  state = { ...state, ...p };
  emit();
};
const merge = () => set({ records: [...pipeline, ...submitted], stays: [...stays] });

export function ensureLoaded() {
  if (state.status !== "idle" || typeof window === "undefined") return;
  set({ status: "loading" });
  Promise.all([
    loadReference(),
    collect<RecordRow>((from, to) => supabase.from("records").select(RECORD_COLS).order("sample_date").order("id").range(from, to)),
    collect<StayRow>((from, to) => supabase.from("ward_stays").select(STAY_COLS).order("sample_date").order("id").range(from, to)),
    collect<SubmissionRow>((from, to) => supabase.from("record_submissions").select(SUB_COLS).neq("status", "rejected").order("sample_date").order("id").range(from, to)),
    collect<NewsRow>((from, to) => supabase.from("news_items").select(NEWS_COLS).order("alert_date", { ascending: false }).order("posted_at", { ascending: false }).range(from, to)),
  ])
    // Rows are mapped only after loadReference has resolved, so S/R strings use the database's antibiotic list.
    .then(([, recs, sts, subs, news]) => {
      pipeline = recs.map(toRecord);
      submitted = subs.map(toSubmitted);
      stays = [...sts.map(toStay), ...submitted.map(toSubmittedStay)];
      set({ status: "ready", alerts: news.map(toAlert) });
      merge();
    })
    .catch((e: unknown) => set({ status: "error", error: e instanceof Error ? e.message : String(e) }));
}

const submissionRow = (r: NewRecord) => ({
  patient_id: r.patient,
  sex: r.sex,
  age_years: r.age,
  sample_date: r.date,
  admission_date: r.admission || null,
  ward_code: r.ward,
  specimen: r.specimen,
  organism: r.organism,
  markers: r.markers,
  susceptibility: susList(r.sus),
  note: r.note ?? null,
  source: "dashboard",
});

/** Saves isolate records in the database, then shows them in every chart straight away. */
export async function addRecords(inputs: NewRecord[]): Promise<number> {
  const saved: IsolateRecord[] = [];
  const newStays: StayRecord[] = [];
  for (let i = 0; i < inputs.length; i += 500) {
    const batch = inputs.slice(i, i + 500);
    const { data, error } = await supabase.from("record_submissions").insert(batch.map(submissionRow)).select("id");
    if (error) throw new Error(error.message);
    batch.forEach((input, j) => {
      const id = data?.[j]?.id ?? crypto.randomUUID();
      const admission = input.admission ?? "";
      saved.push({
        id,
        patient: input.patient,
        sex: input.sex,
        age: input.age,
        date: input.date,
        week: weekIndex(input.date),
        ward: input.ward,
        specimen: input.specimen,
        organism: input.organism,
        flags: input.markers,
        sus: input.sus,
        admission,
        onset: isHospitalOnset({ admission, date: input.date }) ? "hospital" : "community",
        setting: careSetting(input.ward),
        institution: institutionOf(input.ward),
        pending: true,
      });
      newStays.push({
        id,
        patient: input.patient,
        ward: input.ward,
        date: input.date,
        admission,
        institution: institutionOf(input.ward),
        result: "positive",
        nIsolates: 1,
      });
    });
  }
  submitted = [...submitted, ...saved];
  stays = [...stays, ...newStays];
  merge();
  return saved.length;
}

export async function addRecord(input: NewRecord): Promise<void> {
  await addRecords([input]);
}

export async function deleteRecord(id: string) {
  const { error } = await supabase.from("record_submissions").delete().eq("id", id);
  if (error) throw new Error(error.message);
  submitted = submitted.filter((r) => r.id !== id);
  stays = stays.filter((s) => s.id !== id);
  merge();
}

export async function addAlert(a: Omit<Alert, "id">) {
  const { data, error } = await supabase
    .from("news_items")
    .insert({
      title: a.title,
      summary: a.summary,
      url: a.url ?? null,
      region: a.region,
      organism: a.organism ?? null,
      severity: a.severity,
      alert_date: a.date,
      source: a.source,
    })
    .select("id");
  if (error) throw new Error(error.message);
  set({ alerts: [{ ...a, id: data?.[0]?.id ?? crypto.randomUUID() }, ...state.alerts] });
}

export async function deleteAlert(id: string) {
  const { error } = await supabase.from("news_items").delete().eq("id", id);
  if (error) throw new Error(error.message);
  set({ alerts: state.alerts.filter((a) => a.id !== id) });
}

const serverSnap: State = { status: "idle", records: [], stays: [], alerts: [] };
export function useAmr(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      ensureLoaded();
      return () => listeners.delete(l);
    },
    () => state,
    () => serverSnap,
  );
}

export function maxWeek(records: IsolateRecord[]) {
  let m = 0;
  for (const r of records) if (r.week > m) m = r.week;
  return m;
}
