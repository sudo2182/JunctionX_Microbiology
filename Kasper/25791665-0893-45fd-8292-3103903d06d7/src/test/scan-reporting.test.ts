import { expect, it } from "vitest";
import { runScan, singleZones } from "@/lib/amr/satscan";

it("reports weaker overlapping candidates without changing their p-values", () => {
  const input = { locations: ["A", "B", "C"], zones: singleZones(3), weeks: 6, cases: [[2, 2, 2, 2, 2, 4], [2, 2, 2, 2, 2, 1], [2, 2, 2, 2, 2, 2]], model: "stp" as const, maxWindow: 4, prospective: true, replications: 99 };
  const standard = runScan(input);
  const expanded = runScan({ ...input, maxClusters: 20, includeOverlapping: true });
  expect(expanded.length).toBeGreaterThan(standard.length);
  expect(expanded[0]?.p).toBe(standard[0]?.p);
  expect(expanded.some((c) => c.p > 0.05)).toBe(true);
  expect(expanded.some((c, i) => expanded.slice(0, i).some((other) => other.zone.join() === c.zone.join()))).toBe(true);
});