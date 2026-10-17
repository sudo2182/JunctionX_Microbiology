"use client";

import { useMemo } from "react";

import type { BenchmarkRow, RateRow } from "@/lib/data/types";
import { AXIS, C, TOOLTIP } from "@/lib/theme";
import { EChart, type EChartsOption } from "./EChart";

/**
 * Rolling %R with its Wilson band, the 52-week rate as a dashed reference, national benchmark as dotted,
 * and isolates tested per window in a separate panel below (one y-scale per panel, shared x).
 * Points with n < 30 are left out of the line; the volume panel still shows them.
 */
export function TrendChart({
  rows,
  baseline,
  benchmarks = [],
  highlight,
  height = 360,
  measureLabel = "% resistant",
}: {
  rows: RateRow[];
  baseline?: RateRow[];
  benchmarks?: BenchmarkRow[];
  highlight?: [string, string];
  height?: number;
  measureLabel?: string;
}) {
  const option = useMemo<EChartsOption>(() => {
    const labels = rows.map((r) => r.week_label);
    const ok = (r: RateRow) => r.reportable && r.pct_r != null;
    const pctLine = rows.map((r) => (ok(r) ? round(r.pct_r!) : null));
    const lower = rows.map((r) => (ok(r) ? round(r.wilson_low!) : null));
    const band = rows.map((r) => (ok(r) ? round(r.wilson_high! - r.wilson_low!) : null));
    const base = baseline?.map((r) => (ok(r) ? round(r.pct_r!) : null)) ?? [];
    const latestBench = [...benchmarks].sort((a, b) => b.year - a.year)[0];
    const yMax = Math.max(10, ...rows.filter(ok).map((r) => r.wilson_high ?? 0), latestBench?.pct_r ?? 0);

    const series: Record<string, unknown>[] = [
      {
        name: "ci-lower",
        type: "line",
        data: lower,
        stack: "ci",
        symbol: "none",
        lineStyle: { opacity: 0 },
        tooltip: { show: false },
        silent: true,
      },
      {
        name: "95% CI",
        type: "line",
        data: band,
        stack: "ci",
        symbol: "none",
        lineStyle: { opacity: 0 },
        areaStyle: { color: C.series1Band },
        silent: true,
      },
      {
        name: `${rows[0]?.window_weeks ?? ""}-week ${measureLabel}`,
        type: "line",
        data: pctLine,
        symbol: "none",
        lineStyle: { width: 2, color: C.series1 },
        itemStyle: { color: C.series1 },
        markArea: highlight
          ? {
              silent: true,
              itemStyle: { color: C.highlight },
              data: [[{ xAxis: highlight[0] }, { xAxis: highlight[1] }]],
            }
          : undefined,
      },
    ];
    if (base.length) {
      series.push({
        name: "52-week rate",
        type: "line",
        data: base,
        symbol: "none",
        lineStyle: { width: 1.5, type: "dashed", color: C.ink2 },
        itemStyle: { color: C.ink2 },
      });
    }
    if (latestBench) {
      series.push({
        name: `${latestBench.source} ${latestBench.year} (${latestBench.country})`,
        type: "line",
        data: labels.map(() => latestBench.pct_r),
        symbol: "none",
        lineStyle: { width: 1.5, type: "dotted", color: C.benchmark },
        itemStyle: { color: C.benchmark },
      });
    }
    series.push({
      name: "Isolates tested",
      type: "bar",
      itemStyle: { color: C.volume },
      xAxisIndex: 1,
      yAxisIndex: 1,
      data: rows.map((r) => ({
        value: r.n_tested,
        itemStyle: { color: r.reportable ? C.volume : C.grid, borderRadius: [2, 2, 0, 0] },
      })),
      barCategoryGap: "20%",
    });

    const avail = height - 36 - 28 - 18;
    const rateH = Math.round(avail * 0.72);
    const volH = avail - rateH;

    return {
      animation: false,
      grid: [
        { left: 48, right: 24, top: 36, height: rateH },
        { left: 48, right: 24, top: 36 + rateH + 18, height: volH },
      ],
      legend: {
        top: 0,
        left: 0,
        itemWidth: 16,
        itemHeight: 8,
        textStyle: { color: C.ink2, fontSize: 11 },
        data: series.map((s) => s.name as string).filter((n) => n !== "ci-lower" && n !== "95% CI"),
      },
      tooltip: {
        ...TOOLTIP,
        trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: C.axis } },
        formatter: (ps: { dataIndex: number }[]) => {
          const i = ps[0]?.dataIndex ?? 0;
          const r = rows[i];
          const b = baseline?.[i];
          const rate = ok(r)
            ? `<b>${r.pct_r!.toFixed(1)}%</b> (${r.n_resistant} of ${r.n_tested}; CI ${r.wilson_low!.toFixed(1)}–${r.wilson_high!.toFixed(1)}%)`
            : `n = ${r.n_tested}, too few for a %`;
          const bl = b && ok(b) ? `<br/>52-week: ${b.pct_r!.toFixed(1)}% (n = ${b.n_tested})` : "";
          return `${r.week_label} · ${r.window_weeks}-week window<br/>${rate}${bl}`;
        },
      },
      xAxis: [
        { type: "category", data: labels, gridIndex: 0, ...AXIS, axisLabel: { show: false } },
        { type: "category", data: labels, gridIndex: 1, ...AXIS, axisLabel: { ...AXIS.axisLabel, hideOverlap: true } },
      ],
      yAxis: [
        {
          type: "value",
          gridIndex: 0,
          min: 0,
          max: Math.ceil(yMax / 5) * 5,
          ...AXIS,
          axisLabel: { ...AXIS.axisLabel, formatter: "{value}%" },
        },
        { type: "value", gridIndex: 1, ...AXIS, splitNumber: 2 },
      ],
      series,
    };
  }, [rows, baseline, benchmarks, highlight, measureLabel, height]);

  return <EChart option={option} height={height} ariaLabel={`Trend of ${measureLabel} with 95% confidence band`} />;
}

const round = (v: number) => Math.round(v * 10) / 10;
