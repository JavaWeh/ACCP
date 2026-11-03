import { expect, test } from "@playwright/test";
import {
  MAX_SAVED_VIEWS,
  parseSavedViews,
  removeSavedView,
  savedViewsKey,
  serializeSavedViews,
  upsertSavedView,
  type SavedView,
} from "../src/tasks/savedViews";
import { bulkSummary, runBulk } from "../src/tasks/bulkActions";

test("parseSavedViews tolerates corruption and drops bad entries", () => {
  expect(parseSavedViews(null)).toEqual([]);
  expect(parseSavedViews("not json")).toEqual([]);
  expect(parseSavedViews('{"not":"array"}')).toEqual([]);
  expect(
    parseSavedViews(
      JSON.stringify([
        { name: "Review", search: "?status=IN_REVIEW" },
        { name: "  ", search: "?x=1" }, // blank name dropped
        { name: "NoSearch" }, // missing search dropped
        { name: "review", search: "?dup" }, // case-insensitive duplicate dropped
        42, // non-object dropped
      ]),
    ),
  ).toEqual([{ name: "Review", search: "?status=IN_REVIEW" }]);
});

test("parseSavedViews caps at MAX_SAVED_VIEWS", () => {
  const many = Array.from({ length: MAX_SAVED_VIEWS + 5 }, (_, i) => ({
    name: `v${i}`,
    search: `?q=${i}`,
  }));
  expect(parseSavedViews(JSON.stringify(many))).toHaveLength(MAX_SAVED_VIEWS);
});

test("upsertSavedView overwrites by case-insensitive name and caps length", () => {
  let views: SavedView[] = [{ name: "Mine", search: "?owner=me" }];
  views = upsertSavedView(views, "mine", "?owner=me&status=BLOCKED");
  expect(views).toEqual([{ name: "mine", search: "?owner=me&status=BLOCKED" }]);

  // Fill beyond the cap; oldest is dropped.
  for (let i = 0; i < MAX_SAVED_VIEWS + 3; i++) {
    views = upsertSavedView(views, `v${i}`, `?q=${i}`);
  }
  expect(views).toHaveLength(MAX_SAVED_VIEWS);
  expect(views.some((v) => v.name === "mine")).toBe(false);
});

test("removeSavedView removes by case-insensitive name", () => {
  const views: SavedView[] = [
    { name: "A", search: "?a" },
    { name: "B", search: "?b" },
  ];
  expect(removeSavedView(views, "a")).toEqual([{ name: "B", search: "?b" }]);
});

test("serialize/parse round-trips", () => {
  const views: SavedView[] = [{ name: "Blocked", search: "?status=BLOCKED" }];
  expect(parseSavedViews(serializeSavedViews(views))).toEqual(views);
});

test("savedViewsKey is namespaced per project", () => {
  expect(savedViewsKey("proj-1")).toBe("accp.task-views.proj-1");
});

test("runBulk runs sequentially and isolates per-item failures", async () => {
  const order: string[] = [];
  const results = await runBulk(["a", "b", "c"], async (id) => {
    order.push(id);
    if (id === "b") throw new Error("boom");
  });
  expect(order).toEqual(["a", "b", "c"]); // sequential, continues past failure
  expect(results.map((r) => [r.id, r.ok])).toEqual([
    ["a", true],
    ["b", false],
    ["c", true],
  ]);
});

test("bulkSummary partitions succeeded and failed", () => {
  const { succeeded, failed } = bulkSummary([
    { id: "a", ok: true },
    { id: "b", ok: false, error: new Error("x") },
  ]);
  expect(succeeded).toEqual(["a"]);
  expect(failed).toHaveLength(1);
  expect(failed[0].id).toBe("b");
});
