import { describe, expect, it } from "vitest";
import { applyWaitingChange, type CultureRequest } from "@/lib/amr/cultures";

const req = (id: string, created_at: string, status: CultureRequest["status"] = "pending") =>
  ({ id, culture_id: `C-${id}`, created_at, status }) as CultureRequest;

describe("applyWaitingChange", () => {
  const list = [req("a", "2026-10-18T08:00:00Z"), req("c", "2026-10-18T10:00:00Z")];

  it("adds a newly sent request in order (oldest first)", () => {
    const next = applyWaitingChange(list, { eventType: "INSERT", new: req("b", "2026-10-18T09:00:00Z") });
    expect(next.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
  it("does not duplicate a request that is already listed", () => {
    expect(applyWaitingChange(list, { eventType: "INSERT", new: req("a", "2026-10-18T08:00:00Z") })).toHaveLength(2);
  });
  it("removes a request once any lab user completes it", () => {
    const next = applyWaitingChange(list, { eventType: "UPDATE", new: req("a", "2026-10-18T08:00:00Z", "completed") });
    expect(next.map((r) => r.id)).toEqual(["c"]);
  });
  it("removes a deleted request", () => {
    expect(applyWaitingChange(list, { eventType: "DELETE", old: { id: "c" } }).map((r) => r.id)).toEqual(["a"]);
  });
  it("ignores changes without an id", () => {
    expect(applyWaitingChange(list, { eventType: "INSERT", new: {} })).toBe(list);
  });
});
