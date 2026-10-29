import { expect, test } from "@playwright/test";
import { readRoute, routePath } from "../src/routing";

test("readRoute recognizes the /me/work cross-project route", () => {
  expect(readRoute("/me/work")).toEqual({ kind: "work" });
  // Query/hash are stripped before matching, so the route stays valid.
  expect(readRoute("/me/work?x=1#top")).toEqual({ kind: "work" });
});

test("readRoute marks unknown /me/... segments invalid", () => {
  expect(readRoute("/me/foo")).toEqual({ kind: "work", invalid: true });
  expect(readRoute("/me/other")).toEqual({ kind: "work", invalid: true });
  // Bare /me has no "work" segment, so it degrades to the invalid work page.
  expect(readRoute("/me")).toEqual({ kind: "work", invalid: true });
  // Extra path parts past /me/work are also invalid.
  expect(readRoute("/me/work/extra")).toEqual({ kind: "work", invalid: true });
});

test("routePath builds the work route path", () => {
  expect(routePath({ kind: "work" })).toBe("/me/work");
  expect(routePath({ kind: "work", invalid: true })).toBe("/me/work");
});

test("readRoute keeps the historical project route shape (no kind tag)", () => {
  expect(readRoute("/projects/p1")).toEqual({
    projectID: "p1",
    page: "overview",
  });
  expect(readRoute("/projects/p1/approvals")).toEqual({
    projectID: "p1",
    page: "approvals",
  });
  expect(readRoute("/projects/p1/tasks/t-42")).toEqual({
    projectID: "p1",
    page: "tasks",
    taskID: "t-42",
  });
  // Root and empty project id fall back to the overview sentinel.
  expect(readRoute("/")).toEqual({ projectID: "", page: "overview" });
});

test("routePath round-trips project routes", () => {
  for (const path of [
    "/projects/p1/overview",
    "/projects/p1/approvals",
    "/projects/p1/tasks/t-42",
  ]) {
    expect(routePath(readRoute(path))).toBe(path);
  }
  // A bare project id normalizes to its overview page on the way back out.
  expect(routePath(readRoute("/projects/p1"))).toBe("/projects/p1/overview");
  // Ids with reserved characters are percent-encoded by routePath.
  expect(routePath({ projectID: "a/b", page: "overview" })).toBe(
    "/projects/a%2Fb/overview",
  );
});
