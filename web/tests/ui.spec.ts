import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { Doc } from "../src/api";
import { API, ApiError, UnknownResultError } from "../src/api";
import { createTranslator, LocalizedError } from "../src/i18n";
import { zhCN } from "../src/locales/zh-CN";
import { enUS } from "../src/locales/en-US";
import { ruRU } from "../src/locales/ru-RU";

// Synthetic data only: these tests never contact an ACCP deployment.
async function consoleFixture(
  page: Page,
  roles = ["ADMIN", "MEMBER", "REVIEWER"],
) {
  const posts: {
    path: string;
    body: Record<string, any>;
    key: string | undefined;
  }[] = [];
  const gets: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const member = {
    id: "user_demo",
    display_name: "演示用户",
    roles,
    membership_active: true,
    account_active: true,
    active: true,
    is_org_admin: roles.includes("ADMIN"),
    version: 1,
  };
  const otherMember = {
    id: "user_bob",
    display_name: "Bob",
    organization_id: "org_demo",
    project_id: "project_demo",
    roles: ["MEMBER"],
    membership_active: true,
    account_active: true,
    active: true,
    is_org_admin: false,
    version: 1,
  };
  const task: Doc = {
    id: "task_demo",
    title: "验证协作界面",
    objective: "检查组件迁移后的交互",
    owner_user_id: member.id,
    status: "IN_REVIEW",
    version: 1,
    context_version_ids: ["version_api"],
    acceptance_criteria: ["核对测试证据"],
    updated_at: "2026-01-01T00:00:00Z",
  };
  const contexts = [
    {
      id: "context_api",
      name: "订单 API",
      type: "API",
      source: { kind: "ACCP" },
      version: 1,
    },
    {
      id: "context_rules",
      name: "项目规范",
      type: "PROJECT_STANDARD",
      source: { kind: "ACCP" },
      version: 1,
    },
  ];
  const artifact = {
    id: "artifact_demo",
    kind: "TEST_REPORT",
    verification_status: "VERIFIED",
    acceptance_status: "PENDING",
    content_digest: "demo-digest",
    version: 1,
    provenance: { task_id: task.id, owner_user_id: member.id },
    uri: "urn:demo",
  };
  const tasks = [task];
  let failTask = false;
  let failNetworkTask = false;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    const send = (body: unknown, status = 200) =>
      route.fulfill({ status, json: body });
    if (request.method() === "POST") {
      const body = request.postDataJSON();
      posts.push({ path, body, key: request.headers()["idempotency-key"] });
      if (path === "/projects/project_demo/tasks") {
        if (failNetworkTask) {
          failNetworkTask = false;
          return route.abort("failed");
        }
        if (failTask) {
          failTask = false;
          return send(
            {
              code: "CONFLICT",
              detail: "请检查任务内容后重试",
              trace_id: "demo-trace",
            },
            409,
          );
        }
        tasks.push({ ...task, ...body, id: "task_created", status: "DRAFT" });
      }
      if (path === "/tasks/task_demo/reviews") task.status = "DONE";
      if (path === "/agent-sessions")
        return send({
          session: { id: "session_demo" },
          access_token: "synthetic-ui-test-value",
          expires_at: "2026-01-01T01:00:00Z",
        });
      return send({
        id: "created_demo",
        version: 1,
        content_uri: "urn:demo",
        content_digest: "demo",
        media_type: "text/markdown",
      });
    }
    gets.push(
      new URL(request.url()).pathname.replace("/api/v1", "") +
        new URL(request.url()).search,
    );
    if (path === "/auth/config") return send({ mode: "development" });
    if (path === "/me") return send(member);
    if (path === "/projects")
      return send({
        items: [
          {
            id: "project_demo",
            name: "演示项目",
            status: "ACTIVE",
            version: 1,
            roles,
          },
          {
            id: "project_other",
            name: "第二项目",
            status: "ACTIVE",
            version: 1,
            roles,
          },
          {
            id: "project_archived",
            name: "归档样例",
            status: "ARCHIVED",
            version: 2,
            roles,
          },
        ],
      });
    if (/\/projects\/[^/]+\/members$/.test(path))
      return send({ items: [member, otherMember] });
    if (path === "/organization/members")
      return send({
        items: [
          {
            id: member.id,
            organization_id: "org_demo",
            display_name: member.display_name,
            active: true,
            account_active: true,
            is_org_admin: member.is_org_admin,
            kind: "HUMAN",
          },
          {
            id: otherMember.id,
            organization_id: "org_demo",
            display_name: otherMember.display_name,
            active: true,
            account_active: true,
            is_org_admin: false,
            kind: "HUMAN",
          },
          {
            id: "user_new",
            organization_id: "org_demo",
            display_name: "新成员",
            active: true,
            account_active: true,
            is_org_admin: false,
            kind: "HUMAN",
          },
        ],
      });
    if (/\/projects\/[^/]+\/workbench$/.test(path))
      return send({
        mine: tasks.filter((item) => item.owner_user_id === member.id).length,
        review: tasks.filter((item) => item.status === "IN_REVIEW").length,
        attention: tasks.filter((item) =>
          ["BLOCKED", "FAILED"].includes(item.status),
        ).length,
        checked_at: new Date().toISOString(),
        approvals: roles.includes("REVIEWER") ? 1 : 0,
        action_tasks: tasks.filter((item) => item.status === "IN_REVIEW"),
        recent_tasks: tasks,
      });
    if (/\/projects\/[^/]+\/tasks$/.test(path)) {
      const query = new URL(request.url()).searchParams;
      let matched = tasks.filter(
        (item) =>
          (!query.get("owner") || item.owner_user_id === query.get("owner")) &&
          (query.get("archived") !== "true" || item.archived === true) &&
          (!query.get("status") || item.status === query.get("status")) &&
          (!query.get("q") ||
            `${item.title} ${item.objective}`
              .toLowerCase()
              .includes(query.get("q")!.toLowerCase())),
      );
      const sort = query.get("sort");
      const orderParam = query.get("order");
      // Workspace bootstrap (api.all) may omit sort; US-11b list always sends both.
      if (sort && orderParam) {
        const order = orderParam === "asc" ? 1 : -1;
        matched = [...matched].sort((a, b) => {
          if (sort === "title") {
            return a.title.localeCompare(b.title) * order;
          }
          const left = String(a.updated_at || a.id);
          const right = String(b.updated_at || b.id);
          return left.localeCompare(right) * order;
        });
      }
      const limit = Math.max(1, Number(query.get("limit") || "25"));
      const cursor = query.get("cursor") || "";
      const start = cursor
        ? matched.findIndex((item) => item.id === cursor) + 1
        : 0;
      const sliceStart = start < 0 ? 0 : start;
      const pageItems = matched.slice(sliceStart, sliceStart + limit);
      const next =
        sliceStart + limit < matched.length ? pageItems.at(-1)?.id : undefined;
      return send({
        items: pageItems,
        ...(next ? { next_cursor: next } : {}),
      });
    }
    if (/\/projects\/[^/]+\/contexts$/.test(path))
      return send({ items: contexts });
    if (path === "/contexts/context_api/versions")
      return send({
        items: [
          { id: "version_api", status: "PUBLISHED", source_revision: "1.0" },
        ],
      });
    if (path === "/contexts/context_rules/versions")
      return send({
        items: [
          { id: "version_rules", status: "PUBLISHED", source_revision: "2.0" },
        ],
      });
    if (/\/repositories$/.test(path))
      return send({
        items: [{ id: "repo_demo", url: "https://example.com/demo.git" }],
      });
    if (path === "/tasks/task_demo") return send(task);
    if (path === "/tasks/task_demo/runs")
      return send({
        items: [
          {
            id: "run_demo",
            attempt: 1,
            status: "SUCCEEDED",
            agent_id: "agent_demo",
          },
        ],
      });
    if (/\/artifacts$/.test(path)) return send({ items: [artifact] });
    if (path === "/artifacts/artifact_demo") return send(artifact);
    if (/\/agents$/.test(path))
      return send({
        items: [
          {
            id: "agent_demo",
            client_name: "演示代理",
            client_version: "1.0",
            adapter_id: "demo",
            registered_by_user_id: member.id,
          },
        ],
      });
    if (/\/tools$/.test(path))
      return send({
        items: [
          {
            id: "tool_demo",
            name: "演示工具",
            backend_id: "backend_demo",
            resource_version: "1",
            enabled: true,
            risk: "READ_ONLY",
          },
        ],
      });
    if (/\/tool-backends$/.test(path))
      return send({ items: [{ id: "backend_demo", risk: "READ_ONLY" }] });
    return send({ items: [] });
  });
  return {
    posts,
    gets,
    errors,
    failNextTask: () => {
      failTask = true;
    },
    failNextTaskNetwork: () => {
      failNetworkTask = true;
    },
  };
}
async function login(page: Page) {
  await page.goto("/dev-login");
  await page.getByLabel("个人开发凭证").fill("synthetic-ui-test-value");
  await page.getByRole("button", { name: "登录工作空间", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "工作概览", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "任务协作", exact: true }),
  ).toBeVisible();
}
async function navigate(page: Page, name: string) {
  const adminNames = new Set([
    "项目设置",
    "工具与集成",
    "系统运行",
    "审计记录",
    "Project settings",
    "Tools & integrations",
    "System status",
    "Audit log",
    "Настройки проекта",
    "Инструменты и интеграции",
    "Состояние системы",
    "Журнал аудита",
  ]);
  const management = page.getByTestId("area-management");
  if (adminNames.has(name)) {
    if ((await management.getAttribute("aria-current")) !== "page")
      await management.click();
  } else if (
    (await management.count()) &&
    (await management.getAttribute("aria-current")) === "page"
  ) {
    await page.getByTestId("area-workspace").click();
  }
  const destination = page
    .getByRole("navigation")
    .getByRole("button", { name, exact: true });
  await destination.click();
}
async function createTask(page: Page) {
  await navigate(page, "任务协作");
  await page.getByRole("button", { name: "＋ 创建任务" }).click();
  await page.getByLabel("任务标题").fill("多依据任务");
  await page.getByLabel("目标与范围").fill("验证多选和默认负责人");
  await page.getByLabel("验收条件", { exact: false }).fill("检查返回数据");
}

