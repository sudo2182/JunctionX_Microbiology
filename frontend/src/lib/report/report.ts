/**
 * Printable surveillance reports, laid out like an ECDC surveillance report: title block, key facts, numbered
 * sections with numbered figures and tables, methods, limitations, data sources and a suggested citation.
 * Every number comes from the page's own calculations (builders.ts); nothing here computes statistics.
 */

export type Cell = string | number | null;
export type Table = { caption: string; columns: string[]; rows: Cell[][]; note?: string | undefined };
export type Series = { name: string; values: (number | null)[]; emphasis?: boolean };
export type Figure =
  | { kind: "line"; caption: string; x: string[]; series: Series[]; unit: string; note?: string | undefined }
  | { kind: "bar"; caption: string; items: { label: string; value: number }[]; unit: string; note?: string | undefined };
export type Block =
  | { type: "text"; text: string }
  | { type: "facts"; items: { label: string; value: string }[] }
  | { type: "table"; table: Table }
  | { type: "figure"; figure: Figure };
export type Section = { id: string; heading: string; blocks: Block[] };
export type Source = { label: string; url?: string };
export type ReportDoc = {
  id: string; // page key, used in file names
  title: string;
  subtitle: string;
  period: string; // what the figures cover, in words
  dataAsOf: string; // latest data date / import time
  keyFacts: string[];
  sections: Section[];
  methods: string[];
  limitations: string[];
  sources: Source[];
};
export type ReportOptions = {
  title: string;
  preparedBy: string;
  sections: string[]; // section ids to include
  keyFacts: boolean;
  tables: boolean;
  methods: boolean;
  limitations: boolean;
};

export const defaultOptions = (doc: ReportDoc): ReportOptions => ({
  title: doc.title, preparedBy: "", sections: doc.sections.map((s) => s.id), keyFacts: true, tables: true, methods: true, limitations: true,
});

const esc = (v: Cell) => String(v ?? "–").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt = (n: number) => (Math.abs(n) >= 100 ? Math.round(n).toLocaleString("en-GB") : (Math.round(n * 10) / 10).toLocaleString("en-GB"));
/** Data labels: percentages always with one decimal (8.0%, not 8), other values as fmt(). */
const fmtFor = (unit: string) => (n: number) => (unit.includes("%") ? `${n.toFixed(1)}%` : fmt(n));

/** Which x labels to print: every `every`-th, plus the last, dropping a regular label that would crowd the last one. */
export function xLabelIndexes(count: number, max = 8): number[] {
  if (count <= 0) return [];
  const every = Math.max(1, Math.ceil(count / max));
  const out = [];
  for (let i = 0; i < count - 1; i += every) if (count - 1 - i >= Math.ceil(every / 2)) out.push(i);
  out.push(count - 1);
  return out;
}

/** Spreads end-of-line labels apart vertically so they never overlap (min gap in px). */
export function dodge(ys: number[], gap = 12): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < order.length; k++) if (order[k].y - order[k - 1].y < gap) order[k].y = order[k - 1].y + gap;
  const out = new Array<number>(ys.length);
  order.forEach((o) => (out[o.i] = o.y));
  return out;
}

// Colour-validated (colourblind-safe) categorical set used across the dashboard, plus emphasis/context.
const EMPHASIS = "#0b5d44";
const CONTEXT = "#8a949e";
const CATEGORICAL = ["#139e6f", "#9a2068", "#d6a20a", "#735cc7"];

