import type { Confidence, Severity } from "@/lib/data/types";

const STYLE: Record<Severity, { dot: string; icon: string }> = {
  critical: { dot: "bg-critical", icon: "▲▲" },
  high: { dot: "bg-serious", icon: "▲" },
  medium: { dot: "bg-warning", icon: "●" },
  low: { dot: "bg-axis", icon: "○" },
};

/** Status colour always ships with an icon and a label, never colour alone. */
export function SeverityBadge({ severity }: { severity: Severity }) {
  const s = STYLE[severity];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white px-2 py-0.5 text-xs font-medium capitalize">
      <span className={`inline-block h-2 w-2 rounded-full ${s.dot}`} aria-hidden />
      <span aria-hidden className="text-[9px] text-ink-2">{s.icon}</span>
      {severity}
    </span>
  );
}

export function ConfidenceLabel({ confidence }: { confidence: Confidence }) {
  return <span className="text-xs text-ink-2">{confidence} confidence</span>;
}
