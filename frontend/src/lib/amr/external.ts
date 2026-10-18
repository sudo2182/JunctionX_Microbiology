import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ANTIBIOTICS } from "./reference";

/**
 * External THL reference data (real, aggregate, Finland / Southwest Finland), imported into Supabase by the
 * benchmarks workflow (backend/pipeline/benchmarks). Read straight from the api.* views, so a new import shows up
 * on the next page load. Kept apart from the local synthetic TYKS data: these are never merged or divided.
 */

export type ContextRow = {
  phenotype: string; organism: string; specimen: string; geo_code: string; geo_name: string;
  year: number; indicator: "cases" | "incidence_per_100k" | string; value: number;
  retrieved_at: string | null; source_url: string | null; attribution: string | null;
};
export type BenchRow = {
  organism: string; antibiotic_code: string; specimen: string; year: number; n_tested: number | null; pct_r: number;
  retrieved_at: string | null; source_url: string | null; release: string | null; caveat: string | null; attribution: string | null;
};
export type SourceRow = {
  source_id: string; name: string; landing_url: string | null; attribution: string | null; licence: string | null;
  update_cadence: string | null; last_import_at: string | null;
};
export type ExternalData = { context: ContextRow[]; bench: BenchRow[]; sources: SourceRow[] };

// These api views are not in the generated Database types; use a loosely typed handle.
type Page = PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
type Query = { select: (c: string) => { order: (c: string) => { range: (from: number, to: number) => Page } } };
const api = () => supabase.schema("api") as unknown as { from: (v: string) => Query };

const PAGE = 1000; // PostgREST returns at most this many rows per request

