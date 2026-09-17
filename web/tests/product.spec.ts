import { test, expect } from "@playwright/test";

test("unknown submissions retain the original key, body and version after reload", async ({
  page,
}) => {
  const writes: { key: string; body: string | null; version: string }[] = [];
  await page.route("**/api/v1/tasks/task_one/changes", async (route) => {
    const r = route.request();
    writes.push({
      key: r.headers()["idempotency-key"],
      body: r.postData(),
      version: r.headers()["if-match"],
    });
    if (writes.length === 1) return route.abort("timedout");
    return route.fulfill({ json: { id: "task_one", version: 2 } });
  });
  await page.goto("/");
  await page.evaluate(async () => {
    const { API } = await import("/src/api.ts");
    const api = new API("synthetic", () => {});
    api.actor = "user_one";
    try {
      await api.call("/tasks/task_one/changes", { title: "Original" }, 1);
    } catch {}
  });
  await page.reload();
  const result = await page.evaluate(async () => {
    const { API, PendingSubmission } = await import("/src/api.ts");
    const api = new API("synthetic-renewed", () => {});
    api.actor = "user_one";
    try {
      await api.call("/tasks/task_one/changes", { title: "Changed" }, 2);
    } catch (error) {
      if (error instanceof PendingSubmission) {
        await error.retry();
        return await error.retry();
      }
    }
  });
  expect(result).toEqual({ id: "task_one", version: 2 });
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
});

test("version conflicts fetch current content without overwriting it", async ({
  page,
}) => {
  let writes = 0;
  await page.route("**/api/v1/tasks/task_one**", async (route) => {
    if (route.request().method() === "POST") {
      writes++;
      return route.fulfill({
        status: 412,
        json: {
          code: "VERSION_CONFLICT",
          detail: "Conflict",
          trace_id: "trace_one",
        },
      });
    }
    return route.fulfill({
      json: { id: "task_one", title: "Other editor", version: 3 },
    });
  });
  await page.goto("/");
  const conflict = await page.evaluate(async () => {
    const { API, VersionConflict } = await import("/src/api.ts");
    const api = new API("synthetic", () => {});
    try {
      await api.call("/tasks/task_one/changes", { title: "My edit" }, 1);
    } catch (error) {
      if (error instanceof VersionConflict)
        return { submitted: error.submitted, current: error.current };
    }
  });
  expect(conflict).toEqual({
    submitted: { title: "My edit" },
    current: { id: "task_one", title: "Other editor", version: 3 },
  });
  expect(writes).toBe(1);
});

test("task deep links and server pagination survive navigation", async ({
  page,
}) => {
  const requests: string[] = [];
  const task = {
    id: "task_deep",
    title: "Deep linked task",
    objective: "Inspect directly",
    status: "DRAFT",
    owner_user_id: "user_one",
    version: 1,
    acceptance_criteria: ["Done"],
    context_version_ids: [],
  };
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    const path = url.pathname.replace("/api/v1", "");
    let json: unknown = { items: [] };
    if (path === "/auth/config") json = { mode: "development" };
    if (path === "/me") json = { id: "user_one", display_name: "User" };
    if (path === "/projects")
      json = { items: [{ id: "project_one", name: "Project" }] };
    if (path.endsWith("/members"))
      json = {
        items: [
          {
            id: "user_one",
            display_name: "User",
            roles: ["ADMIN"],
            active: true,
          },
        ],
      };
    if (path === "/tasks/task_deep") json = task;
    if (path.endsWith("/tasks"))
      json = {
        items: [task],
        next_cursor: url.searchParams.has("cursor") ? null : "opaque-next",
      };
    return route.fulfill({ json });
  });
  await page.goto("/?project=project_one&page=tasks&task=task_deep");
  await page.getByLabel("个人开发凭证").fill("synthetic");
  await page.getByRole("button", { name: "登录工作空间", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("Deep linked task");
  await page.keyboard.press("Escape");
  await expect(page).not.toHaveURL(/task=task_deep/);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page).toHaveURL(/cursor=opaque-next/);
  await expect
    .poll(() =>
      requests.some(
        (r) => r.includes("limit=25") && r.includes("cursor=opaque-next"),
      ),
    )
    .toBeTruthy();
  await page.goBack();
  await expect(page).not.toHaveURL(/cursor=/);
  expect(
    requests.filter((r) => /\/artifacts|\/approvals|\/tools/.test(r)),
  ).toEqual([]);
});
