/**
 * Number grounding: every figure in an answer must appear in, or round from, a number the tools returned
 * (or the user typed) in this conversation. The model phrases results; it must not produce statistics.
 */

// Thousands separators ("12,345") are read as one number; a decimal point is ".".
const NUMBER = /(?<![\w.])-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\w])/g;

/** Small integers are used for counting and list numbering ("3 wards", "1."), not statistics. */
const FREE_INTEGER_MAX = 10;

function parse(token: string): { value: number; decimals: number } {
  const t = token.replace(/,/g, "");
  const decimals = t.includes(".") ? t.split(".")[1].length : 0;
  return { value: Number(t), decimals };
}

export function numbersIn(text: string): string[] {
  return text.match(NUMBER) ?? [];
}

/** Numbers from tool results / user text, ready for lookup. Dates contribute their parts (2026, 09, 28). */
export function corpusNumbers(texts: string[]): number[] {
  const out = new Set<number>();
  for (const t of texts) for (const m of t.matchAll(/-?\d+(?:\.\d+)?/g)) out.add(Number(m[0]));
  return [...out];
}

/** Returns the figures in `answer` that no source number accounts for. */
export function ungroundedNumbers(answer: string, sources: number[]): string[] {
  const bad = new Set<string>();
  for (const token of numbersIn(answer)) {
    const { value, decimals } = parse(token);
    if (!Number.isFinite(value)) continue;
    if (decimals === 0 && Math.abs(value) <= FREE_INTEGER_MAX) continue;
    const factor = 10 ** decimals;
    const matched = sources.some((s) => Math.round(s * factor) / factor === value || Math.round(Math.abs(s) * factor) / factor === Math.abs(value));
    if (!matched) bad.add(token);
  }
  return [...bad];
}
