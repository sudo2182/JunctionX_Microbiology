import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Activity, Building2, Database, Map, Newspaper, Radar, Stethoscope } from "lucide-react";
import { useAmr } from "@/lib/amr/store";

const NAV = [
  { to: "/", label: "Hospital atlas", icon: Building2 },
  { to: "/map", label: "Spatial & trends", icon: Map },
  { to: "/wards", label: "Ward resistance", icon: Building2 },
  { to: "/detection", label: "Cluster detection", icon: Radar },
  { to: "/risk", label: "Risk predictor", icon: Stethoscope },
  { to: "/records", label: "Records", icon: Database },
  { to: "/announcements", label: "ECDC announcements", icon: Newspaper },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-8 px-4 md:px-7">
          <Link to="/" className="flex items-center gap-2 py-2 text-primary" aria-label="AMR Watch home">
            <Activity className="h-5 w-5" />
            <span className="text-xl font-semibold">AMR Watch</span>
          </Link>
          <nav aria-label="Main navigation" className="order-3 flex w-full gap-1 overflow-x-auto lg:order-none lg:w-auto lg:flex-1">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              activeOptions={{ exact: n.to === "/" }}
              className="flex shrink-0 items-center gap-2 border-b-2 border-transparent px-3 py-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-primary"
              activeProps={{ className: "border-primary text-primary" }}
            >
              <n.icon className="h-4 w-4" />
              {n.label}
            </Link>
          ))}
          </nav>
          <span className="ml-auto text-xs text-muted-foreground">Synthetic surveillance data</span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1600px] flex-1 p-3 md:px-5 md:py-4">{children}</main>
    </div>
  );
}

export function PageHeader({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3 border-b pb-2">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1 className="text-xl font-semibold">{title}</h1>
      </div>
      <div className="flex flex-wrap items-end gap-3">{children}</div>
    </div>
  );
}

export function DataGate({ children }: { children: ReactNode }) {
  const { status } = useAmr();
  if (status === "error") return <div className="p-10 text-destructive">Could not load the dataset.</div>;
  if (status !== "ready")
    return (
      <div className="flex h-64 items-center justify-center gap-3 text-muted-foreground">
        <Activity className="h-5 w-5 animate-pulse text-primary" /> Loading surveillance data…
      </div>
    );
  return <>{children}</>;
}

export function Panel({ title, children, right, className = "" }: { title?: string; children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border bg-card p-3 ${className}`}>
      {title && (
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="eyebrow">{title}</h2>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="eyebrow">{label}</span>
      {children}
    </label>
  );
}

export function heatVar(pct: number | null) {
  if (pct == null) return "var(--muted)";
  const i = pct < 5 ? 0 : pct < 10 ? 1 : pct < 20 ? 2 : pct < 40 ? 3 : 4;
  return `var(--heat-${i})`;
}
