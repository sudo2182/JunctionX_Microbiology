import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, type ReactNode } from "react";
import { Activity, Building2, Database, FlaskConical, LogOut, Map, Newspaper, Radar, Stethoscope } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useAmr } from "@/lib/amr/store";
import { AuthGate, signOut, useAuth, useIdleSignOut } from "@/lib/auth";
import { ROLES } from "@/lib/auth-rules";
import { Assistant } from "@/components/amr/assistant";

const NAV = [
  { to: "/", label: "Hospital atlas", icon: Building2 },
  { to: "/map", label: "Spatial & trends", icon: Map },
  { to: "/wards", label: "Ward resistance", icon: Building2 },
  { to: "/detection", label: "Cluster detection", icon: Radar },
  { to: "/records", label: "Records", icon: Database },
  { to: "/announcements", label: "ECDC announcements", icon: Newspaper },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const signedIn = Boolean(auth.userId && auth.activeRole);

  // Doctors get the Patients tab, lab users the Laboratory tab, following the role chosen at login.
  const roleNav = [
    ...(auth.activeRole === "doctor" ? [{ to: "/patients", label: "Patients", icon: Stethoscope }] : []),
    ...(auth.activeRole === "lab" ? [{ to: "/lab", label: "Laboratory", icon: FlaskConical }] : []),
  ] as const;

  const endSession = useCallback(
    async (notice: string | null = null) => {
      await queryClient.cancelQueries();
      queryClient.clear();
      await signOut(notice);
      navigate({ to: "/auth", replace: true });
    },
    [queryClient, navigate],
  );
  const onIdle = useCallback(() => void endSession("You were signed out after 30 minutes of inactivity."), [endSession]);
  useIdleSignOut(onIdle);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-8 px-4 md:px-7">
          <Link to="/" className="flex items-center gap-2 py-2 text-primary" aria-label="AMR Watch home">
            <Activity className="h-5 w-5" />
            <span className="text-xl font-semibold">AMR Watch</span>
          </Link>
          {signedIn && (
            <nav aria-label="Main navigation" className="order-3 flex w-full gap-1 overflow-x-auto lg:order-none lg:w-auto lg:flex-1">
            {[...roleNav, ...NAV].map((n) => (
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
          )}
          <span className="ml-auto text-xs text-muted-foreground">Synthetic surveillance data</span>
          {signedIn && auth.activeRole && (
            <div className="flex items-center gap-2 py-2">
              <span className="hidden text-right text-xs leading-tight sm:block">
                <span className="block font-medium">{ROLES[auth.activeRole].label}</span>
                <span className="block text-muted-foreground">{auth.email}</span>
              </span>
              <Button variant="ghost" size="sm" className="gap-2 text-xs" onClick={() => void endSession()}>
                <LogOut className="h-4 w-4" />
                Sign out
              </Button>
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1600px] flex-1 p-3 md:px-5 md:py-4">
        <AuthGate>{children}</AuthGate>
      </main>
      {signedIn && <Assistant />}
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