/** Reads a whole view page by page, so a growing dataset is never silently cut at the row limit. */
async function readAll(view: string, columns: string, orderBy: string): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await api().from(view).select(columns).order(orderBy).range(from, from + PAGE - 1);
    if (error) throw new Error(`${view}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

export async function loadExternal(): Promise<ExternalData> {
  const [context, bench, sources] = await Promise.all([
    readAll("external_context", "phenotype, organism, specimen, geo_code, geo_name, year, indicator, value, retrieved_at, source_url, attribution", "year"),
    readAll("benchmarks", "organism, antibiotic_code, specimen, year, n_tested, pct_r, retrieved_at, source_url, release, caveat, attribution", "year"),
    readAll("external_sources", "source_id, name, landing_url, attribution, licence, update_cadence, last_import_at", "source_id"),
  ]);
  return {
    context: (context as ContextRow[]).map((r) => ({ ...r, value: Number(r.value) })),
    bench: (bench as BenchRow[]).map((r) => ({ ...r, pct_r: Number(r.pct_r), n_tested: r.n_tested == null ? null : Number(r.n_tested) })),
    sources: sources as SourceRow[],
  };
}

export type ExternalState = { status: "loading" | "ready" | "error"; data: ExternalData | null; error?: string };

export function useExternal(): ExternalState {
  const [state, setState] = useState<ExternalState>({ status: "loading", data: null });
  useEffect(() => {
    let live = true;
    loadExternal()
      .then((data) => live && setState({ status: "ready", data }))
      .catch((e: unknown) => live && setState({ status: "error", data: null, error: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, []);
  return state;
}

// ── THL infectious diseases register (notifications) ─────────────────────────

export const REGION = { code: "wsc:05", label: "Southwest Finland" } as const;
export const COUNTRY = { code: "FI", label: "Finland" } as const;

export type Specimen = "blood_csf" | "carriage";
export const SPECIMEN_LABEL: Record<Specimen, string> = { blood_csf: "Bloodstream", carriage: "Carriage" };

export const REGISTER_SERIES = [
  { key: "esbl-ecoli", label: "ESBL E. coli", phenotype: "ESBL", organism: "Escherichia coli" },
  { key: "esbl-kpn", label: "ESBL K. pneumoniae", phenotype: "ESBL", organism: "Klebsiella pneumoniae" },
  { key: "mrsa", label: "MRSA", phenotype: "MRSA", organism: "Staphylococcus aureus" },
  { key: "vre", label: "VRE (Enterococcus spp.)", phenotype: "VRE", organism: "Enterococcus spp." },
  { key: "cpe-ecoli", label: "CPE E. coli", phenotype: "CPE", organism: "Escherichia coli" },
  { key: "cpe-kpn", label: "CPE K. pneumoniae", phenotype: "CPE", organism: "Klebsiella pneumoniae" },
] as const;
export type RegisterKey = (typeof REGISTER_SERIES)[number]["key"];

/** Series the register actually has for this specimen (e.g. CPE is reported as carriage only). */
export function registerOptions(context: ContextRow[], specimen: Specimen) {
  return REGISTER_SERIES.filter((s) => context.some((r) => r.specimen === specimen && r.phenotype === s.phenotype && r.organism === s.organism));
}

export type IncidencePoint = { year: number; region: number | null; country: number | null; regionCases: number | null; countryCases: number | null };

/** Yearly incidence per 100 000 (and case counts) for Southwest Finland and Finland, oldest first. */
export function incidenceSeries(context: ContextRow[], key: RegisterKey, specimen: Specimen): IncidencePoint[] {
  const s = REGISTER_SERIES.find((x) => x.key === key);
  if (!s) return [];
  const rows = context.filter((r) => r.specimen === specimen && r.phenotype === s.phenotype && r.organism === s.organism);
  const pick = (year: number, geo: string, indicator: string) => rows.find((r) => r.year === year && r.geo_code === geo && r.indicator === indicator)?.value ?? null;
  return [...new Set(rows.map((r) => r.year))].sort((a, b) => a - b).map((year) => ({
    year,
    region: pick(year, REGION.code, "incidence_per_100k"),
    country: pick(year, COUNTRY.code, "incidence_per_100k"),
    regionCases: pick(year, REGION.code, "cases"),
    countryCases: pick(year, COUNTRY.code, "cases"),
  }));
}

export const SHARE_GROUPS = [
  { key: "esbl", label: "ESBL", phenotype: "ESBL", color: "#139e6f" },
  { key: "mrsa", label: "MRSA", phenotype: "MRSA", color: "#9a2068" },
  { key: "vre", label: "VRE", phenotype: "VRE", color: "#d6a20a" },
  { key: "cpe", label: "CPE", phenotype: "CPE", color: "#735cc7" },
] as const;

export type ShareSlice = { key: string; label: string; color: string; cases: number; pct: number };

/**
 * Part-to-whole of notified resistant-bacteria cases in one area and year, by type (species summed within a type).
 * One specimen type at a time: bloodstream and carriage findings are separate notifications and are not added up.
 */
export function notificationShare(context: ContextRow[], geo: string, specimen: Specimen, year?: number): { year: number | null; total: number; slices: ShareSlice[] } {
  const rows = context.filter((r) => r.geo_code === geo && r.specimen === specimen && r.indicator === "cases" && r.phenotype !== "not_MRSA");
  const latest = year ?? (rows.length ? Math.max(...rows.map((r) => r.year)) : null);
  if (latest === null) return { year: null, total: 0, slices: [] };
  const counts = SHARE_GROUPS.map((g) => ({ ...g, cases: rows.filter((r) => r.year === latest && r.phenotype === g.phenotype).reduce((n, r) => n + r.value, 0) }));
  const total = counts.reduce((n, c) => n + c.cases, 0);
  return {
    year: latest,
    total,
    slices: counts.filter((c) => c.cases > 0).map((c) => ({ key: c.key, label: c.label, color: c.color, cases: c.cases, pct: total ? (100 * c.cases) / total : 0 })),
  };
}

// ── THL Finres (national % resistant) ────────────────────────────────────────

const abxName = (code: string) => (code === "ESBL" || code === "MRSA" ? code : ANTIBIOTICS.find((a) => a.code === code)?.name ?? code);
const shortOrg = (o: string) => o.replace(/^(\w)\w+ /, "$1. ");

export type FinresOption = { key: string; label: string };

export function finresOptions(bench: BenchRow[]): FinresOption[] {
  const keys = [...new Set(bench.map((b) => `${b.organism}|${b.antibiotic_code}|${b.specimen}`))].sort();
  return keys.map((key) => {
    const [org, code, spec] = key.split("|");
    return { key, label: `${shortOrg(org)} · ${abxName(code)} · ${spec}` };
  });
}

export function finresSeries(bench: BenchRow[], key: string): { year: number; pct: number; n: number | null }[] {
  const [org, code, spec] = key.split("|");
  return bench
    .filter((b) => b.organism === org && b.antibiotic_code === code && b.specimen === spec)
    .map((b) => ({ year: b.year, pct: Math.round(b.pct_r * 10) / 10, n: b.n_tested }))
    .sort((a, b) => a.year - b.year);
}

// ── Provenance ───────────────────────────────────────────────────────────────

/** A monthly import that hasn't run for this long is overdue. */
export const STALE_AFTER_DAYS = 45;

export function freshness(source: SourceRow | undefined, now = Date.now()): { lastImport: string | null; daysAgo: number | null; stale: boolean } {
  const t = source?.last_import_at ? Date.parse(source.last_import_at) : NaN;
  if (!Number.isFinite(t)) return { lastImport: null, daysAgo: null, stale: true };
  const daysAgo = Math.max(0, Math.floor((now - t) / 86_400_000));
  return { lastImport: source!.last_import_at, daysAgo, stale: daysAgo > STALE_AFTER_DAYS };
}

export function yearRange(rows: { year: number }[]): string {
  if (!rows.length) return "–";
  const ys = rows.map((r) => r.year);
  return `${Math.min(...ys)}–${Math.max(...ys)}`;
}
