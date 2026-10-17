/** Wilson score interval (95%), as percentages. Mirrors pipeline/stats.py wilson(). */
export function wilson(x: number, n: number, z = 1.96): [number, number] | null {
  if (n <= 0) return null;
  const p = x / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h) * 100, Math.min(1, c + h) * 100];
}

export const MIN_N = 30;

export function pct(x: number, n: number): number | null {
  return n > 0 ? (x / n) * 100 : null;
}
