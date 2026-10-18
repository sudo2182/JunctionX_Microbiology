import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { Link, Navigate, useRouterState } from "@tanstack/react-router";
import { Activity } from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import {
  IDLE_LIMIT_MS,
  ROLES,
  friendlyAuthError,
  isIdle,
  isRole,
  loginDecision,
  parseRoles,
  restoreActiveRole,
  type AppRole,
} from "./auth-rules";

export type { AppRole } from "./auth-rules";

export type AuthState = {
  userId: string | null;
  email: string | null;
  /** Every role the account holds (from user_roles). */
  roles: AppRole[];
  /** The role chosen on the login screen. Pages and navigation follow this one. */
  activeRole: AppRole | null;
  loading: boolean;
  /** Why the user was signed out (shown on the login page), e.g. inactivity. */
  notice: string | null;
};

const ACTIVE_KEY = "amr.auth.activeRole";
const LAST_ACTIVE_KEY = "amr.auth.lastActive";

// Storage can be unavailable (private mode, blocked site data); auth must still work without it.
const storage = {
  get: (k: string) => { try { return window.localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { window.localStorage.setItem(k, v); } catch { /* not persisted */ } },
  remove: (k: string) => { try { window.localStorage.removeItem(k); } catch { /* nothing stored */ } },
};

function readJson(k: string): unknown {
  try { return JSON.parse(storage.get(k) ?? "null"); } catch { return null; }
}

function readLastActive(): number | null {
  const n = Number(storage.get(LAST_ACTIVE_KEY) ?? Number.NaN);
  return Number.isFinite(n) ? n : null;
}

let lastWrite = 0;
/** Records user activity; shared through localStorage so activity in any tab keeps every tab signed in. */
function touch(force = false) {
  const now = Date.now();
  if (force || now - lastWrite > 15_000) {
    lastWrite = now;
    storage.set(LAST_ACTIVE_KEY, String(now));
  }
}

// user_roles is not in the generated Database types; use a loosely typed handle.
type Result = PromiseLike<{ data: Record<string, unknown>[] | null; error: { message: string; code?: string } | null }>;
type Loose = {
  from: (t: string) => {
    select: (c: string) => { eq: (c: string, v: string) => Result };
    insert: (r: object) => PromiseLike<{ error: { message: string; code?: string } | null }>;
  };
};
const db = () => supabase as unknown as Loose;

async function fetchRoles(uid: string): Promise<AppRole[]> {
  const { data, error } = await db().from("user_roles").select("role").eq("user_id", uid);
  if (error) throw new Error(`Could not check your access: ${error.message}`);
  return parseRoles(data as { role: unknown }[] | null);
}

/** Saves the role chosen at sign-up in user_roles (row-level security only lets users add their own). */
async function saveRole(uid: string, role: AppRole) {
  const { error } = await db().from("user_roles").insert({ user_id: uid, role });
  if (error && error.code !== "23505") throw new Error(`Could not save your role: ${error.message}`); // 23505: already saved
}

// One shared auth store for the whole app, so every component sees the same session and role.
let state: AuthState = { userId: null, email: null, roles: [], activeRole: null, loading: true, notice: null };
const listeners = new Set<() => void>();
let started = false;
let signingIn = false;
let verifiedFor: string | null = null;

function set(patch: Partial<AuthState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

/** Ends the session on this device and clears the remembered role. */
export async function signOut(notice: string | null = null) {
  storage.remove(ACTIVE_KEY);
  storage.remove(LAST_ACTIVE_KEY);
  verifiedFor = null;
  set({ userId: null, email: null, roles: [], activeRole: null, loading: false, notice });
  await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
}

/**
 * Checks a session the browser already has (page load, other tab, token refresh). It is only accepted
 * with a role chosen at login that the account still holds; otherwise the user must sign in again.
 */
async function verify(session: Session | null, recheck: boolean) {
  const uid = session?.user?.id ?? null;
  if (!uid) {
    verifiedFor = null;
    if (state.userId || state.loading) set({ userId: null, email: null, roles: [], activeRole: null, loading: false });
    return;
  }
  if (signingIn) return; // signInAs finishes the job
  if (!recheck && verifiedFor === uid && state.userId === uid) return;
  if (isIdle(readLastActive(), Date.now())) return signOut("You were signed out after 30 minutes of inactivity.");

  const wasActive = state.activeRole !== null;
  let roles: AppRole[];
  try {
    roles = await fetchRoles(uid);
  } catch {
    return signOut("Your access could not be verified. Sign in again.");
  }
  const active = restoreActiveRole(readJson(ACTIVE_KEY), uid, roles);
  if (!active) return signOut(wasActive ? "Your access has changed. Sign in again." : null);
  verifiedFor = uid;
  set({ userId: uid, email: session?.user?.email ?? null, roles, activeRole: active, loading: false });
}

/** Signs in and checks the account holds the role chosen on the login screen. Throws a readable message if not. */
export async function signInAs(role: AppRole, email: string, password: string): Promise<AppRole> {
  signingIn = true;
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error || !data.user) throw new Error(friendlyAuthError(error?.message ?? "Sign-in failed."));
    const uid = data.user.id;
    try {
      let roles = await fetchRoles(uid);
      // First sign-in after confirming the email: the role chosen at sign-up is stored with the account.
      const signedUpAs = data.user.user_metadata?.["role"];
      if (!roles.length && isRole(signedUpAs)) {
        await saveRole(uid, signedUpAs);
        roles = [signedUpAs];
      }
      const decision = loginDecision(role, roles);
      if (!decision.ok) throw new Error(decision.message);
      storage.set(ACTIVE_KEY, JSON.stringify({ userId: uid, role }));
      touch(true);
      verifiedFor = uid;
      set({ userId: uid, email: data.user.email ?? null, roles, activeRole: role, loading: false, notice: null });
      return role;
    } catch (e) {
      await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
      throw e;
    }
  } finally {
    signingIn = false;
  }
}

