import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { Doc } from "../src/api";
import { createTranslator } from "../src/i18n";
import { zhCN } from "../src/locales/zh-CN";
import { enUS } from "../src/locales/en-US";
import { ruRU } from "../src/locales/ru-RU";

// Synthetic data only: these tests never contact an ACCP deployment.
async function consoleFixture(page: Page) {
  const posts: { path: string; body: Record<string, any> }[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const member = {
    id: "user_demo",
    display_name: "演示用户",
    roles: ["ADMIN", "MEMBER", "REVIEWER"],
    active: true,
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
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    const send = (body: unknown, status = 200) =>
      route.fulfill({ status, json: body });
    if (request.method() === "POST") {
      const body = request.postDataJSON();
      posts.push({ path, body });
      if (path === "/projects/project_demo/tasks") {
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
    if (path === "/auth/config") return send({ mode: "development" });
    if (path === "/me") return send(member);
    if (path === "/projects")
      return send({
        items: [
          { id: "project_demo", name: "演示项目" },
          { id: "project_other", name: "第二项目" },
        ],
      });
    if (/\/projects\/[^/]+\/members$/.test(path))
      return send({ items: [member] });
    if (/\/projects\/[^/]+\/tasks$/.test(path)) return send({ items: tasks });
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
    errors,
    failNextTask: () => {
      failTask = true;
    },
  };
}
async function login(page: Page) {
  await page.goto("/");
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
  await page
    .getByRole("navigation")
    .getByRole("button", { name, exact: true })
    .click();
}
async function createTask(page: Page) {
  await navigate(page, "任务协作");
  await page.getByRole("button", { name: "＋ 创建任务" }).click();
  await page.getByLabel("任务标题").fill("多依据任务");
  await page.getByLabel("目标与范围").fill("验证多选和默认负责人");
  await page.getByLabel("验收条件", { exact: false }).fill("检查返回数据");
}

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

test("dialogs trap focus, Escape dismisses and returns focus to the trigger", async ({
  page,
}) => {
  const fixture = await consoleFixture(page);
  await login(page);
  await navigate(page, "共享上下文");
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
  await page.getByRole("button", { name: /验证协作界面/ }).click();
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
    page.getByRole("dialog").getByText("已完成", { exact: true }),
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

test("delegation defaults and member permissions preserve checked values", async ({
  page,
}) => {
  const fixture = await consoleFixture(page);
  await login(page);
  await navigate(page, "执行代理");
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
  await page.getByRole("button", { name: "管理角色" }).click();
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
    "共享上下文",
    "交付成果",
    "审批中心",
    "执行代理",
    "工具网关",
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
  await page.goto("/");
  await expect(page.getByLabel("个人开发凭证")).toBeVisible();
  await page.screenshot({ path: "test-results/ui/login.png", fullPage: true });
  await check();
  await login(page);
  await expect(page.getByText("把目标变成可追溯的交付。")).toBeVisible();
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
    await page.goto("/");
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
      "Общий контекст",
      "Артефакты",
      "Согласования",
      "Агенты",
      "Шлюз инструментов",
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
  await page.goto("/");
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
  await expect(
    page.getByRole("button", { name: /验证协作界面/ }),
  ).toContainText("1 input");
  await expect(
    page.getByRole("button", { name: /验证协作界面/ }),
  ).toContainText("1 criterion");
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
    await page.goto("/");
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
      "Shared context",
      "Artifacts",
      "Approvals",
      "Agents",
      "Tool gateway",
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
    await page.getByRole("button", { name: /验证协作界面/ }).click();
    await page.getByRole("tab", { name: "Artifacts and acceptance" }).click();
    await page.getByRole("checkbox", { name: "核对测试证据" }).press("Space");
    await page.getByLabel("Review comments").fill("Reviewed in English");
    await page
      .getByRole("button", { name: "Submit acceptance decision", exact: true })
      .click();
    await expect(
      page.getByRole("dialog").getByText("Done", { exact: true }),
    ).toBeVisible();
    expect(fixture.posts.at(-1)!.body).toMatchObject({
      decision: "ACCEPT",
      acceptance_checks: [true],
    });
    await page.getByRole("button", { name: "Close", exact: true }).click();
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
    await page.goto("/");
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
    await page.goto("/");
    await page
      .getByRole("combobox", { name: "语言", exact: true })
      .selectOption("en-US");
    await expect(page.getByLabel("Development credential")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
    expect(fixture.errors).toEqual([]);
  });
});