test("API unknown results require an explicit write opt-in", async () => {
  const originalFetch = globalThis.fetch;
  const api = new API("synthetic-ui-test-value", () => {});
  try {
    for (const uncertainResult of [undefined, false, true]) {
      const options = { uncertainResult };
      for (const cause of [
        new TypeError("Network failure"),
        new DOMException("Timed out", "TimeoutError"),
      ]) {
        globalThis.fetch = async () => {
          throw cause;
        };
        const write = api.call("/tasks", { title: "test" }, undefined, options);
        if (uncertainResult)
          await expect(write).rejects.toMatchObject({
            name: "UnknownResultError",
            cause,
          });
        else await expect(write).rejects.toBe(cause);
        await expect(
          api.call("/tasks", undefined, undefined, options),
        ).rejects.toBe(cause);
      }
      for (const status of [409, 503]) {
        globalThis.fetch = async () =>
          new Response(
            JSON.stringify({
              code: "WRITE_FAILED",
              detail: "Write rejected",
              trace_id: "write-trace",
            }),
            { status },
          );
        await expect(
          api.call("/tasks", {}, undefined, options),
        ).rejects.toBeInstanceOf(ApiError);
      }
      for (const status of [201, 400, 503]) {
        globalThis.fetch = async () => new Response("truncated", { status });
        await expect(
          api.call("/tasks", {}, undefined, options),
        ).rejects.toBeInstanceOf(
          uncertainResult && status !== 400 ? UnknownResultError : SyntaxError,
        );
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  const error = new UnknownResultError(new TypeError("Network failure"));
  expect(error).toBeInstanceOf(LocalizedError);
  for (const [locale, message] of [
    ["zh-CN", "请求结果未知，请勿重复提交。"],
    ["en-US", "The request result is unknown. Please do not submit again."],
    ["ru-RU", "Результат запроса неизвестен. Не отправляйте его повторно."],
  ] as const) {
    expect(createTranslator(locale).translate(error.key)).toBe(message);
  }
});

test("required fields, multiple selection, retry and submit preserve API payloads", async ({
  page,
}) => {
  const fixture = await consoleFixture(page);
  await login(page);
  await createTask(page);
  const submit = page.getByRole("button", { name: "创建草稿", exact: true });
  await submit.click();
  expect(fixture.posts).toHaveLength(0);
  const basis = page.getByRole("button", { name: /执行依据/ });
  await basis.click();
  await page.getByRole("option", { name: /订单 API/ }).click();
  await page.getByRole("option", { name: /项目规范/ }).click();
  await page.keyboard.press("Escape");
  fixture.failNextTask();
  await submit.click();
  await expect(page.getByRole("alert")).toContainText("请检查任务内容后重试");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const payload = fixture.posts.at(-1)!.body;
  expect(payload).toMatchObject({
    title: "多依据任务",
    owner_user_id: "user_demo",
    repository_id: "repo_demo",
    acceptance_criteria: ["检查返回数据"],
  });
  expect(payload.context_version_ids).toEqual(["version_api", "version_rules"]);
  expect(fixture.errors).toEqual([]);
});

test("retry after an unknown network result reuses the write key", async ({
  page,
}) => {
  const fixture = await consoleFixture(page);
  await login(page);
  await createTask(page);
  await page.getByRole("button", { name: /执行依据/ }).click();
  await page.getByRole("option", { name: /订单 API/ }).click();
  await page.keyboard.press("Escape");
  fixture.failNextTaskNetwork();
  await page.getByRole("button", { name: "创建草稿", exact: true }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "请求超时，暂不确定是否已保存" }),
  ).toContainText("请求超时，暂不确定是否已保存");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const writes = fixture.posts.filter(
    (post) => post.path === "/projects/project_demo/tasks",
  );
  expect(writes).toHaveLength(2);
  expect(writes[0].key).toBeTruthy();
  expect(writes[1].key).toBe(writes[0].key);
  await createTask(page);
  await page.getByLabel("任务标题").fill("另一项任务");
  await page.getByRole("button", { name: /执行依据/ }).click();
  await page.getByRole("option", { name: /订单 API/ }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "创建草稿", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(fixture.posts.at(-1)!.key).not.toBe(writes[0].key);
});

test.describe("safe task retries", () => {
  async function ready(page: Page) {
    const fixture = await consoleFixture(page);
    await login(page);
    await createTask(page);
    await page.getByRole("button", { name: /执行依据/ }).click();
    await page.getByRole("option", { name: /订单 API/ }).click();
    await page.keyboard.press("Escape");
    return fixture;
  }

  for (const header of ["true", undefined, "false"]) {
    test(`timeout retry trusts only the replay header (${header ?? "absent"})`, async ({
      page,
    }) => {
      test.setTimeout(60000);
      const fixture = await ready(page);
      const writes: { key: string | undefined; body: unknown }[] = [];
      let completeRetry: (() => Promise<void>) | undefined;
      await page.route(
        "**/api/v1/projects/project_demo/tasks",
        async (route) => {
          if (route.request().method() !== "POST") return route.fallback();
          writes.push({
            key: route.request().headers()["idempotency-key"],
            body: route.request().postDataJSON(),
          });
          // The server may have saved the first request, but its response never arrives.
          if (writes.length === 1) return;
          completeRetry = () =>
            route.fulfill({
              status: 201,
              headers:
                header === undefined ? {} : { "Idempotency-Replayed": header },
              json: { id: "task_created", idempotencyReplayed: true },
            });
        },
      );
      const submit = page.getByRole("dialog").locator('button[type="submit"]');
      await submit.click();
      await expect(submit).toBeDisabled();
      await expect(submit).toContainText("处理中…");
      const hint = page
        .getByRole("status")
        .filter({ hasText: "仍在处理，请勿关闭页面" });
      await expect(hint).toBeVisible({ timeout: 8000 });
      const warning = page
        .getByRole("status")
        .filter({ hasText: "请求超时，暂不确定是否已保存" });
      await expect(warning).toBeVisible({ timeout: 20000 });
      await expect(warning).toHaveAttribute("aria-live", "polite");
      await expect(warning).toContainText("重试是安全的，不会重复创建。");
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.getByLabel("任务标题")).toHaveValue("多依据任务");
      await expect(page.getByLabel("目标与范围")).toHaveValue(
        "验证多选和默认负责人",
      );
      await expect(hint).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "在任务列表中查看", exact: true }),
      ).toBeVisible();
      const retry = warning.getByRole("button").first();
      expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(40);
      await retry.focus();
      await page.keyboard.press("Enter");
      await expect(retry).toBeFocused();
      await expect(retry).toHaveAttribute("data-pending", "true");
      await expect(retry).toHaveAttribute("aria-disabled", "true");
      await expect(retry).toContainText("处理中…");
      await expect.poll(() => writes.length).toBe(2);
      expect(writes[0].key).toBeTruthy();
      expect(writes[1]).toEqual(writes[0]);
      await completeRetry!();
      if (header === "true") {
        const success = page
          .getByRole("status")
          .filter({ hasText: "已成功，无需重复提交" });
        await expect(success).toContainText("该操作此前已成功完成。");
        await expect(success).toHaveAttribute("aria-live", "polite");
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.clock.install();
        await page.clock.fastForward(10000);
        await expect(success).toBeVisible();
        await page
          .getByRole("button", { name: "在任务列表中查看", exact: true })
          .click();
      }
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(
        page.getByText("已成功，无需重复提交", { exact: true }),
      ).toHaveCount(0);
      expect(fixture.errors).toEqual([]);
    });
  }

  test("three unknown results retain retry and the task-list recovery action", async ({
    page,
  }) => {
    const fixture = await ready(page);
    const keys: (string | undefined)[] = [];
    await page.route("**/api/v1/projects/project_demo/tasks", (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      keys.push(route.request().headers()["idempotency-key"]);
      // A proxy 5xx need not contain an API error JSON document.
      return route.fulfill({
        status: 503,
        contentType: "text/html",
        body: "Unavailable",
      });
    });
    await page.getByRole("button", { name: "创建草稿", exact: true }).click();
    const retry = page.getByRole("button", { name: "重试", exact: true });
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(retry).toHaveText("重试");
    await retry.click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "服务暂时不可用，请稍后再试" }),
    ).toContainText("服务暂时不可用，请稍后再试");
    await expect(retry).toBeVisible();
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    await expect(page.getByLabel("任务标题")).toHaveValue("多依据任务");
    const reads = fixture.gets.filter((path) =>
      path.includes("/tasks?"),
    ).length;
    await page
      .getByRole("button", { name: "在任务列表中查看", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect
      .poll(
        () => fixture.gets.filter((path) => path.includes("/tasks?")).length,
      )
      .toBeGreaterThan(reads);
    await expect(
      page.getByRole("heading", { name: "任务协作", exact: true }),
    ).toBeVisible();
  });

  for (const status of [409, 503]) {
    test(`${status} JSON errors retain the existing Message error`, async ({
      page,
    }) => {
      await ready(page);
      await page.route("**/api/v1/projects/project_demo/tasks", (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        return route.fulfill({
          status,
          json: {
            code: "IDEMPOTENCY_CONFLICT",
            detail: "请检查任务内容后重试",
            trace_id: "conflict-trace",
          },
        });
      });
      await page.getByRole("button", { name: "创建草稿", exact: true }).click();
      const error = page.getByRole("alert");
      await expect(error).toContainText("请检查任务内容后重试");
      await expect(error).toContainText(
        "IDEMPOTENCY_CONFLICT · conflict-trace",
      );
      await expect(
        page.getByRole("button", { name: "重试", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "创建草稿", exact: true }),
      ).toBeEnabled();
      await expect(page.getByLabel("任务标题")).toHaveValue("多依据任务");
    });
  }

  test("a refresh failure after a confirmed write keeps the modal open without resubmitting", async ({
    page,
  }) => {
    const fixture = await ready(page);
    await page.route(
      "**/api/v1/projects/project_demo/tasks?limit=50",
      (route) =>
        route.fulfill({
          status: 503,
          json: {
            code: "UNAVAILABLE",
            detail: "Refresh failed",
            trace_id: "refresh-trace",
          },
        }),
    );
    await page.getByRole("button", { name: "创建草稿", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("alert")).toContainText("Refresh failed");
    await expect(dialog.getByRole("alert")).toContainText(
      "UNAVAILABLE · refresh-trace",
    );
    await expect(
      dialog.getByRole("button", { name: "创建草稿", exact: true }),
    ).toBeDisabled();
    await dialog
      .locator("form")
      .evaluate((form: HTMLFormElement) => form.requestSubmit());
    expect(fixture.posts).toHaveLength(1);
    expect(fixture.errors).toEqual([]);
  });
});

