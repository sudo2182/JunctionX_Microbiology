/** Pure sign-in rules, kept apart from Supabase and React so they can be unit-tested. */

export type AppRole = "doctor" | "lab";

export const ROLES: Record<AppRole, { label: string; home: "/patients" | "/lab"; description: string }> = {
  doctor: { label: "Doctor", home: "/patients", description: "Request cultures, follow results, estimate resistance risk" },
  lab: { label: "Laboratory", home: "/lab", description: "Receive specimens, enter and release culture results" },
};

/** Clinical systems sign users out after a period without activity. */
export const IDLE_LIMIT_MS = 30 * 60 * 1000;

export function isRole(v: unknown): v is AppRole {
  return v === "doctor" || v === "lab";
}

export function parseRoles(rows: { role: unknown }[] | null | undefined): AppRole[] {
  return [...new Set((rows ?? []).map((r) => r.role).filter(isRole))];
}

/** May this account sign in as the role chosen on the login screen? Returns the reason if not. */
export function loginDecision(chosen: AppRole, held: AppRole[]): { ok: true } | { ok: false; message: string } {
  if (held.includes(chosen)) return { ok: true };
  if (held.length > 0) {
    const other = held.map((r) => ROLES[r].label).join(" or ");
    return { ok: false, message: `This account is registered as ${other}, not ${ROLES[chosen].label}. Choose ${other} to sign in.` };
  }
  return { ok: false, message: "This account has no role yet. Create an account and choose Doctor or Laboratory." };
}

/**
 * The role chosen at login, as remembered for this browser. Only valid for the same user and only
 * while they still hold the role, so a revoked role ends the session on the next check.
 */
export function restoreActiveRole(stored: unknown, userId: string, held: AppRole[]): AppRole | null {
  if (!stored || typeof stored !== "object") return null;
  const s = stored as { userId?: unknown; role?: unknown };
  return s.userId === userId && isRole(s.role) && held.includes(s.role) ? s.role : null;
}

export function isIdle(lastActive: number | null, now: number, limit = IDLE_LIMIT_MS): boolean {
  return lastActive !== null && Number.isFinite(lastActive) && now - lastActive > limit;
}

/** Only same-site paths are allowed as a post-login redirect (no open redirects). */
export function safeRedirect(path: unknown): string | undefined {
  if (typeof path !== "string" || path.length > 200) return undefined;
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.startsWith("/auth")) return undefined;
  return path;
}

/** Where to go after signing in: the page the user was sent away from, unless it belongs to the other role. */
export function landingPath(role: AppRole, redirect: string | undefined): string {
  const otherHome = Object.entries(ROLES).find(([r]) => r !== role)?.[1].home;
  if (!redirect || redirect === "/" || (otherHome && (redirect === otherHome || redirect.startsWith(`${otherHome}?`)))) return ROLES[role].home;
  return redirect;
}

/** Turns Supabase auth errors into messages a clinician can act on. */
export function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid login credentials")) return "Email or password is incorrect.";
  if (m.includes("email not confirmed")) return "Confirm your email address first, using the link we sent you.";
  if (m.includes("already registered")) return "An account with this email already exists. Sign in instead.";
  if (m.includes("rate limit") || m.includes("too many")) return "Too many attempts. Wait a minute and try again.";
  if (m.includes("password") && m.includes("characters")) return "The password is too short.";
  return message;
}
