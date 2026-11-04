import { expect, test } from "@playwright/test";
import { approvalLink, sortInvocations } from "../src/tasks/TaskToolTimeline";
import type { Doc } from "../src/api";

test("sortInvocations orders ascending by created_at (time-ordered timeline)", () => {
  const items: Doc[] = [
    { id: "inv-3", created_at: "2026-11-03T10:03:00Z" },
    { id: "inv-1", created_at: "2026-11-03T10:01:00Z" },
    { id: "inv-2", created_at: "2026-11-03T10:02:00Z" },
  ];
  expect(sortInvocations(items).map((i) => i.id)).toEqual([
    "inv-1",
    "inv-2",
    "inv-3",
  ]);
});

test("sortInvocations breaks ties on id and does not mutate input", () => {
  const items: Doc[] = [
    { id: "inv-b", created_at: "2026-11-03T10:00:00Z" },
    { id: "inv-a", created_at: "2026-11-03T10:00:00Z" },
  ];
  const sorted = sortInvocations(items);
  expect(sorted.map((i) => i.id)).toEqual(["inv-a", "inv-b"]);
  // Original array order is preserved (pure copy).
  expect(items.map((i) => i.id)).toEqual(["inv-b", "inv-a"]);
});

test("approvalLink deep-links to the project approval centre (O-W11)", () => {
  expect(approvalLink("p1", "ap-7")).toBe(
    "/projects/p1/approvals?approval=ap-7",
  );
  // Reserved characters in both ids are percent-encoded.
  expect(approvalLink("a/b", "ap/8")).toBe(
    "/projects/a%2Fb/approvals?approval=ap%2F8",
  );
});
