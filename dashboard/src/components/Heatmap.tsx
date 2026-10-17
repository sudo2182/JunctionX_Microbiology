"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";

import type { HeatmapCell } from "@/lib/data/types";
import { shortOrganism } from "@/lib/format";
import { slug } from "@/lib/filters";
import { C, TOOLTIP } from "@/lib/theme";
import { EChart, type EChartsOption } from "./EChart";

/** Organism x antibiotic %R. Grey with the count where n < 30, "IR" for intrinsic pairs, blank where not tested. */
export function Heatmap({ cells, codes, selected }: { cells: HeatmapCell[]; codes: string[]; selected?: [string, string] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const organisms = useMemo(
    () =>
      [...new Set(cells.map((c) => c.organism))].sort(
        (a, b) =>
          Math.max(0, ...cells.filter((c) => c.organism === b).map((c) => c.n_tested)) -
          Math.max(0, ...cells.filter((c) => c.organism === a).map((c) => c.n_tested)),
      ),
    [cells],
  );

  const option = useMemo<EChartsOption>(() => {
    const data = cells
      .filter((c) => codes.includes(c.antibiotic_code))
      .map((c) => {
        const x = codes.indexOf(c.antibiotic_code);
        const y = organisms.indexOf(c.organism);
        const isSel = selected && selected[0] === c.organism && selected[1] === c.antibiotic_code;
        const border = isSel ? { borderColor: C.ink, borderWidth: 2 } : { borderColor: C.surface, borderWidth: 2 };
        if (c.is_intrinsic)
          return { value: [x, y, -1], cell: c, itemStyle: { color: "#efeeea", ...border }, label: { formatter: "IR", color: C.muted } };
        if (!c.reportable)
          return {
            value: [x, y, -1],
            cell: c,
            itemStyle: { color: "#f3f2ee", ...border },
            label: { formatter: c.n_tested ? `n=${c.n_tested}` : "", color: C.muted, fontSize: 10 },
          };
        return {
          value: [x, y, Math.round(c.pct_r! * 10) / 10],
          cell: c,
          itemStyle: border,
          label: { color: c.pct_r! > 25 ? "#ffffff" : C.ink },
        };
      });
    return {
      animation: false,
      grid: { left: 150, right: 12, top: 28, bottom: 52 },
      tooltip: {
        ...TOOLTIP,
        formatter: (p: { data: { cell: HeatmapCell } }) => {
          const c = p.data.cell;
          const head = `<i>${c.organism}</i> · ${c.antibiotic_code}`;
          if (c.is_intrinsic) return `${head}<br/>Intrinsic resistance, excluded from rates`;
          if (!c.reportable) return `${head}<br/>n = ${c.n_tested}, too few for a % (${c.n_resistant} resistant)`;
          return `${head}<br/><b>${c.pct_r!.toFixed(1)}%</b> resistant (${c.n_resistant} of ${c.n_tested})<br/>95% CI ${c.wilson_low!.toFixed(1)}–${c.wilson_high!.toFixed(1)}%`;
        },
      },
      xAxis: {
        type: "category",
        data: codes,
        position: "top",
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: C.ink2, fontSize: 11 },
        splitArea: { show: false },
      },
      yAxis: {
        type: "category",
        data: organisms.map(shortOrganism),
        inverse: true,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: C.ink, fontSize: 12, fontStyle: "italic" },
      },
      visualMap: {
        type: "piecewise",
        orient: "horizontal",
        left: 150,
        bottom: 0,
        dimension: 2,
        itemWidth: 14,
        itemHeight: 10,
        textStyle: { color: C.ink2, fontSize: 11 },
        pieces: [
          { min: 0, lt: 2, label: "<2%", color: C.sequential[0] },
          { gte: 2, lt: 5, label: "2–5", color: C.sequential[1] },
          { gte: 5, lt: 10, label: "5–10", color: C.sequential[2] },
          { gte: 10, lt: 20, label: "10–20", color: C.sequential[3] },
          { gte: 20, lt: 35, label: "20–35", color: C.sequential[4] },
          { gte: 35, lt: 60, label: "35–60", color: C.sequential[5] },
          { gte: 60, label: "≥60%", color: C.sequential[6] },
        ],
        outOfRange: { color: "#f3f2ee" },
      },
      series: [
        {
          type: "heatmap",
          data,
          label: { show: true, fontSize: 11, formatter: (p: { value: number[] }) => (p.value[2] >= 0 ? String(Math.round(p.value[2])) : "") },
          emphasis: { itemStyle: { borderColor: C.ink, borderWidth: 1 } },
        },
      ],
    };
  }, [cells, codes, organisms, selected]);

  return (
    <EChart
      option={option}
      height={Math.max(240, organisms.length * 34 + 90)}
      ariaLabel="Heatmap of percent resistant by organism and antibiotic"
      onClick={(p) => {
        const c = (p.data as { cell?: HeatmapCell })?.cell;
        if (!c || c.is_intrinsic) return;
        const q = new URLSearchParams(params.toString());
        if (c.organism === "Escherichia coli") q.delete("organism");
        else q.set("organism", slug(c.organism));
        if (c.antibiotic_code === "CIP") q.delete("abx");
        else q.set("abx", c.antibiotic_code);
        router.push(`${pathname}?${q.toString()}#drill`, { scroll: false });
      }}
    />
  );
}