/** "Nice" axis maximum and ticks for a 0-based axis. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => +(i * step).toFixed(10));
}

function lineSvg(f: Extract<Figure, { kind: "line" }>): string {
  const W = 640, H = 230, L = 46, R = 120, T = 12, B = 34;
  const vals = f.series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const ticks = niceTicks(Math.max(0, ...vals));
  const top = ticks[ticks.length - 1] || 1;
  const x = (i: number) => L + (f.x.length <= 1 ? 0 : (i * (W - L - R)) / (f.x.length - 1));
  const y = (v: number) => T + (H - T - B) * (1 - v / top);
  const label = fmtFor(f.unit);
  const colour = (s: Series, i: number) => (f.series.length === 1 || s.emphasis ? EMPHASIS : f.series.some((z) => z.emphasis) ? CONTEXT : CATEGORICAL[i % 4]);
  const grid = ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="#e3e7ea"/><text x="${L - 6}" y="${y(t) + 3}" text-anchor="end" class="ax">${fmt(t)}</text>`).join("");
  const xl = xLabelIndexes(f.x.length).map((i) => `<text x="${x(i)}" y="${H - B + 16}" text-anchor="middle" class="ax">${esc(f.x[i])}</text>`).join("");
  const ends = f.series.map((s) => s.values.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0).pop());
  const labelY = dodge(f.series.map((s, k) => (ends[k] === undefined ? -999 : y(s.values[ends[k]!]!) + 3)));
  const lines = f.series.map((s, si) => {
    const segs: string[] = [];
    let cur: string[] = [];
    s.values.forEach((v, i) => { if (v == null) { if (cur.length) segs.push(cur.join(" ")); cur = []; } else cur.push(`${x(i)},${y(v)}`); });
    if (cur.length) segs.push(cur.join(" "));
    const lastI = ends[si];
    const end = lastI === undefined || lastI !== f.x.length - 1 ? "" : `<text x="${x(lastI) + 6}" y="${labelY[si]}" class="dl">${esc(s.name)} ${label(s.values[lastI]!)}</text>`;
    return segs.map((p) => `<polyline points="${p}" fill="none" stroke="${colour(s, si)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join("") + end;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(f.caption)}"><text x="${L}" y="${T - 2}" class="ax">${esc(f.unit)}</text>${grid}<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="#9aa5ae"/>${xl}${lines}</svg>`;
}

function barSvg(f: Extract<Figure, { kind: "bar" }>): string {
  const rowH = 22, W = 640, L = 170, R = 70;
  const H = f.items.length * rowH + 24;
  const ticks = niceTicks(Math.max(0, ...f.items.map((i) => i.value)));
  const top = ticks[ticks.length - 1] || 1;
  const w = (v: number) => ((W - L - R) * v) / top;
  const label = fmtFor(f.unit);
  const bars = f.items.map((it, i) => {
    const yy = 8 + i * rowH;
    return `<text x="${L - 8}" y="${yy + 12}" text-anchor="end" class="lb">${esc(it.label)}</text><rect x="${L}" y="${yy + 2}" width="${Math.max(0, w(it.value))}" height="14" rx="2" fill="${EMPHASIS}"/><text x="${L + w(it.value) + 6}" y="${yy + 13}" class="dl">${label(it.value)}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(f.caption)}"><line x1="${L}" x2="${L}" y1="4" y2="${H - 16}" stroke="#9aa5ae"/>${bars}<text x="${L}" y="${H - 2}" class="ax">${esc(f.unit)}</text></svg>`;
}

/** Sections and blocks the options keep, in order. */
export function selectedSections(doc: ReportDoc, o: ReportOptions): Section[] {
  return doc.sections
    .filter((s) => o.sections.includes(s.id))
    .map((s) => ({ ...s, blocks: s.blocks.filter((b) => o.tables || b.type !== "table") }))
    .filter((s) => s.blocks.length > 0);
}

export function reportFileName(doc: ReportDoc, generatedAt: Date, ext: string): string {
  return `AMR-Watch_${doc.id}_report_${generatedAt.toISOString().slice(0, 10)}.${ext}`;
}

