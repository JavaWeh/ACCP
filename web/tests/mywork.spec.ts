// Pure/unit coverage for the "My Work" page. The deep-link builders are
// extracted as module-level pure functions and tested directly here. The
// three-group render order (review → approval → blocked), the loading/error/
// empty states, and the 10s poll remain residual e2e (they need React + a live
// api.call and a browser); those are exercised by the managed-server ui specs.
import { expect, test } from "@playwright/test";
import {
  approvalHref,
  taskHref,
  type WorkApprovalItem,
  type WorkTaskItem,
} from "../src/app/MyWork";
import { readRoute } from "../src/routing";

const taskItem: WorkTaskItem = {
  project_id: "p1",
  project_name: "Project One",
  task_id: "t-42",
  title: "Review me",
  status: "IN_REVIEW",
  waiting_since: "2026-10-29T00:00:00Z",
};

const approvalItem: WorkApprovalItem = {
  project_id: "p2",
  project_name: "Project Two",
  approval_id: "a-7",
  invocation_id: "inv-7",
  task_id: "t-99",
  title: "Approve me",
  waiting_since: "2026-10-29T00:00:00Z",
};

test("taskHref deep-links to the project-scoped task route", () => {
  expect(taskHref(taskItem)).toBe("/projects/p1/tasks/t-42");
  // The resulting path parses back to a valid tasks route carrying the id.
  expect(readRoute(taskHref(taskItem))).toEqual({
    projectID: "p1",
    page: "tasks",
    taskID: "t-42",
  });
});

test("approvalHref deep-links to the project's approvals list", () => {
  expect(approvalHref(approvalItem)).toBe("/projects/p2/approvals");
  expect(readRoute(approvalHref(approvalItem))).toEqual({
    projectID: "p2",
    page: "approvals",
  });
});

test("deep-link builders percent-encode ids with reserved characters", () => {
  expect(taskHref({ ...taskItem, project_id: "a/b", task_id: "t 1" })).toBe(
    "/projects/a%2Fb/tasks/t%201",
  );
  expect(approvalHref({ ...approvalItem, project_id: "a/b" })).toBe(
    "/projects/a%2Fb/approvals",
  );
});