test("dialogs trap focus, Escape dismisses and returns focus to the trigger", async ({
  page,
}) => {
  const fixture = await consoleFixture(page);
  await login(page);
  await navigate(page, "项目资料");
  const trigger = page.getByRole("button", { name: "＋ 新建上下文" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "新建共享上下文" });
  await expect(dialog).toBeVisible();
  await expect(page.locator(":focus")).toBeVisible();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(
      await dialog.evaluate((el) => el.contains(document.activeElement)),
    ).toBe(true);
  }
  const type = page.getByRole("button", { name: /类型/ });
  await type.focus();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("option", { name: "API 契约", exact: true }).click();
  await expect(type).toContainText("API 契约");
  await expect(page.locator(".select__popover")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(fixture.errors).toEqual([]);
});

test("keyboard tabs and Owner checkboxes submit the selected evidence", async ({
  page,
}) => {
  const fixture = await consoleFixture(page);
  await login(page);
  await navigate(page, "任务协作");
  await page.getByRole("link", { name: /验证协作界面/ }).click();
  const overview = page.getByRole("tab", { name: "任务与执行" });
  await overview.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "成果与验收" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("checkbox", { name: "核对测试证据" }).press("Space");
  await expect(page.getByRole("checkbox", { name: /测试报告/ })).toBeChecked();
  await page.getByLabel("审核意见").fill("已核对证据");
  await page.getByRole("button", { name: "提交验收决定" }).click();
  await expect(
    page
      .getByRole("region", { name: "任务详情" })
      .getByText("已完成", { exact: true }),
  ).toBeVisible();
  expect(fixture.posts.at(-1)!.body).toMatchObject({
    decision: "ACCEPT",
    acceptance_checks: [true],
    artifacts: [
      {
        artifact_id: "artifact_demo",
        version: 1,
        content_digest: "demo-digest",
      },
    ],
  });
  expect(fixture.errors).toEqual([]);
});

