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
  ).toBe(0);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "项目管理", exact: true })
    .click();
  const create = page.locator("section").filter({
    has: page.getByRole("heading", { name: "创建项目", exact: true }),
  });
  await create.getByLabel("项目名称").fill("OIDC administration acceptance");
  await create.getByLabel("操作原因").fill("Acceptance");
  await create.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "项目设置", exact: true }),
  ).toBeVisible();
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
  const repo = page.locator("section").filter({
    has: page.getByRole("heading", { name: "登记仓库", exact: true }),
  });
  await repo
    .getByLabel("GitHub 仓库地址")
    .fill("https://github.com/example/orders");
  await repo.getByLabel("操作原因").fill("Delivery");
  await repo.getByRole("button", { name: "登记仓库", exact: true }).click();
  await expect(repo.locator("form")).toHaveAttribute("aria-busy", "false");
  await expect(repo.getByRole("alert")).toHaveCount(0);
  await expect(
    repo.getByText("https://github.com/example/orders · main"),
  ).toBeVisible();
  const settings = page.locator("section").filter({
    has: page.getByRole("heading", { name: "项目设置", exact: true }),
  });
  await settings.locator("form").last().getByLabel("操作原因").fill("Archive");
  await settings.getByRole("button", { name: "归档项目", exact: true }).click();
  await expect(
    settings.getByRole("button", { name: "恢复项目", exact: true }),
  ).toBeVisible();
  await settings.getByLabel("操作原因").fill("Restore");
  await settings.getByRole("button", { name: "恢复项目", exact: true }).click();
  await expect(
    settings.getByRole("button", { name: "归档项目", exact: true }),
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

test("real access token authorizes API while ID token is rejected and reload requires authentication", async ({
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
  await page.getByRole("button", { name: "使用企业账号登录 →" }).click();
  // The new PKCE exchange may use the IdP SSO cookie; ACCP does not persist tokens.
  await expect(
    page.getByRole("heading", { name: "工作概览", exact: true }),
  ).toBeVisible();
});
