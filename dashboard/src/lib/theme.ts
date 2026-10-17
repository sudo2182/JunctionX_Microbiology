// Chart colours (dataviz reference palette, light mode). Text never wears a series colour.
export const C = {
  surface: "#fcfcfb",
  ink: "#0b0b0b",
  ink2: "#52514e",
  muted: "#898781",
  grid: "#e1e0d9",
  axis: "#c3c2b7",
  series1: "#2a78d6",
  series1Band: "rgba(42, 120, 214, 0.16)",
  volume: "#b7d3f6",
  benchmark: "#eb6834",
  highlight: "rgba(208, 59, 59, 0.08)",
  sequential: ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"],
  severity: { critical: "#d03b3b", high: "#ec835a", medium: "#fab219", low: "#c3c2b7" },
};

export const AXIS = {
  axisLine: { lineStyle: { color: C.axis } },
  axisTick: { show: false },
  axisLabel: { color: C.muted, fontSize: 11 },
  splitLine: { lineStyle: { color: C.grid } },
};

export const TOOLTIP = {
  backgroundColor: "#ffffff",
  borderColor: "rgba(11,11,11,0.1)",
  textStyle: { color: C.ink, fontSize: 12 },
  extraCssText: "box-shadow: 0 4px 16px rgba(0,0,0,0.08); border-radius: 8px;",
};
