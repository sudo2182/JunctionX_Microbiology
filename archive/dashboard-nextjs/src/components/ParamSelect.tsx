"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** A select bound to one URL query parameter; empty value removes it. */
export function ParamSelect({
  name,
  label,
  options,
}: {
  name: string;
  label: string;
  options: [string, string][];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const value = params.get(name) ?? "";
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs text-muted">{label}</span>
      <select
        className="rounded-md border border-line bg-white px-2 py-1.5"
        value={value}
        onChange={(e) => {
          const q = new URLSearchParams(params.toString());
          if (e.target.value) q.set(name, e.target.value);
          else q.delete(name);
          const s = q.toString();
          router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
        }}
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}
