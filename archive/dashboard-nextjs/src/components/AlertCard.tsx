import Link from "next/link";

import type { AlertEpisode, RateRow, Ward } from "@/lib/data/types";
import { scopeLabel, shortOrganism, SPECIMEN_LABEL } from "@/lib/format";
import { ConfidenceLabel, SeverityBadge } from "./SeverityBadge";
import { Sparkline } from "./Sparkline";

const TYPE_LABEL = { rate: "Rate", count: "Count", sentinel: "Sentinel", drift: "Drift" };

export function AlertCard({
  alert,
  series,
  wards,
  cursorWeek,
  status,
}: {
  alert: AlertEpisode;
  series?: RateRow[];
  wards: Ward[];
  cursorWeek: number;
  status?: React.ReactNode;
}) {
  const last = series?.slice(-26) ?? [];
  const isRate = alert.type === "rate" || alert.type === "drift";
  const values = last.map((r) => (isRate ? (r.reportable ? r.pct_r : null) : r.n_resistant));
  const shadeFrom = last.findIndex((r) => r.end_week_idx >= alert.opened_week_idx);

  return (
    <article className="rounded-lg border border-line bg-surface p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <SeverityBadge severity={alert.severity} />
        <ConfidenceLabel confidence={alert.confidence} />
        <span className="text-xs text-muted">· {TYPE_LABEL[alert.type]} signal</span>
        <span className="ml-auto text-xs text-muted">
          <span className="capitalize">{alert.status}</span>
          {" · "}
          {alert.last_fired_week_idx === cursorWeek ? "fired this week" : `last fired ${cursorWeek - alert.last_fired_week_idx} wk ago`}
        </span>
      </div>
      <Link href={`/alerts/${encodeURIComponent(alert.alert_id)}`} className="block text-sm leading-snug hover:underline">
        {alert.headline}
      </Link>
      {last.length > 0 && (
        <div className="mt-2">
          <Sparkline
            values={values}
            labels={last.map((r) => r.week_label)}
            shadeFrom={shadeFrom < 0 ? last.length - 1 : shadeFrom}
            unit={isRate ? "%" : "n"}
          />
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
        <Chip>{scopeLabel(alert, wards)}</Chip>
        <Chip>{SPECIMEN_LABEL[alert.specimen]}</Chip>
        <Chip>
          <i>{shortOrganism(alert.organism)}</i> · {alert.marker}
        </Chip>
        {status && <div className="ml-auto">{status}</div>}
      </div>
    </article>
  );
}

export function Chip({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full border border-line bg-white px-2 py-0.5 text-ink-2">{children}</span>;
}