test("task links reopen after authentication and browser navigation", async ({
  page,
}) => {
  await consoleFixture(page);
  await login(page);
  await navigate(page, "任务协作");
  await page.getByRole("link", { name: /验证协作界面/ }).click();
  await expect(page).toHaveURL(/\/projects\/project_demo\/tasks\/task_demo$/);
  await expect(page.getByRole("region", { name: "任务详情" })).toBeVisible();
  await page.reload();
  await page.getByRole("link", { name: "前往开发登录 →" }).click();
  await page.getByLabel("个人开发凭证").fill("synthetic-ui-test-value");
  await page.getByRole("button", { name: "登录工作空间", exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/project_demo\/tasks\/task_demo$/);
  await expect(
    page
      .getByRole("region", { name: "任务详情" })
      .getByRole("heading", { name: "验证协作界面" }),
  ).toBeVisible();
  await page
    .getByRole("region", { name: "任务详情" })
    .getByRole("button", { name: /任务协作/ })
    .click();
  await expect(page.getByRole("link", { name: /验证协作界面/ })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("region", { name: "任务详情" })).toBeVisible();
});

test("returnTo keeps search and hash; copy link and invalid page", async ({
  page,
  context,
}) => {
  await consoleFixture(page);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(
    "/projects/project_demo/tasks?status=IN_PROGRESS&sort=updated_at&order=desc#row-demo",
  );
  await page.getByRole("link", { name: "前往开发登录 →" }).click();
  await expect(page).toHaveURL(/returnTo=/);
  const returnTo = new URL(page.url()).searchParams.get("returnTo");
  expect(returnTo).toContain("/projects/project_demo/tasks?");
  expect(returnTo).toContain("status=IN_PROGRESS");
  expect(returnTo).toContain("#row-demo");
  await page.getByLabel("个人开发凭证").fill("synthetic-ui-test-value");
  await page.getByRole("button", { name: "登录工作空间", exact: true }).click();
  await expect(page).toHaveURL(/status=IN_PROGRESS/);
  await expect(page).toHaveURL(/sort=updated_at/);
  await expect(page).toHaveURL(/order=desc/);
  expect(page.url()).toContain("#row-demo");
  await expect(
    page.getByRole("heading", { name: "任务协作", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "全部任务", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "没有符合条件的任务", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "复制链接", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "复制链接", exact: true }),
  ).toContainText("已复制");
  await expect(
    page.getByText("链接已复制到剪贴板", { exact: true }),
  ).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("/projects/project_demo/tasks?");
  expect(copied).toContain("status=IN_PROGRESS");
  expect(copied).toContain("#row-demo");

  await page.evaluate(() => {
    history.pushState(null, "", "/projects/project_demo/not-a-real-page");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(
    page.getByRole("heading", { name: "链接失效", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "返回项目概览", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/projects\/project_demo\/not-a-real-page$/);
});

test("administrators see readable diagnostics and replay requires a reason", async ({
  page,
}) => {
  const fixture = await consoleFixture(page);
  await page.route("**/api/v1/projects/project_demo/diagnostics", (route) =>
    route.fulfill({
      json: {
        maintenance: true,
        outbox_pending: 1,
        event_failures: 1,
        unknown_operations: 0,
        pending_approvals: 0,
        expired_leases: 0,
        recovery_pending: 0,
        checked_at: "2026-01-01T00:00:00Z",
      },
    }),
  );
  await page.route(
    "**/api/v1/projects/project_demo/event-failures?*",
    (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: "event_demo",
              event_type: "context.published",
              publish_attempts: 2,
              publish_error: "DELIVERY_FAILED",
              failed_at: "2026-01-01T00:00:00Z",
            },
          ],
        },
      }),
  );
  await login(page);
  await navigate(page, "系统运行");
  await expect(
    page.getByText("系统处于维护模式，新的写入暂不可用。"),
  ).toBeVisible();
  const event = page
    .locator("article")
    .filter({ hasText: "context.published" });
  await expect(
    event.getByText("DELIVERY_FAILED", { exact: true }),
  ).toBeVisible();
  await event.getByText("授权重放").click();
  await event.getByLabel("重放原因").fill("已核对下游未处理");
  await event.getByRole("button", { name: "确认重放" }).click();
  await expect
    .poll(() => fixture.posts.at(-1)?.path)
    .toBe("/projects/project_demo/events/event_demo/replay");
});

test("viewer navigation excludes actions and administrator pages", async ({
  page,
}) => {
  await consoleFixture(page, ["VIEWER"]);
  await login(page);
  const nav = page.getByRole("navigation");
  await expect(nav.getByRole("button", { name: "项目设置" })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "系统运行" })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "待审批" })).toHaveCount(0);
  await navigate(page, "任务协作");
  await expect(page.getByRole("button", { name: "＋ 创建任务" })).toHaveCount(
    0,
  );
  await page.evaluate(() => {
    history.pushState(null, "", "/projects/project_demo/operations");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByText("此页面需要更高权限")).toBeVisible();
});

