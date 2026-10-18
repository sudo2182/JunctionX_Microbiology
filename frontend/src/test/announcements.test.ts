import { describe, expect, it } from "vitest";
import { hoursSince } from "@/lib/amr/announcements";

describe("hoursSince", () => {
  const now = Date.parse("2026-10-18T12:00:00Z");
  it("measures hours since the last successful check", () => {
    expect(hoursSince("2026-10-18T06:00:00Z", now)).toBe(6);
  });
  it("is null when there has been no check or the date is unreadable", () => {
    expect(hoursSince(null, now)).toBeNull();
    expect(hoursSince("not a date", now)).toBeNull();
  });
  it("never goes negative if the clocks disagree", () => {
    expect(hoursSince("2026-10-18T13:00:00Z", now)).toBe(0);
  });
});
