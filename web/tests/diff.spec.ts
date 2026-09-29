import { expect, test } from "@playwright/test";
import { lineDiff } from "../src/diff";

test("review diff keeps unchanged lines and marks inserted and removed text", () => {
  expect(lineDiff("alpha\nold\nomega", "alpha\nnew\nomega")).toEqual([
    { kind: "same", text: "alpha" },
    { kind: "add", text: "new" },
    { kind: "remove", text: "old" },
    { kind: "same", text: "omega" },
  ]);
});
