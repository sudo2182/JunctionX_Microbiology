import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { CheckCircle2, FlaskConical, Stethoscope, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/amr/shell";
import { clearNotice, signInAs, signUp, useAuth } from "@/lib/auth";
import { landingPath, ROLES, safeRedirect, type AppRole } from "@/lib/auth-rules";

export const Route = createFileRoute("/auth")({
  // ?redirect= returns the user to the page they were sent away from (same-site paths only).
  validateSearch: (search: Record<string, unknown>): { redirect?: string | undefined } => ({
    redirect: safeRedirect(search["redirect"]),
  }),
  head: () => ({
    meta: [
      { title: "Sign in — AMR Watch" },
      { name: "description", content: "Sign in to AMR Watch as a doctor or laboratory user." },
      { property: "og:title", content: "Sign in — AMR Watch" },
      { property: "og:description", content: "Sign in to AMR Watch." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const auth = useAuth();
  const { redirect } = Route.useSearch();
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const target = auth.userId && auth.activeRole ? landingPath(auth.activeRole, redirect) : null;

  // Signed in with an accepted role: go back where the user came from (a path that may carry ?query).
  useEffect(() => {
    if (target) router.history.replace(target);
  }, [target, router]);
  if (target) return null;

  return (
    <div className="flex min-h-[calc(100vh-140px)] items-center justify-center py-8">
      <div className="w-full max-w-md">
        <div className="mb-5 text-center">
          <h1 className="text-xl font-semibold">{mode === "signin" ? "Sign in to AMR Watch" : "Create an account"}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === "signin" ? "Choose how you are signing in, then enter your credentials." : "Choose your role. You will sign in with it from now on."}
          </p>
        </div>
        <section className="rounded-lg border bg-card p-5">
          {auth.notice && mode === "signin" && <Notice tone="info">{auth.notice}</Notice>}
          {mode === "signin" ? <SignInForm onSignUp={() => setMode("signup")} /> : <SignUpForm onBack={() => setMode("signin")} />}
        </section>
        <p className="mt-4 text-center text-xs text-muted-foreground">Synthetic surveillance data · Sessions end after 30 minutes of inactivity</p>
      </div>
    </div>
  );
}

function SignInForm({ onSignUp }: { onSignUp: () => void }) {
  const [role, setRole] = useState<AppRole | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!role) return setError("Choose whether you are signing in as a doctor or as the laboratory.");
    setBusy(true);
    setError(null);
    clearNotice();
    try {
      await signInAs(role, email, password); // AuthPage redirects once the session is accepted
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <RoleChoice legend="Log in as" value={role} onChange={(r) => { setRole(r); setError(null); }} />
      <Field label="Email">
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
      </Field>
      <Field label="Password">
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
      </Field>
      {error && <Notice tone="error">{error}</Notice>}
      <Button type="submit" disabled={busy || !email || !password}>
        {busy ? "Signing in…" : role ? `Sign in as ${ROLES[role].label}` : "Sign in"}
      </Button>
      <button type="button" className="text-xs text-muted-foreground underline" onClick={onSignUp}>No account? Create one</button>
    </form>
  );
}

function SignUpForm({ onBack }: { onBack: () => void }) {
  const [role, setRole] = useState<AppRole | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmEmail, setConfirmEmail] = useState(false);

  const problem =
    !role ? "Choose Doctor or Laboratory."
    : !/^\S+@\S+\.\S+$/.test(email.trim()) ? "Enter a valid email address."
    : password.length < 8 ? "Use a password of at least 8 characters."
    : password !== confirm ? "The passwords do not match."
    : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problem || !role) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      // "signed-in": AuthPage redirects to the role's page once the session is set.
      if ((await signUp({ email, password, role })) === "confirm-email") setConfirmEmail(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (confirmEmail)
    return (
      <div className="flex flex-col gap-4 text-sm">
        <div className="flex gap-3">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" />
          <div>
            <div className="font-medium">Account created</div>
            <p className="mt-1 text-muted-foreground">Confirm your email address with the link we sent, then sign in as {role ? ROLES[role].label : "your role"}.</p>
          </div>
        </div>
        <Button variant="outline" onClick={onBack}>Back to sign in</Button>
      </div>
    );

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <RoleChoice legend="Account type" value={role} onChange={(r) => { setRole(r); setError(null); }} />
      <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></Field>
      <Field label="Password"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></Field>
      <Field label="Confirm password"><Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" /></Field>
      {error && <Notice tone="error">{error}</Notice>}
      <Button type="submit" disabled={busy}>{busy ? "Creating account…" : role ? `Create ${ROLES[role].label} account` : "Create account"}</Button>
      <button type="button" className="text-xs text-muted-foreground underline" onClick={onBack}>Already have an account? Sign in</button>
    </form>
  );
}

function RoleChoice({ legend, value, onChange }: { legend: string; value: AppRole | null; onChange: (r: AppRole) => void }) {
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      <div role="radiogroup" aria-label={legend} className="grid grid-cols-2 gap-2">
        {(["doctor", "lab"] as const).map((r) => {
          const Icon = r === "doctor" ? Stethoscope : FlaskConical;
          const on = value === r;
          return (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(r)}
              className={`flex flex-col items-start gap-1 rounded-md border p-3 text-left transition-colors ${on ? "border-primary bg-primary/10 ring-1 ring-primary" : "hover:border-primary/60"}`}
            >
              <span className="flex items-center gap-2 text-sm font-medium"><Icon className="h-4 w-4 text-primary" />{ROLES[r].label}</span>
              <span className="text-xs leading-snug text-muted-foreground">{ROLES[r].description}</span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function Notice({ tone, children }: { tone: "error" | "info"; children: string }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`mb-1 flex gap-2 rounded-md border p-3 text-sm ${tone === "error" ? "border-destructive/50 bg-destructive/10" : "border-warning bg-warning/15"}`}
    >
      <TriangleAlert className={`mt-0.5 h-4 w-4 shrink-0 ${tone === "error" ? "text-destructive" : "text-warning"}`} />
      <span>{children}</span>
    </div>
  );
}
