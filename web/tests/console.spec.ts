import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const credentials = JSON.parse(
  readFileSync(
    process.env.ACCP_WEB_CREDENTIALS_FILE || "../.accp-local/m34-users.json",
    "utf8",
  ),
);
const bob = credentials.find(
  (u: { user_id: string }) => u.user_id === "user_bob",
).token;

test("human console creates and publishes context, creates a task, and reads audit", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "进入协作工作空间" }),
  ).toBeVisible();
  await page.getByLabel("个人开发凭证").fill(bob);
  await page.getByRole("button", { name: "登录工作空间", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "工作概览", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/overview.png", fullPage: true });
  await page
    .getByRole("button", { name: "共享上下文", exact: false })
    .first()
    .click();
  await page.getByRole("button", { name: "新建上下文", exact: false }).click();
  const contextName = `浏览器验收 API ${Date.now()}`;
  await page.getByLabel("名称", { exact: true }).fill(contextName);
  await page
    .getByRole("combobox", { name: "类型", exact: true })
    .selectOption("API");
  await page.getByLabel("来源版本", { exact: true }).fill("1.0");
  await page.getByLabel("变更说明").fill("浏览器端验收");
  await page.getByLabel("正文（Markdown）").fill("# Orders API\nGET /orders");
  await page.getByRole("button", { name: "创建候选版本", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: new RegExp(contextName) }).click();
  await page.getByRole("button", { name: "发布版本", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText("已发布", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page
    .getByRole("button", { name: "任务协作", exact: false })
    .first()
    .click();
  await page.getByRole("button", { name: "创建任务", exact: false }).click();
  const taskName = `浏览器验收任务 ${Date.now()}`;
  await page.getByLabel("任务标题").fill(taskName);
  await page
    .getByLabel("目标与范围")
    .fill("验证任务创建、Owner 和版本化输入。");
  await page
    .getByLabel("验收条件", { exact: false })
    .fill("验证人类责任主体与不可变输入");
  const versionID = await page
    .locator('select[name="contexts"] option')
    .filter({ hasText: contextName })
    .getAttribute("value");
  await page.locator('select[name="contexts"]').selectOption(versionID!);
  await page.getByRole("button", { name: "创建草稿", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: new RegExp(taskName) }).click();
  await expect(
    page.getByRole("dialog").getByText("草稿", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "分配并提交执行", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByText("可执行", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.screenshot({ path: "test-results/tasks.png", fullPage: true });
  for (const name of [
    "交付成果",
    "审批中心",
    "执行代理",
    "工具网关",
    "项目成员",
    "审计记录",
  ]) {
    await page
      .getByRole("navigation")
      .getByRole("button", { name, exact: false })
      .click();
    await expect(
      page.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  }
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(page.getByLabel("个人开发凭证")).toBeVisible();
  expect(errors).toEqual([]);
});

test("mobile console remains navigable and credentials are never persisted", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByLabel("个人开发凭证").fill(bob);
  await page.getByRole("button", { name: "登录工作空间", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "工作概览", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      Object.values(localStorage)
        .concat(Object.values(sessionStorage))
        .some((v) => v.startsWith("accp_")),
    ),
  ).toBe(false);
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true });
  await page.reload();
  await expect(page.getByLabel("个人开发凭证")).toBeVisible();
});

test("Owner reviews actual protocol evidence and completes the task from Web", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(90000);
  const report = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "scripts/m2-smoke.mjs",
        baseURL!,
        resolve(
          process.env.ACCP_WEB_CREDENTIALS_FILE ||
            "../.accp-local/m34-users.json",
        ),
      ],
      { cwd: resolve(".."), encoding: "utf8", timeout: 55000 },
    ),
  );
  expect(report.task_status).toBe("IN_REVIEW");
  await page.goto("/");
  await page.getByLabel("个人开发凭证").fill(bob);
  await page.getByRole("button", { name: "登录工作空间", exact: true }).click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "任务协作", exact: false })
    .click();
  await page.getByLabel("搜索任务").fill("M2 protocol acceptance");
  const visibleTaskID =
    report.task_id.slice(0, 8) + "…" + report.task_id.slice(-6);
  await page.getByRole("button", { name: new RegExp(visibleTaskID) }).click();
  await page.getByRole("button", { name: "成果与验收", exact: true }).click();
  await page.getByRole("heading", { name: "Owner 最终验收" }).waitFor();
  await page.locator('input[name="criterion_0"]').check();
  await page
    .getByLabel("审核意见")
    .fill(
      "Verified stored evidence and protocol execution from the Web console.",
    );
  await page.getByRole("button", { name: "提交验收决定", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText("已完成", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "报告与记录", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText(/接受 · user_bob/),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/owner-review.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "交付成果", exact: false })
    .click();
  await expect(page.getByText("已接受", { exact: true }).first()).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "执行代理", exact: false })
    .click();
  const client = `Browser adapter ${Date.now()}`;
  await page
    .getByRole("button", { name: "注册执行代理", exact: false })
    .click();
  await page.getByLabel("客户端名称").fill(client);
  await page.getByLabel("客户端版本").fill("0.2.0");
  await page.getByRole("button", { name: "注册代理", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .locator(".context-card")
    .filter({ hasText: client })
    .getByRole("button", { name: "授权执行", exact: false })
    .click();
  await page.getByRole("button", { name: "创建短期授权", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "执行授权已创建" }),
  ).toBeVisible();
  const session = await page.getByLabel("Session ID").inputValue();
  await expect(page.getByLabel("访问凭证")).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page
    .locator(".record-row")
    .filter({ hasText: client })
    .getByRole("button", { name: "撤销授权", exact: true })
    .click();
  const status = await page.request.get(`/api/v1/agent-sessions/${session}`, {
    headers: { Authorization: `Bearer ${bob}` },
  });
  expect((await status.json()).status).toBe("REVOKED");
});
