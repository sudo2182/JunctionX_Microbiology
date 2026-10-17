import type { Scope, Specimen } from "./data/types";

// Every filter lives in the URL so alerts, RSS items and shared links open an exact view.
// Scheme (all optional):
//   ward=URO | setting=ed | onset=hospital   scope; none means the whole hospital
//   specimen=urine|blood|wound               default urine
//   organism=escherichia-coli                slug of the Latin name (same slug as the RSS feed)
//   abx=CIP                                  WHONET code or phenotype (ESBL, MRSA, VRE, CPE)
//   window=4|13|52                           weeks, default 4
//   measure=r|s                              %R (default) or %S

export type SearchParams = Record<string, string | string[] | undefined>;

export interface Filters {
  scope: Scope;
  specimen: Specimen;
  organism: string;
  abx: string;
  window: number;
  measure: "r" | "s";
}

export const WINDOWS = [4, 13, 52] as const;
export const SPECIMENS: Specimen[] = ["urine", "blood", "wound"];

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export function organismFromSlug(s: string | undefined, organisms: string[]): string | undefined {
  if (!s) return undefined;
  return organisms.find((o) => slug(o) === s || o === s);
}

export function parseFilters(sp: SearchParams, organisms: string[]): Filters {
  const ward = one(sp.ward);
  const setting = one(sp.setting);
  const onset = one(sp.onset);
  const scope: Scope = ward
    ? { scope_type: "ward", scope_value: ward }
    : setting
      ? { scope_type: "setting", scope_value: setting }
      : onset
        ? { scope_type: "onset", scope_value: onset }
        : { scope_type: "hospital", scope_value: "ALL" };
  const specimen = (SPECIMENS as string[]).includes(one(sp.specimen) ?? "") ? (one(sp.specimen) as Specimen) : "urine";
  const w = Number(one(sp.window));
  return {
    scope,
    specimen,
    organism: organismFromSlug(one(sp.organism), organisms) ?? "Escherichia coli",
    abx: (one(sp.abx) ?? "CIP").toUpperCase(),
    window: (WINDOWS as readonly number[]).includes(w) ? w : 4,
    measure: one(sp.measure) === "s" ? "s" : "r",
  };
}

/** Serialise filters back to a query string, dropping defaults so links stay short. */
export function filtersToQuery(f: Partial<Filters>): string {
  const q = new URLSearchParams();
  if (f.scope && f.scope.scope_type !== "hospital") q.set(f.scope.scope_type, f.scope.scope_value);
  if (f.specimen && f.specimen !== "urine") q.set("specimen", f.specimen);
  if (f.organism && f.organism !== "Escherichia coli") q.set("organism", slug(f.organism));
  if (f.abx && f.abx !== "CIP") q.set("abx", f.abx);
  if (f.window && f.window !== 4) q.set("window", String(f.window));
  if (f.measure === "s") q.set("measure", "s");
  const s = q.toString();
  return s ? `?${s}` : "";
}

export function scopeToQuery(scope: Scope): Record<string, string> {
  return scope.scope_type === "hospital" ? {} : { [scope.scope_type]: scope.scope_value };
}
