import { describe, expect, it } from "vitest";
import { friendlyAuthError, isIdle, landingPath, loginDecision, parseRoles, restoreActiveRole, safeRedirect } from "@/lib/auth-rules";

describe("loginDecision", () => {
  it("lets an account sign in as a role it holds", () => {
    expect(loginDecision("lab", ["lab"])).toEqual({ ok: true });
    expect(loginDecision("doctor", ["doctor", "lab"])).toEqual({ ok: true });
  });
  it("refuses a role the account does not hold and names the one it does", () => {
    const d = loginDecision("lab", ["doctor"]);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.message).toContain("registered as Doctor");
  });
  it("refuses an account with no role", () => {
    expect(loginDecision("doctor", []).ok).toBe(false);
  });
});

describe("restoreActiveRole", () => {
  it("restores the role chosen at login for the same user", () => {
    expect(restoreActiveRole({ userId: "u1", role: "lab" }, "u1", ["lab"])).toBe("lab");
  });
  it("ignores a role remembered for another user", () => {
    expect(restoreActiveRole({ userId: "u2", role: "lab" }, "u1", ["lab"])).toBeNull();
  });
  it("drops a role that has since been revoked", () => {
    expect(restoreActiveRole({ userId: "u1", role: "lab" }, "u1", ["doctor"])).toBeNull();
  });
  it("ignores missing or malformed storage", () => {
    expect(restoreActiveRole(null, "u1", ["lab"])).toBeNull();
    expect(restoreActiveRole("lab", "u1", ["lab"])).toBeNull();
    expect(restoreActiveRole({ userId: "u1", role: "admin" }, "u1", ["lab"])).toBeNull();
  });
});

describe("parseRoles", () => {
  it("keeps known roles once and drops anything else", () => {
    expect(parseRoles([{ role: "lab" }, { role: "lab" }, { role: "admin" }, { role: "doctor" }])).toEqual(["lab", "doctor"]);
    expect(parseRoles(null)).toEqual([]);
  });
});

describe("isIdle", () => {
  const now = 10_000_000;
  it("is idle only after the limit has passed", () => {
    expect(isIdle(now - 31 * 60_000, now)).toBe(true);
    expect(isIdle(now - 29 * 60_000, now)).toBe(false);
  });
  it("is not idle without a recorded activity time", () => {
    expect(isIdle(null, now)).toBe(false);
    expect(isIdle(Number.NaN, now)).toBe(false);
  });
});

describe("safeRedirect", () => {
  it("allows same-site paths", () => {
    expect(safeRedirect("/wards")).toBe("/wards");
    expect(safeRedirect("/records?q=C1")).toBe("/records?q=C1");
  });
  it("rejects external, protocol-relative and login-page redirects", () => {
    expect(safeRedirect("https://evil.example")).toBeUndefined();
    expect(safeRedirect("//evil.example")).toBeUndefined();
    expect(safeRedirect("/\\evil.example")).toBeUndefined();
    expect(safeRedirect("/auth")).toBeUndefined();
    expect(safeRedirect(42)).toBeUndefined();
  });
});

describe("landingPath", () => {
  it("returns to the page the user came from", () => {
    expect(landingPath("doctor", "/wards")).toBe("/wards");
  });
  it("goes to the role's own page by default or when the redirect belongs to the other role", () => {
    expect(landingPath("lab", undefined)).toBe("/lab");
    expect(landingPath("lab", "/")).toBe("/lab");
    expect(landingPath("doctor", "/lab")).toBe("/patients");
    expect(landingPath("lab", "/patients?x=1")).toBe("/lab");
  });
});

describe("friendlyAuthError", () => {
  it("rewrites common Supabase errors", () => {
    expect(friendlyAuthError("Invalid login credentials")).toBe("Email or password is incorrect.");
    expect(friendlyAuthError("Email not confirmed")).toContain("Confirm your email");
  });
  it("passes unknown errors through", () => {
    expect(friendlyAuthError("Network down")).toBe("Network down");
  });
});
