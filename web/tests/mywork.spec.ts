// Pure/unit coverage for the "My Work" page. The deep-link builders and the
// view-state decision (`myWorkViewState`) are extracted as module-level pure
// functions and tested directly here. In particular the partial-failure
// decision (keep last good groups + banner when a refresh fails with prior
// data, vs. whole-page error only on first load) is unit-tested below. The
// full React render of the warning Alert, the three-group render order
// (review → approval → blocked), and the 10s poll remain residual e2e (they
// need React + a live api.call and a browser); those are exercised by the
// managed-server ui specs.
import { expect, test } from "@playwright/test";
import {
  approvalHref,
  myWorkViewState,
  taskHref,
  type WorkApprovalItem,
  type WorkQueue,
  type WorkTaskItem,
} from "../src/app/MyWork";
import { readRoute } from "../src/routing";

function queue(counts: {
  review?: number;
  approval?: number;
  blocked?: number;
}): WorkQueue {
  const taskItems = (n = 0): WorkTaskItem[] =>
    Array.from({ length: n }, (_, i) => ({ ...taskItem, task_id: `t-${i}` }));
  const approvalItems = (n = 0): WorkApprovalItem[] =>
    Array.from({ length: n }, (_, i) => ({
      ...approvalItem,
      approval_id: `a-${i}`,
    }));
  return {
    groups: {
      review: { items: taskItems(counts.review) },
      approval: { items: approvalItems(counts.approval) },
      blocked: { items: taskItems(counts.blocked) },
    },
    checked_at: "2026-10-29T00:00:00Z",
  };
}

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

test("myWorkViewState: no data + error is a whole-page failure", () => {
  const error = new Error("boom");
  expect(myWorkViewState({ data: undefined, error, loading: false })).toBe(
    "full-error",
  );
});

test("myWorkViewState: error with prior data is a partial failure", () => {
  // Groups are still present, so the page keeps rendering them + a banner
  // rather than wiping to the whole-page error.
  const data = queue({ review: 2 });
  const error = new Error("poll failed");
  expect(myWorkViewState({ data, error, loading: false })).toBe(
    "partial-error",
  );
  // A partial failure stands even while an explicit retry is in flight.
  expect(myWorkViewState({ data, error, loading: true })).toBe("partial-error");
});

test("myWorkViewState: data without error is ready or empty by totals", () => {
  const error = undefined;
  expect(
    myWorkViewState({ data: queue({ review: 1 }), error, loading: false }),
  ).toBe("ready");
  expect(myWorkViewState({ data: queue({}), error, loading: false })).toBe(
    "empty",
  );
});

test("myWorkViewState: first load with no data shows loading", () => {
  expect(
    myWorkViewState({ data: undefined, error: undefined, loading: true }),
  ).toBe("loading");
});