/**
 * Creates an account with one role. If Supabase signs the user in straight away, the role is saved and they are
 * signed in; if email confirmation is required, the role is saved on their first sign-in.
 */
export async function signUp(input: { email: string; password: string; role: AppRole }): Promise<"signed-in" | "confirm-email"> {
  signingIn = true;
  try {
    const { data, error } = await supabase.auth.signUp({
      email: input.email.trim(),
      password: input.password,
      options: { emailRedirectTo: `${window.location.origin}/auth`, data: { role: input.role } },
    });
    if (error) throw new Error(friendlyAuthError(error.message));
    if (!data.session || !data.user) return "confirm-email";
    const uid = data.user.id;
    try {
      await saveRole(uid, input.role);
    } catch (e) {
      await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
      throw e;
    }
    storage.set(ACTIVE_KEY, JSON.stringify({ userId: uid, role: input.role }));
    touch(true);
    verifiedFor = uid;
    set({ userId: uid, email: data.user.email ?? null, roles: [input.role], activeRole: input.role, loading: false, notice: null });
    return "signed-in";
  } finally {
    signingIn = false;
  }
}

export function clearNotice() {
  if (state.notice) set({ notice: null });
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  // Fires INITIAL_SESSION on subscribe, then SIGNED_IN / SIGNED_OUT / TOKEN_REFRESHED (also from other tabs).
  // Deferred so Supabase calls never run inside the auth callback.
  supabase.auth.onAuthStateChange((event, s) => {
    setTimeout(() => void verify(s, event === "TOKEN_REFRESHED" || event === "USER_UPDATED"), 0);
  });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
const serverState: AuthState = { userId: null, email: null, roles: [], activeRole: null, loading: true, notice: null };

export function useAuth(): AuthState {
  useEffect(start, []);
  return useSyncExternalStore(subscribe, () => state, () => serverState);
}

/** Signs the user out after IDLE_LIMIT_MS without activity in any tab. */
export function useIdleSignOut(onTimeout: () => void) {
  const { activeRole } = useAuth();
  useEffect(() => {
    if (!activeRole) return;
    touch(true);
    const onActivity = () => touch();
    const events = ["pointerdown", "keydown", "scroll", "touchstart"] as const;
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    const check = () => { if (isIdle(readLastActive(), Date.now(), IDLE_LIMIT_MS)) onTimeout(); };
    const timer = window.setInterval(check, 30_000);
    document.addEventListener("visibilitychange", check);
    return () => {
      events.forEach((e) => window.removeEventListener(e, onActivity));
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [activeRole, onTimeout]);
}

function Checking() {
  return (
    <div className="flex h-64 items-center justify-center gap-3 text-muted-foreground">
      <Activity className="h-5 w-5 animate-pulse text-primary" /> Checking sign-in…
    </div>
  );
}

/** The whole dashboard requires a signed-in user with a role chosen at login. Only /auth is public. */
export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const href = useRouterState({ select: (s) => s.location.href });
  if (pathname === "/auth") return <>{children}</>;
  if (auth.loading) return <Checking />;
  if (!auth.userId || !auth.activeRole) return <Navigate to="/auth" search={{ redirect: href }} replace />;
  return <>{children}</>;
}

/** Limits a page to the role chosen at login. The database enforces the same rules server-side. */
export function RequireRole({ role, children }: { role: AppRole; children: ReactNode }) {
  const { activeRole } = useAuth();
  if (activeRole === role) return <>{children}</>;
  return (
    <div className="p-10 text-center text-sm text-muted-foreground">
      This page is for {ROLES[role].label.toLowerCase()} accounts.
      {activeRole && (
        <>
          {" "}You are signed in as {ROLES[activeRole].label.toLowerCase()}.{" "}
          <Link to={ROLES[activeRole].home} className="text-primary underline">Go to your page</Link>
        </>
      )}
    </div>
  );
}
