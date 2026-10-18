"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import type { Antibiotic, Ward } from "@/lib/data/types";
import { SETTING_LABEL, ONSET_LABEL, SPECIMEN_LABEL, shortOrganism } from "@/lib/format";
import { slug, type Filters } from "@/lib/filters";

type Control = "scope" | "specimen" | "organism" | "abx" | "window" | "measure";

export function FilterBar({
  filters,
  wards,
  organisms,
  antibiotics,
  phenotypes,
  show = ["scope", "specimen", "organism", "abx", "window"],
}: {
  filters: Filters;
  wards: Ward[];
  organisms: string[];
  antibiotics: Antibiotic[];
  phenotypes: { code: string; organisms: string[] }[];
  show?: Control[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();

  function set(updates: Record<string, string | null>) {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v == null || v === "") q.delete(k);
      else q.set(k, v);
    }
    const s = q.toString();
    start(() => router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false }));
  }

  const scopeValue = filters.scope.scope_type === "hospital" ? "" : `${filters.scope.scope_type}:${filters.scope.scope_value}`;
  // Urine-only agents disappear from the picker for blood and wound.
  const abxOptions = antibiotics.filter((a) => filters.specimen === "urine" || a.reported_for === "all");
  const phenoOptions = phenotypes.filter((p) => p.organisms.includes(filters.organism));

  return (
    <div
      className={`mb-5 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface p-3 text-sm ${pending ? "opacity-70" : ""}`}
    >
      {show.includes("scope") && (
        <Field label="Ward / setting">
          <select
            value={scopeValue}
            onChange={(e) => {
              const [type, value] = e.target.value.split(":");
              set({ ward: null, setting: null, onset: null, ...(type ? { [type]: value } : {}) });
            }}
          >
            <option value="">Whole hospital</option>
            <optgroup label="Ward">
              {wards.map((w) => (
                <option key={w.ward_code} value={`ward:${w.ward_code}`}>
                  {w.ward_en}
                </option>
              ))}
            </optgroup>
            <optgroup label="Setting">
              {Object.entries(SETTING_LABEL).map(([k, v]) => (
                <option key={k} value={`setting:${k}`}>
                  {v}
                </option>
              ))}
            </optgroup>
            <optgroup label="Onset">
              {Object.entries(ONSET_LABEL).map(([k, v]) => (
                <option key={k} value={`onset:${k}`}>
                  {v}
                </option>
              ))}
            </optgroup>
          </select>
        </Field>
      )}
      {show.includes("specimen") && (
        <Field label="Specimen">
          <select
            value={filters.specimen}
            onChange={(e) => {
              const specimen = e.target.value;
              const keepAbx =
                specimen === "urine" || antibiotics.find((a) => a.antibiotic_code === filters.abx)?.reported_for !== "urine";
              set({ specimen: specimen === "urine" ? null : specimen, ...(keepAbx ? {} : { abx: null }) });
            }}
          >
            {(["urine", "blood", "wound"] as const).map((s) => (
              <option key={s} value={s}>
                {SPECIMEN_LABEL[s]}
              </option>
            ))}
          </select>
        </Field>
      )}
      {show.includes("organism") && (
        <Field label="Organism">
          <select
            value={filters.organism}
            onChange={(e) => set({ organism: e.target.value === "Escherichia coli" ? null : slug(e.target.value) })}
          >
            {organisms.map((o) => (
              <option key={o} value={o}>
                {shortOrganism(o)}
              </option>
            ))}
          </select>
        </Field>
      )}
      {show.includes("abx") && (
        <Field label="Antibiotic / marker">
          <select value={filters.abx} onChange={(e) => set({ abx: e.target.value === "CIP" ? null : e.target.value })}>
            <optgroup label="Antibiotic">
              {abxOptions.map((a) => (
                <option key={a.antibiotic_code} value={a.antibiotic_code}>
                  {a.antibiotic} ({a.antibiotic_code})
                </option>
              ))}
            </optgroup>
            {phenoOptions.length > 0 && (
              <optgroup label="Phenotype share">
                {phenoOptions.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.code}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </Field>
      )}
      {show.includes("window") && (
        <Field label="Window">
          <Segmented
            value={String(filters.window)}
            options={[
              ["4", "4 weeks"],
              ["13", "13 weeks"],
              ["52", "52 weeks"],
            ]}
            onChange={(v) => set({ window: v === "4" ? null : v })}
          />
        </Field>
      )}
      {show.includes("measure") && (
        <Field label="Show">
          <Segmented
            value={filters.measure}
            options={[
              ["r", "% resistant"],
              ["s", "% susceptible"],
            ]}
            onChange={(v) => set({ measure: v === "r" ? null : v })}
          />
        </Field>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 [&_select]:rounded-md [&_select]:border [&_select]:border-line [&_select]:bg-white [&_select]:px-2 [&_select]:py-1.5">
      <span className="text-xs text-muted">{label}</span>
      {children}
    </label>
  );
}

export function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-line bg-white p-0.5" role="radiogroup">
      {options.map(([v, l]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={`rounded px-2.5 py-1 ${value === v ? "bg-ink text-white" : "text-ink-2 hover:bg-black/5"}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