export function renderReportHtml(doc: ReportDoc, o: ReportOptions, generatedAt = new Date()): string {
  const date = generatedAt.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  let fig = 0;
  let tab = 0;
  const sections = selectedSections(doc, o).map((s, si) => {
    const body = s.blocks.map((b) => {
      if (b.type === "text") return `<p>${esc(b.text)}</p>`;
      if (b.type === "facts") return `<div class="facts">${b.items.map((i) => `<div><div class="fv${i.value.length > 12 ? " long" : ""}">${esc(i.value)}</div><div class="fl">${esc(i.label)}</div></div>`).join("")}</div>`;
      if (b.type === "figure") {
        fig++;
        const f = b.figure;
        const legend = f.kind === "line" && f.series.length > 1 ? `<div class="legend">${f.series.map((s, i) => `<span><i style="background:${f.series.length === 1 || s.emphasis ? EMPHASIS : f.series.some((z) => z.emphasis) ? CONTEXT : CATEGORICAL[i % 4]}"></i>${esc(s.name)}</span>`).join("")}</div>` : "";
        return `<figure><figcaption><b>Figure ${fig}.</b> ${esc(f.caption)}</figcaption>${f.kind === "line" ? lineSvg(f) : barSvg(f)}${legend}${f.note ? `<p class="note">${esc(f.note)}</p>` : ""}</figure>`;
      }
      tab++;
      const t = b.table;
      const isDate = (v: Cell) => typeof v === "string" && /^\d{4}-\d{2}(-\d{2})?( to \d{4}-\d{2}-\d{2})?$/.test(v);
      const dated = t.columns.map((_, ci) => t.rows.length > 0 && t.rows.some((r) => isDate(r[ci])) && t.rows.every((r) => r[ci] == null || r[ci] === "–" || isDate(r[ci])));
      const numeric = t.columns.map((_, ci) => !dated[ci] && t.rows.length > 0 && t.rows.every((r) => r[ci] == null || typeof r[ci] === "number" || /^[\d.,%–\s()=n/<>≥-]+$/.test(String(r[ci]))));
      const cls = (ci: number) => (numeric[ci] ? "r" : dated[ci] ? "d" : "");
      return `<div class="tbl"><div class="cap"><b>Table ${tab}.</b> ${esc(t.caption)}</div><table class="${t.columns.length >= 8 ? "wide" : ""}"><thead><tr>${t.columns.map((c, ci) => `<th class="${cls(ci)}">${esc(c)}</th>`).join("")}</tr></thead><tbody>${t.rows.length ? t.rows.map((r) => `<tr>${r.map((c, ci) => `<td class="${cls(ci)}">${esc(typeof c === "number" ? fmt(c) : c)}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${t.columns.length}">No data for this selection.</td></tr>`}</tbody></table>${t.note ? `<p class="note">${esc(t.note)}</p>` : ""}</div>`;
    }).join("");
    return `<section><h2>${si + 1}. ${esc(s.heading)}</h2>${body}</section>`;
  }).join("");

  const citation = `AMR Watch. ${o.title}. ${doc.period}. Turku: AMR Watch (JunctionX); ${date}.`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(reportFileName(doc, generatedAt, "pdf").replace(/\.pdf$/, ""))}</title>
<style>
@page{size:A4;margin:16mm 16mm 18mm}
*{box-sizing:border-box}body{font-family:"IBM Plex Sans",Helvetica,Arial,sans-serif;color:#1d2a33;font-size:10.5pt;line-height:1.45;margin:0}
.band{background:#0b5d44;color:#fff;padding:14px 18px;border-radius:2px;display:flex;justify-content:space-between;align-items:baseline}
.band b{font-size:11pt;letter-spacing:.04em}.band span{font-size:9pt;opacity:.9}
h1{font-size:22pt;line-height:1.15;margin:18px 0 4px}.sub{font-size:12pt;color:#41525e;margin:0 0 10px}
.meta{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;border-top:1px solid #cfd6db;border-bottom:1px solid #cfd6db;padding:8px 0;font-size:9pt;margin-bottom:14px}
.meta div span{display:block;color:#5d6d78;font-size:8pt;text-transform:uppercase;letter-spacing:.05em}
.key{background:#eef5f1;border-left:4px solid #0b5d44;padding:10px 14px;margin:0 0 16px;break-inside:avoid}.key h2{margin:0 0 6px;font-size:12pt;border:0;padding:0}.key ul{margin:0;padding-left:18px}.key li{margin:3px 0}
h2{font-size:13.5pt;color:#0b5d44;border-bottom:2px solid #0b5d44;padding-bottom:3px;margin:20px 0 8px;break-after:avoid}
figure{margin:10px 0 14px;break-inside:avoid}figcaption,.cap{font-size:9.5pt;margin-bottom:4px}
svg .ax{font-size:10px;fill:#5d6d78}svg .lb{font-size:11px;fill:#1d2a33}svg .dl{font-size:10.5px;fill:#1d2a33;font-weight:600}
.legend{display:flex;flex-wrap:wrap;gap:12px;font-size:8.5pt;color:#41525e;margin-top:2px}.legend i{display:inline-block;width:14px;height:3px;margin-right:5px;vertical-align:middle}
.tbl{margin:10px 0 14px;break-inside:auto}table{width:100%;border-collapse:collapse;font-size:8.8pt}thead{display:table-header-group}
th{background:#0b5d44;color:#fff;text-align:left;font-weight:600;padding:4px 6px}td{padding:3px 6px;border-bottom:1px solid #e1e6ea}tr{break-inside:avoid}tbody tr:nth-child(even) td{background:#f6f8f9}.r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.d{white-space:nowrap}table.wide{font-size:7.6pt}table.wide th,table.wide td{padding:3px 4px}
.note{font-size:8.3pt;color:#5d6d78;margin:4px 0 0}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin:8px 0 12px}.facts>div{border:1px solid #cfd6db;padding:8px}.fv{font-size:16pt;font-weight:600;color:#0b5d44}.fv.long{font-size:11pt;line-height:1.25}.fl{font-size:8.5pt;color:#41525e}
.small{font-size:9pt}.small li{margin:2px 0}.disc{border:1px solid #d9a400;background:#fff8e1;padding:8px 12px;font-size:8.8pt;margin-top:14px;break-inside:avoid}
a{color:#0b5d44}
</style></head><body>
<div class="band"><b>AMR WATCH · SURVEILLANCE REPORT</b><span>${esc(date)}</span></div>
<h1>${esc(o.title)}</h1><p class="sub">${esc(doc.subtitle)}</p>
<div class="meta"><div><span>Period covered</span>${esc(doc.period)}</div><div><span>Data as of</span>${esc(doc.dataAsOf)}</div><div><span>Prepared by</span>${esc(o.preparedBy.trim() || "AMR Watch dashboard")}</div></div>
${o.keyFacts && doc.keyFacts.length ? `<div class="key"><h2>Key facts</h2><ul>${doc.keyFacts.map((k) => `<li>${esc(k)}</li>`).join("")}</ul></div>` : ""}
${sections}
${o.methods && doc.methods.length ? `<section><h2>Methods and definitions</h2><ul class="small">${doc.methods.map((m) => `<li>${esc(m)}</li>`).join("")}</ul></section>` : ""}
${o.limitations && doc.limitations.length ? `<section><h2>Limitations</h2><ul class="small">${doc.limitations.map((m) => `<li>${esc(m)}</li>`).join("")}</ul></section>` : ""}
<section><h2>Data sources</h2><ul class="small">${doc.sources.map((s) => `<li>${esc(s.label)}${s.url ? ` · <a href="${esc(s.url)}">${esc(s.url)}</a>` : ""}</li>`).join("")}</ul>
<p class="small"><b>Suggested citation:</b> ${esc(citation)}</p></section>
<div class="disc"><b>Synthetic data.</b> Local figures come from the synthetic TYKS hackathon dataset and do not describe real patients or real clinical events. Statistical signals are not confirmed outbreaks. External THL/ECDC figures are real and shown for context only.</div>
</body></html>`;
}

const csvCell = (v: Cell) => {
  const s = v == null ? "" : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Every table in the selected sections as one CSV (a caption line before each table), for spreadsheets. */
export function reportCsv(doc: ReportDoc, o: ReportOptions, generatedAt = new Date()): string {
  const lines = [`# ${o.title}`, `# ${doc.period}; data as of ${doc.dataAsOf}; generated ${generatedAt.toISOString()}`, "# Synthetic local data; external THL/ECDC figures are real context."];
  let n = 0;
  for (const s of selectedSections(doc, { ...o, tables: true }))
    for (const b of s.blocks)
      if (b.type === "table") {
        n++;
        lines.push("", `# Table ${n}. ${b.table.caption}`, b.table.columns.map(csvCell).join(","), ...b.table.rows.map((r) => r.map(csvCell).join(",")));
      }
  if (n === 0) lines.push("", "# No tables in the selected sections.");
  return lines.join("\r\n") + "\r\n";
}