test("delegation defaults and member permissions preserve checked values", async ({
  page,
}) => {
  const fixture = await consoleFixture(page);
  await login(page);
  await navigate(page, "执行客户端");
  await page.getByRole("button", { name: "授权执行 →" }).click();
  await expect(
    page.getByRole("checkbox", { name: "通过网关请求工具操作" }),
  ).not.toBeChecked();
  await page.getByRole("checkbox", { name: "订阅项目事件" }).press("Space");
  await page.getByRole("button", { name: "创建短期授权" }).click();
  await expect(
    page.getByRole("dialog", { name: "执行授权已创建" }),
  ).toBeVisible();
  expect(fixture.posts.at(-1)!.body.scopes).toEqual([
    "tasks:read",
    "context:read",
    "runs:claim",
    "runs:write",
    "artifacts:write",
  ]);
  await expect(page.getByLabel("访问凭证")).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await navigate(page, "项目成员");
  await page.getByRole("button", { name: "管理角色" }).first().click();
  await page
    .getByRole("checkbox", { name: "审核人", exact: true })
    .press("Space");
  await page.getByLabel("变更原因").fill("调整演示权限");
  await page.getByRole("button", { name: "保存成员权限" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(fixture.posts.at(-1)!.body).toMatchObject({
    roles: ["ADMIN", "MEMBER"],
    active: true,
  });
  expect(fixture.errors).toEqual([]);
});

test("project members add and project-level deactivate stay project-scoped", async ({
  page,
}) => {
  const fixture = await consoleFixture(page);
  await login(page);
  await navigate(page, "项目成员");
  const membersGrid = page.getByRole("grid", { name: "项目成员" });
  await expect(membersGrid).toContainText("Bob");
  await expect(membersGrid).toContainText("启用");
  await expect(page.getByRole("button", { name: "停用账号" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "从本项目停用 Bob" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "从本项目停用 演示用户" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "＋ 添加成员" }).click();
  await expect(page.getByRole("dialog", { name: "添加成员" })).toBeVisible();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "从本项目停用 Bob" }).click();
  const dialog = page.getByRole("alertdialog", {
    name: "从本项目停用 Bob？",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("不影响其在其他项目的成员身份");
  await expect(dialog).not.toContainText("无法登录");
  await dialog.getByLabel("操作原因").fill("离开本项目");
  await dialog
    .getByRole("button", { name: "从本项目停用", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("已从本项目停用 Bob")).toBeVisible();
  expect(fixture.posts.at(-1)).toMatchObject({
    path: "/projects/project_demo/members/user_bob/changes",
    body: { active: false, reason: "离开本项目" },
  });
  expect(fixture.errors).toEqual([]);
});

test("org accounts tab deactivates account for organization admins", async ({
  page,
}) => {
  const fixture = await consoleFixture(page);
  await login(page);
  await navigate(page, "项目设置");
  await expect(page.getByRole("button", { name: "组织账号" })).toBeVisible();
  await page.getByRole("button", { name: "组织账号" }).click();
  await expect(page).toHaveURL(/tab=org-accounts/);
  const accounts = page.getByRole("grid", { name: "组织账号" });
  await expect(accounts).toContainText("Bob");
  await expect(
    page.getByRole("button", { name: "停用账号 演示用户" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "停用账号 Bob" }).click();
  const dialog = page.getByRole("alertdialog", { name: "停用账号 Bob？" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("无法登录");
  await expect(dialog).toContainText("这是账号级停用");
  await dialog.getByLabel("操作原因").fill("离职");
  await dialog.getByRole("button", { name: "停用账号", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("已停用账号 Bob")).toBeVisible();
  expect(fixture.posts.at(-1)).toMatchObject({
    path: "/organization/members/user_bob/changes",
    body: { active: false, reason: "离职" },
  });
  expect(fixture.errors).toEqual([]);
});

test("project create archive-blocked restore and register repository", async ({
  page,
}) => {
  test.setTimeout(60000);
  const fixture = await consoleFixture(page);
  let archiveAttempts = 0;
  await page.route("**/api/v1/projects/**/commands", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON();
    postsPush(fixture, route);
    if (body.command === "ARCHIVE") {
      archiveAttempts += 1;
      if (archiveAttempts === 1) {
        return route.fulfill({
          status: 409,
          json: {
            type: "about:blank",
            title: "Conflict",
            status: 409,
            code: "ARCHIVE_BLOCKED",
            detail:
              "Finish or cancel tasks and reconcile operations first (up to 20): task:task_demo, run:run_demo",
            trace_id: "archive-blocked",
          },
        });
      }
      return route.fulfill({
        status: 200,
        json: {
          id: "project_demo",
          organization_id: "org_demo",
          name: "演示项目",
          status: "ARCHIVED",
          version: 2,
        },
      });
    }
    if (body.command === "RESTORE") {
      return route.fulfill({
        status: 200,
        json: {
          id: "project_archived",
          organization_id: "org_demo",
          name: "归档样例",
          status: "ACTIVE",
          version: 3,
        },
      });
    }
    return route.fulfill({
      status: 200,
      json: { id: "project_demo", status: "ACTIVE", version: 1 },
    });
  });
  const projectList = [
    {
      id: "project_demo",
      name: "演示项目",
      status: "ACTIVE",
      version: 1,
      roles: ["ADMIN", "MEMBER", "REVIEWER"],
    },
    {
      id: "project_other",
      name: "第二项目",
      status: "ACTIVE",
      version: 1,
      roles: ["ADMIN", "MEMBER", "REVIEWER"],
    },
    {
      id: "project_archived",
      name: "归档样例",
      status: "ARCHIVED",
      version: 2,
      roles: ["ADMIN", "MEMBER", "REVIEWER"],
    },
  ];
  await page.route("**/api/v1/projects", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      return route.fulfill({ status: 200, json: { items: projectList } });
    }
    if (method !== "POST") return route.fallback();
    const body = route.request().postDataJSON();
    postsPush(fixture, route);
    const created = {
      id: "project_created",
      organization_id: "org_demo",
      name: body.name,
      status: "ACTIVE",
      version: 1,
      roles: ["ADMIN"],
    };
    projectList.push(created);
    return route.fulfill({ status: 201, json: created });
  });
  await page.route("**/api/v1/projects/**/repositories", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ status: 200, json: { items: [] } });
    }
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON();
    postsPush(fixture, route);
    return route.fulfill({
      status: 201,
      json: {
        id: "repo_new",
        project_id: "project_demo",
        organization_id: "org_demo",
        provider_id: "github",
        url: body.url,
        default_branch: body.default_branch,
      },
    });
  });

  await login(page);
  await navigate(page, "项目设置");
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await expect(page).toHaveURL(/tab=projects/);
  await page.getByRole("button", { name: "＋ 创建项目" }).click();
  const create = page.getByRole("dialog", { name: "创建项目" });
  await create.getByLabel("项目名称").fill("新控制台项目");
  await create.getByLabel("操作原因").fill("开通");
  await create.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(page.getByText("已创建项目 新控制台项目")).toBeVisible();
  expect(
    fixture.posts.some(
      (p) =>
        p.path === "/projects" &&
        p.body.name === "新控制台项目" &&
        p.body.reason === "开通",
    ),
  ).toBe(true);

  await page.getByRole("button", { name: "归档项目 演示项目" }).click();
  const archive = page.getByRole("alertdialog", {
    name: "归档项目 演示项目？",
  });
  await expect(archive).toBeVisible();
  await archive.getByLabel("操作原因").fill("清理");
  await archive.getByRole("button", { name: "归档项目", exact: true }).click();
  await expect(archive.getByText("无法归档")).toBeVisible();
  await expect(archive.getByText(/task_demo/)).toBeVisible();
  await expect(
    archive.getByRole("link", { name: /task_demo/ }),
  ).toHaveAttribute("href", "/projects/project_demo/tasks/task_demo");
  await archive.getByRole("button", { name: "取消" }).click();

  await page.getByLabel("状态").click();
  await page.getByRole("option", { name: "已归档", exact: true }).click();
  await page.getByRole("button", { name: "恢复 归档样例" }).click();
  const restore = page.getByRole("alertdialog", {
    name: "恢复项目 归档样例？",
  });
  await restore.getByLabel("操作原因").fill("继续使用");
  await restore.getByRole("button", { name: "恢复项目", exact: true }).click();
  await expect(page.getByText("已恢复项目 归档样例")).toBeVisible();

  await page.getByRole("button", { name: "仓库", exact: true }).click();
  await expect(page).toHaveURL(/tab=repositories/);
  await page.getByRole("button", { name: "＋ 登记仓库" }).click();
  const repo = page.getByRole("dialog", { name: "登记仓库" });
  await repo.getByLabel("仓库地址").fill("acme/orders");
  await repo.getByLabel("操作原因").fill("交付");
  await repo.getByRole("button", { name: "登记仓库", exact: true }).click();
  await expect(page.getByText(/已登记仓库/)).toBeVisible();
  const register = fixture.posts.find((p) => p.path.endsWith("/repositories"));
  expect(register?.body).toMatchObject({
    url: "https://github.com/acme/orders",
    default_branch: "main",
    reason: "交付",
  });
  expect(fixture.errors).toEqual([]);
});

function postsPush(
  fixture: {
    posts: {
      path: string;
      body: Record<string, any>;
      key: string | undefined;
    }[];
  },
  route: {
    request: () => {
      url: () => string;
      postDataJSON: () => any;
      headers: () => Record<string, string>;
    };
  },
) {
  const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
  fixture.posts.push({
    path,
    body: route.request().postDataJSON(),
    key: route.request().headers()["idempotency-key"],
  });
}

test("task search, help and sanitized diagnostic export are reachable", async ({
  page,
}) => {
  const fixture = await consoleFixture(page);
  await login(page);
  await navigate(page, "任务协作");
  await page.getByRole("textbox", { name: "搜索任务" }).fill("验证");
  await expect
    .poll(() =>
      fixture.gets.some(
        (path) =>
          path.includes("/tasks?") && path.includes("q=%E9%AA%8C%E8%AF%81"),
      ),
    )
    .toBe(true);
  await navigate(page, "使用帮助");
  await expect(
    page.getByRole("heading", { name: "从任务到交付" }),
  ).toBeVisible();
  await navigate(page, "系统运行");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "导出诊断" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(
    /^accp-diagnostics-project_demo-/,
  );
  expect(fixture.errors).toEqual([]);
});

test("task list sends sort/order, normalizes URL, and load-more appends", async ({
  page,
}) => {
  const fixture = await consoleFixture(page);
  const listGets: string[] = [];
  const extra = Array.from({ length: 30 }, (_, i) => ({
    id: `task_extra_${i}`,
    project_id: "project_demo",
    title: `批量任务 ${String(i).padStart(2, "0")}`,
    objective: "分页",
    status: "READY",
    owner_user_id: "user_demo",
    context_version_ids: [],
    acceptance_criteria: [],
    updated_at: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
  }));
  await page.route("**/api/v1/projects/project_demo/tasks**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/\/$/, "");
    if (route.request().method() !== "GET" || !path.endsWith("/tasks")) {
      return route.fallback();
    }
    const url = new URL(route.request().url());
    listGets.push(url.pathname.replace("/api/v1", "") + url.search);
    const query = url.searchParams;
    const all = [
      {
        id: "task_demo",
        title: "验证协作界面",
        objective: "确认筛选、排序与加载更多",
        status: "IN_REVIEW",
        owner_user_id: "user_demo",
        context_version_ids: ["version_api"],
        acceptance_criteria: ["核对测试证据"],
        updated_at: "2026-01-31T00:00:00Z",
      },
      ...extra,
    ];
    let sorted = all;
    if (query.get("sort") && query.get("order")) {
      const order = query.get("order") === "asc" ? 1 : -1;
      sorted = [...all].sort((a, b) => {
        if (query.get("sort") === "title") {
          return a.title.localeCompare(b.title) * order;
        }
        return a.updated_at.localeCompare(b.updated_at) * order;
      });
    }
    const limit = Number(query.get("limit") || "25");
    const cursor = query.get("cursor") || "";
    const start = cursor
      ? sorted.findIndex((item) => item.id === cursor) + 1
      : 0;
    const pageItems = sorted.slice(start, start + limit);
    const next =
      start + limit < sorted.length ? pageItems.at(-1)?.id : undefined;
    return route.fulfill({
      status: 200,
      json: {
        items: pageItems,
        ...(next ? { next_cursor: next } : {}),
      },
    });
  });
  await login(page);
  await navigate(page, "任务协作");
  await expect
    .poll(() =>
      listGets.some(
        (path) =>
          path.includes("/tasks?") &&
          path.includes("sort=updated_at") &&
          path.includes("order=desc"),
      ),
    )
    .toBe(true);
  await expect(page).toHaveURL(/sort=updated_at/);
  await expect(page).toHaveURL(/order=desc/);
  await expect(page).not.toHaveURL(/cursor=/);
  await expect(page.getByRole("button", { name: "上一页" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "下一页" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "加载更多", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "加载更多", exact: true }).click();
  await expect(page.getByRole("link", { name: /批量任务/ })).toHaveCount(30);
  await expect(
    page.getByRole("button", { name: "加载更多", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("✓ 已全部加载")).toBeVisible();
  await page.getByRole("button", { name: "按标题排序" }).click();
  await expect(page).toHaveURL(/sort=title/);
  await expect(page).toHaveURL(/order=asc/);
  await expect
    .poll(() =>
      listGets.some(
        (path) =>
          path.includes("/tasks?") &&
          path.includes("sort=title") &&
          path.includes("order=asc") &&
          !path.includes("cursor="),
      ),
    )
    .toBe(true);
  expect(fixture.errors).toEqual([]);
});

test("acceptance requires every criterion and verified evidence", async ({
  page,
}) => {
  const fixture = await consoleFixture(page);
  await login(page);
  await navigate(page, "任务协作");
  await page.getByRole("link", { name: /验证协作界面/ }).click();
  await page.getByRole("tab", { name: "成果与验收" }).click();
  await page.getByLabel("审核意见").fill("核对后确认");
  await page.getByRole("button", { name: "提交验收决定" }).click();
  await expect(
    page.getByText("请先确认全部验收条件，或选择退回修改。"),
  ).toBeVisible();
  expect(
    fixture.posts.filter((item) => item.path.endsWith("/reviews")),
  ).toHaveLength(0);
  await page.getByRole("checkbox", { name: "核对测试证据" }).press("Space");
  await page.getByRole("button", { name: "提交验收决定" }).click();
  await expect
    .poll(
      () =>
        fixture.posts.filter((item) => item.path.endsWith("/reviews")).length,
    )
    .toBe(1);
});

test("all pages render and mobile navigation stays accessible", async ({
  page,
}) => {
  const fixture = await consoleFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.screenshot({ path: "test-results/ui/mobile.png", fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  for (const name of [
    "任务协作",
    "项目资料",
    "交付成果",
    "待审批",
    "执行客户端",
    "工具与集成",
    "项目成员",
    "审计记录",
  ]) {
    await navigate(page, name);
    await expect(
      page.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation").getByRole("button", { name, exact: true }),
    ).toHaveAttribute("aria-current", "page");
  }
  expect(
    await page.evaluate(() =>
      [...Object.values(localStorage), ...Object.values(sessionStorage)].some(
        (value) => value.includes("synthetic-ui-test-value"),
      ),
    ),
  ).toBe(false);
  expect(fixture.errors).toEqual([]);
});

test("login, workspace, dialog and table pass automated accessibility checks", async ({
  page,
}) => {
  const fixture = await consoleFixture(page);
  const { default: AxeBuilder } = await import("@axe-core/playwright");
  async function check() {
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(
      result.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => ({
          target: n.target,
          summary: n.failureSummary,
        })),
      })),
    ).toEqual([]);
  }
  await page.goto("/dev-login");
  await expect(page.getByLabel("个人开发凭证")).toBeVisible();
  await page.screenshot({ path: "test-results/ui/login.png", fullPage: true });
  await check();
  await login(page);
  await expect(page.getByText("跟进任务，确认交付。")).toBeVisible();
  await page.screenshot({
    path: "test-results/ui/overview.png",
    fullPage: true,
    animations: "disabled",
  });
  await check();
  await createTask(page);
  await page.screenshot({
    path: "test-results/ui/create-task.png",
    fullPage: true,
    animations: "disabled",
  });
  await check();
  await page.keyboard.press("Escape");
  await navigate(page, "项目成员");
  await check();
  expect(fixture.errors).toEqual([]);
});

test("catalogs preserve placeholders and format counts, dates and unknown labels", () => {
  const placeholders = (message: string) =>
    [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const catalog of [enUS, ruRU]) {
    expect(Object.keys(catalog).sort()).toEqual(Object.keys(zhCN).sort());
    for (const key of Object.keys(zhCN) as (keyof typeof zhCN)[]) {
      const translated = catalog[key];
      const variants =
        typeof translated === "string"
          ? [translated]
          : Object.values(translated);
      for (const variant of variants) {
        expect(variant.trim(), key).not.toBe("");
        expect(placeholders(variant), key).toEqual(placeholders(zhCN[key]));
      }
    }
  }
  const en = createTranslator("en-US");
  const zh = createTranslator("zh-CN");
  expect(en.translate("{count} 份成果", { count: 0 })).toBe("0 artifacts");
  expect(en.translate("{count} 份成果", { count: 1 })).toBe("1 artifact");
  expect(en.translate("{count} 项验收", { count: 2 })).toBe("2 criteria");
  expect(zh.translate("{count} 项验收", { count: 2 })).toBe("2 项验收");
  expect(en.number(1234)).toBe("1,234");
  expect(en.label("PROJECT_STANDARD")).toBe("Project standards");
  expect(en.label("FUTURE_STATUS")).toBe("FUTURE_STATUS");
  expect(en.label("toString")).toBe("toString");
  expect(zh.label("IN_REVIEW")).toBe("待验收");
  expect(en.stamp()).toBe("—");
  expect(en.stamp("invalid")).toBe("—");
  const date = new Date("2026-01-02T03:04:05Z");
  for (const locale of ["zh-CN", "en-US", "ru-RU"] as const) {
    const translator = createTranslator(locale);
    expect(translator.stamp(date.toISOString())).toBe(
      new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(date),
    );
  }
});

test("Russian plural categories handle zero, teens, compound counts and fractions", () => {
  const ru = createTranslator("ru-RU");
  for (const [count, noun] of [
    [0, "артефактов"],
    [1, "артефакт"],
    [2, "артефакта"],
    [4, "артефакта"],
    [5, "артефактов"],
    [11, "артефактов"],
    [12, "артефактов"],
    [14, "артефактов"],
    [21, "артефакт"],
    [22, "артефакта"],
    [25, "артефактов"],
    [101, "артефакт"],
    [111, "артефактов"],
    [1.5, "артефакта"],
  ] as const) {
    expect(ru.translate("{count} 份成果", { count })).toBe(
      `${ru.number(count)} ${noun}`,
    );
  }
  expect(ru.translate("{count} 项依据", { count: 1 })).toBe("1 источник");
  expect(ru.translate("{count} 项依据", { count: 2 })).toBe("2 источника");
  expect(ru.translate("{count} 项依据", { count: 5 })).toBe("5 источников");
  expect(ru.translate("{count} 项验收", { count: 1 })).toBe("1 критерий");
  expect(ru.translate("{count} 项验收", { count: 2 })).toBe("2 критерия");
  expect(ru.translate("{count} 项验收", { count: 5 })).toBe("5 критериев");
  expect(ru.number(1234.5)).toBe("1\u00a0234,5");
});

test.describe("Russian workspace", () => {
  test.use({ locale: "ru-KZ" });

  test("Russian detection, navigation, forms and persisted selection work on desktop and mobile", async ({
    page,
  }) => {
    const fixture = await consoleFixture(page);
    await page.goto("/dev-login");
    await expect(
      page.getByRole("combobox", { name: "Язык", exact: true }),
    ).toHaveValue("ru-RU");
    await expect(page.locator("html")).toHaveAttribute("lang", "ru-RU");
    await expect(page).toHaveTitle("ACCP · Консоль совместной работы");
    await page.screenshot({
      path: "test-results/ui/login-ru.png",
      fullPage: true,
    });
    await page
      .getByLabel("Ключ доступа разработчика")
      .fill("synthetic-ui-test-value");
    await page
      .getByRole("button", { name: "Войти в рабочую область", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Обзор", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/ui/overview-ru.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const name of [
      "Задачи",
      "Материалы проекта",
      "Артефакты",
      "На согласовании",
      "Клиенты выполнения",
      "Инструменты и интеграции",
      "Участники",
      "Журнал аудита",
      "Обзор",
    ]) {
      await navigate(page, name);
      await expect(
        page.getByRole("heading", { name, exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await page.screenshot({
      path: "test-results/ui/mobile-ru.png",
      fullPage: true,
    });
    await navigate(page, "Задачи");
    await page
      .getByRole("button", { name: "＋ Создать задачу", exact: true })
      .click();
    await page.getByLabel("Название задачи").fill("Проверка локализации");
    await page
      .getByLabel("Цель и объём работ")
      .fill("Сохранить пользовательский текст");
    await page
      .getByLabel("Критерии приёмки", { exact: false })
      .fill("Проверить данные");
    await page.getByRole("button", { name: /Исходные данные/ }).click();
    await page.getByRole("option", { name: /订单 API/ }).click();
    await page.keyboard.press("Escape");
    const { default: AxeBuilder } = await import("@axe-core/playwright");
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page
      .getByRole("button", { name: "Создать черновик", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(fixture.posts.at(-1)!.body).toMatchObject({
      title: "Проверка локализации",
      context_version_ids: ["version_api"],
      owner_user_id: "user_demo",
    });
    await page
      .getByRole("combobox", { name: "Язык", exact: true })
      .selectOption("en-US");
    await expect(
      page.getByRole("heading", { name: "Tasks", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("combobox", { name: "Language", exact: true })
      .selectOption("ru-RU");
    await page.reload();
    await expect(
      page.getByRole("combobox", { name: "Язык", exact: true }),
    ).toHaveValue("ru-RU");
    expect(await page.evaluate(() => localStorage.getItem("accp.locale"))).toBe(
      "ru-RU",
    );
    expect(fixture.errors).toEqual([]);
  });
});

test("switching language preserves login input, page and filters and persists after reload", async ({
  page,
}) => {
  const fixture = await consoleFixture(page);
  await page.goto("/dev-login");
  await page.getByLabel("个人开发凭证").fill("synthetic-ui-test-value");
  await page
    .getByRole("combobox", { name: "语言", exact: true })
    .selectOption("en-US");
  await expect(page.getByLabel("Development credential")).toHaveValue(
    "synthetic-ui-test-value",
  );
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(page).toHaveTitle("ACCP · Collaboration console");
  await page
    .getByRole("button", { name: "Sign in to workspace", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  await navigate(page, "Tasks");
  await page
    .getByRole("textbox", { name: "Search tasks", exact: true })
    .fill("验证");
  await page.getByRole("radio", { name: "My tasks", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("zh-CN");
  await expect(
    page.getByRole("heading", { name: "任务协作", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "搜索任务", exact: true }),
  ).toHaveValue("验证");
  await expect(
    page.getByRole("radio", { name: "我负责的", exact: true }),
  ).toBeChecked();
  await page
    .getByRole("combobox", { name: "语言", exact: true })
    .selectOption("en-US");
  await expect(page.getByRole("link", { name: /验证协作界面/ })).toBeVisible();
  await expect(page.getByRole("grid", { name: "Task list" })).toContainText(
    "验证协作界面",
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Language", exact: true }),
  ).toHaveValue("en-US");
  expect(await page.evaluate(() => localStorage.getItem("accp.locale"))).toBe(
    "en-US",
  );
  expect(fixture.errors).toEqual([]);
});

test.describe("English workspace", () => {
  test.use({ locale: "en-GB" });

  test("browser detection, all pages, dialogs and submissions work in English", async ({
    page,
  }) => {
    const fixture = await consoleFixture(page);
    await page.goto("/dev-login");
    await expect(
      page.getByRole("combobox", { name: "Language", exact: true }),
    ).toHaveValue("en-US");
    await page
      .getByLabel("Development credential")
      .fill("synthetic-ui-test-value");
    await page
      .getByRole("button", { name: "Sign in to workspace", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Overview", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("演示项目", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText("Administrator / Member / Reviewer", { exact: true }),
    ).toBeVisible();
    const { default: AxeBuilder } = await import("@axe-core/playwright");
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({
      path: "test-results/ui/overview-en.png",
      fullPage: true,
    });
    for (const name of [
      "Tasks",
      "Project materials",
      "Artifacts",
      "To review",
      "Execution clients",
      "Tools & integrations",
      "Members",
      "Audit log",
    ]) {
      await navigate(page, name);
      await expect(
        page.getByRole("heading", { name, exact: true }),
      ).toBeVisible();
    }
    await navigate(page, "Tasks");
    await page.getByRole("button", { name: "＋ Create task" }).click();
    await page.getByLabel("Task title").fill("Keep this user content 中文");
    await page
      .getByLabel("Objective and scope")
      .fill("Preserve submitted values");
    await page
      .getByLabel("Acceptance criteria", { exact: false })
      .fill("Verify i18n payload");
    await page.getByRole("button", { name: /Execution inputs/ }).click();
    await page.getByRole("option", { name: /订单 API/ }).click();
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Create draft", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(fixture.posts.at(-1)!.body).toMatchObject({
      title: "Keep this user content 中文",
      owner_user_id: "user_demo",
      repository_id: "repo_demo",
      context_version_ids: ["version_api"],
      acceptance_criteria: ["Verify i18n payload"],
    });
    await page.getByRole("link", { name: /验证协作界面/ }).click();
    await page.getByRole("tab", { name: "Artifacts and acceptance" }).click();
    await page.getByRole("checkbox", { name: "核对测试证据" }).press("Space");
    await page.getByLabel("Review comments").fill("Reviewed in English");
    await page
      .getByRole("button", { name: "Submit acceptance decision", exact: true })
      .click();
    await expect(
      page
        .getByRole("region", { name: "Task details" })
        .getByText("Done", { exact: true }),
    ).toBeVisible();
    expect(fixture.posts.at(-1)!.body).toMatchObject({
      decision: "ACCEPT",
      acceptance_checks: [true],
    });
    await navigate(page, "Tasks");
    await page.setViewportSize({ width: 390, height: 844 });
    await navigate(page, "Overview");
    await expect(
      page.getByRole("combobox", { name: "Language", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/ui/mobile-en.png",
      fullPage: true,
    });
    expect(fixture.errors).toEqual([]);
  });
});

test.describe("locale fallbacks", () => {
  test.use({ locale: "fr-FR" });

  test("unsupported saved and browser locales fall back to Chinese", async ({
    page,
  }) => {
    await consoleFixture(page);
    await page.addInitScript(() =>
      localStorage.setItem("accp.locale", "invalid"),
    );
    await page.goto("/dev-login");
    await expect(
      page.getByRole("combobox", { name: "语言", exact: true }),
    ).toHaveValue("zh-CN");
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  });

  test("saved language overrides the browser and existing errors translate", async ({
    page,
  }) => {
    await page.addInitScript(() =>
      localStorage.setItem("accp.locale", "en-US"),
    );
    await page.route("**/api/v1/auth/config", (route) =>
      route.fulfill({ status: 503, json: {} }),
    );
    await page.goto("/");
    await expect(page.getByRole("alert")).toContainText(
      "The sign-in service is temporarily unavailable.",
    );
    await page
      .getByRole("combobox", { name: "Language", exact: true })
      .selectOption("zh-CN");
    await expect(page.getByRole("alert")).toContainText("登录服务暂不可用");
    await expect(page).toHaveTitle("ACCP · 协作控制台");
  });

  test("blocked storage does not prevent rendering or language changes", async ({
    page,
  }) => {
    const fixture = await consoleFixture(page);
    await page.addInitScript(() => {
      Storage.prototype.getItem = () => {
        throw new DOMException("Blocked", "SecurityError");
      };
      Storage.prototype.setItem = () => {
        throw new DOMException("Blocked", "SecurityError");
      };
    });
    await page.goto("/dev-login");
    await page
      .getByRole("combobox", { name: "语言", exact: true })
      .selectOption("en-US");
    await expect(page.getByLabel("Development credential")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
    expect(fixture.errors).toEqual([]);
  });
});
