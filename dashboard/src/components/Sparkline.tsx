"use client";

import { useMemo } from "react";

import { C } from "@/lib/theme";
import { EChart, type EChartsOption } from "./EChart";

/** Last 26 weeks, trigger window shaded. Values are %R or counts depending on the alert type. */
export function Sparkline({
  values,
  labels,
  shadeFrom,
  unit,
}: {
  values: (number | null)[];
  labels: string[];
  shadeFrom: number;
  unit: "%" | "n";
}) {
  const option = useMemo<EChartsOption>(
    () => ({
      animation: false,
      grid: { left: 2, right: 2, top: 4, bottom: 2 },
      xAxis: { type: "category", data: labels, show: false },
      yAxis: { type: "value", show: false, min: 0 },
      tooltip: {
        trigger: "axis",
        confine: true,
        textStyle: { fontSize: 11 },
        formatter: (p: { dataIndex: number }[]) => {
          const v = values[p[0].dataIndex];
          return `${labels[p[0].dataIndex]}: ${v == null ? "n < 30" : unit === "%" ? `${v.toFixed(1)}%` : v}`;
        },
      },
      series: [
        {
          type: unit === "%" ? "line" : "bar",
          data: values,
          symbol: "none",
          lineStyle: { width: 1.5, color: C.series1 },
          itemStyle: { color: C.series1, borderRadius: [2, 2, 0, 0] },
          markArea: {
            silent: true,
            itemStyle: { color: C.highlight },
            data: [[{ xAxis: labels[Math.max(0, shadeFrom)] }, { xAxis: labels[labels.length - 1] }]],
          },
        },
      ],
    }),
    [values, labels, shadeFrom, unit],
  );
  return <EChart option={option} height={44} ariaLabel="Last 26 weeks" />;
}
