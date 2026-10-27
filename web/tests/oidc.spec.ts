import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
const users = JSON.parse(
  readFileSync(process.env.ACCP_OIDC_CREDENTIALS_FILE!, "utf8"),
) as { username: string; password: string; id: string }[];
async function login(page: Page, name: string) {
  const user = users.find((u) => u.username === name)!;
  await page.goto("/");
  await page.getByRole("button", { name: "使用企业账号登录 →" }).click();
  await page.locator("#username").fill(user.username);
  await page.locator("#password").fill(user.password);
  await page.locator("#kc-login").click();
}

test("real Keycloak PKCE login and enterprise administration with runtime database privileges", async ({
  page,
}) => {
  await login(page, "admin");
  await expect(
    page.getByRole("heading", { name: "工作概览", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        Object.entries(sessionStorage).filter(([k]) =>
          k.startsWith("oidc.user:"),
        ).length,
    ),
  ).toBe(1);
  expect(
    await page.evaluate(
      () =>
        Object.entries(localStorage).filter(([k]) => k.startsWith("oidc.user:"))
          .length,
    ),
  ).toBe(0);
  await page.getByTestId("area-management").click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "项目设置", exact: true })
    .click();
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await page.getByRole("button", { name: "＋ 创建项目" }).click();
  const create = page.getByRole("dialog", { name: "创建项目" });
  await create.getByLabel("项目名称").fill("OIDC administration acceptance");
  await create.getByLabel("操作原因").fill("Acceptance");
  await create.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "已创建项目 OIDC administration acceptance" }),
  ).toBeVisible();
  // US-15: create does reload() without id, so the current project stays
  // project_initial (seeded with https://github.com/example/orders). Switch the
  // header project Select to the newly created project before touching members
  // and repos, otherwise the repo registration hits that seeded URL and returns
  // 409 REPOSITORY_EXISTS instead of the expected 已登记仓库 success.
  // The HeroUI Select trigger's accessible name is the selected value (e.g.
  // the seeded project), not the aria-label 当前项目, so open it via data-slot.
  await page.locator('header [data-slot="select-trigger"]').click();
  await page
    .getByRole("option", {
      name: "OIDC administration acceptance",
      exact: true,
    })
    .click();
  // Switching navigates to the project overview; re-enter management.
  await page.getByTestId("area-management").click();
  await page
    .getByRole("main")
    .getByRole("button", { name: "设置", exact: true })
    .click();
  const member = page.locator("section").filter({
    has: page.getByRole("heading", { name: "登记企业成员", exact: true }),
  });
  const memberName = `OIDC member ${Date.now()}`;
  await member
    .getByLabel("身份主体标识")
    .fill(`acceptance-${crypto.randomUUID()}`);
  await member.getByLabel("显示名称").fill(memberName);
  await member.getByLabel("操作原因").fill("Onboard");
  await member
    .getByRole("button", { name: "登记企业成员", exact: true })
    .click();
  const add = page.locator("section").filter({
    has: page.getByRole("heading", { name: "添加项目成员", exact: true }),
  });
  await expect(
    add.locator("select option").filter({ hasText: memberName }),
  ).toHaveCount(1);
  await add.locator("select").selectOption({
    label: (await add
      .locator("select option")
      .filter({ hasText: memberName })
      .textContent()) as string,
  });
  await add.getByLabel("操作原因").fill("Join");
  await add.getByRole("button", { name: "添加项目成员", exact: true }).click();
  await expect(add.locator("form")).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "仓库", exact: true }).click();
  await page.getByRole("button", { name: "＋ 登记仓库" }).click();
  const repo = page.getByRole("dialog", { name: "登记仓库" });
  await repo.getByLabel("仓库地址").fill("https://github.com/example/orders");
  await repo.getByLabel("操作原因").fill("Delivery");
  await repo.getByRole("button", { name: "登记仓库", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: /已登记仓库/ }),
  ).toBeVisible();
  await expect(
    page.getByText("https://github.com/example/orders", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await page
    .getByRole("button", {
      name: /归档项目 OIDC administration acceptance/,
    })
    .click();
  const archive = page.getByRole("alertdialog", {
    name: /归档项目 OIDC administration acceptance？/,
  });
  await archive.getByLabel("操作原因").fill("Archive");
  await archive.getByRole("button", { name: "归档项目", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: /已归档项目/ }),
  ).toBeVisible();
  await page.getByLabel("状态", { exact: true }).click();
  await page.getByRole("option", { name: "已归档", exact: true }).click();
  await page
    .getByRole("button", { name: /恢复 OIDC administration acceptance/ })
    .click();
  const restore = page.getByRole("alertdialog", {
    name: /恢复项目 OIDC administration acceptance？/,
  });
  await restore.getByLabel("操作原因").fill("Restore");
  await restore.getByRole("button", { name: "恢复项目", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: /已恢复项目/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "使用企业账号登录 →" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "使用企业账号登录 →" }).click();
  await expect(page.locator("#username")).toBeVisible();
});

test("unprovisioned real IdP subject cannot access the enterprise", async ({
  page,
}) => {
  await login(page, "unmapped");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "工作概览", exact: true }),
  ).toHaveCount(0);
});

test("real access token authorizes API while ID token is rejected and a same-tab reload keeps the session", async ({
  page,
}) => {
  const issued = page.waitForResponse(
    (r) =>
      r.url().endsWith("/protocol/openid-connect/token") &&
      r.request().method() === "POST",
  );
  await login(page, "admin");
  const tokens = await (await issued).json();
  const access = await page.request.get("/api/v1/me", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  expect(access.status()).toBe(200);
  const identity = await page.request.get("/api/v1/me", {
    headers: { Authorization: `Bearer ${tokens.id_token}` },
  });
  expect(identity.status()).toBe(401);
  await expect(
    page.getByRole("heading", { name: "工作概览", exact: true }),
  ).toBeVisible();
  await page.reload();
  // Keep-login MVP: ACCP restores its own access token from the tab-scoped
  // sessionStorage userStore, so a same-tab reload shows the console again
  // without a fresh login click and without a new PKCE token exchange.
  await expect(
    page.getByRole("heading", { name: "工作概览", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "使用企业账号登录 →" }),
  ).toHaveCount(0);
});
