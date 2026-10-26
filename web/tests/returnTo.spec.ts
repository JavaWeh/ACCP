import { expect, test } from "@playwright/test";
import { buildReturnTo, sanitizeReturnTo } from "../src/returnTo";
import { readRoute } from "../src/routing";

const origin = "https://console.example.test";

test("buildReturnTo joins pathname, search, and hash", () => {
  expect(
    buildReturnTo({
      pathname: "/projects/p1/tasks",
      search: "?status=IN_PROGRESS&sort=updated_at&order=desc",
      hash: "#t-42",
    }),
  ).toBe(
    "/projects/p1/tasks?status=IN_PROGRESS&sort=updated_at&order=desc#t-42",
  );
});

test("sanitizeReturnTo keeps same-origin path with query and hash", () => {
  expect(
    sanitizeReturnTo("/projects/p1/tasks?status=IN_PROGRESS#t-42", origin),
  ).toBe("/projects/p1/tasks?status=IN_PROGRESS#t-42");
});

test("sanitizeReturnTo rejects protocol-relative open redirects", () => {
  expect(sanitizeReturnTo("//evil.example/x", origin)).toBe("/");
  expect(sanitizeReturnTo("https://evil.example/x", origin)).toBe("/");
  expect(sanitizeReturnTo("/\\evil.example/x", origin)).toBe("/");
});

test("sanitizeReturnTo rejects auth callback paths", () => {
  expect(sanitizeReturnTo("/auth/callback", origin)).toBe("/");
  expect(sanitizeReturnTo("/dev-login?returnTo=%2F", origin)).toBe("/");
});

test("readRoute marks unknown page segments invalid instead of overview", () => {
  expect(readRoute("/projects/p1/not-a-page")).toEqual({
    projectID: "p1",
    page: "overview",
    invalid: true,
  });
  expect(readRoute("/projects/p1/tasks/extra/segment")).toEqual({
    projectID: "p1",
    page: "tasks",
    invalid: true,
  });
  expect(readRoute("/projects/p1/tasks")).toEqual({
    projectID: "p1",
    page: "tasks",
  });
  expect(readRoute("/projects/%E0%A4%A/overview").invalid).toBe(true);
});
