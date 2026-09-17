import { test, expect } from "@playwright/test";

test("ADMIN handoff downloads keep project scope and page cursor", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname.replace("/api/v1", "");
    let json: unknown = { items: [] };
    if (path === "/auth/config") json = { mode: "development" };
    if (path === "/me") json = { id: "user_one", display_name: "Admin" };
    if (path === "/projects")
      json = { items: [{ id: "project_one", name: "Project" }] };
    if (path.endsWith("/members"))
      json = {
        items: [
          {
            id: "user_one",
            display_name: "Admin",
            roles: ["ADMIN"],
            active: true,
          },
        ],
      };
    if (path.endsWith("/diagnostics"))
      json = { project_id: "project_one", outbox_pending: 0 };
    if (path.endsWith("/audit-export")) {
      requests.push(url.search);
      json = {
        items: [{ id: "audit_one" }],
        next_cursor: url.searchParams.has("cursor") ? null : "next+page",
      };
    }
    return route.fulfill({ json });
  });
  await page.goto("/?project=project_one&page=operations");
  await page.getByLabel("个人开发凭证").fill("synthetic");
  await page.getByRole("button", { name: "登录工作空间", exact: true }).click();
  const diagnostic = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载项目诊断", exact: true }).click();
  expect((await diagnostic).suggestedFilename()).toBe(
    "diagnostics-project_one.json",
  );
  for (let i = 1; i <= 2; i++) {
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "下载下一页审计", exact: true })
      .click();
    expect((await download).suggestedFilename()).toBe(
      `audit-project_one-${i}.json`,
    );
  }
  await expect(page.getByText("已下载 2 页，本次分页结束。")).toBeVisible();
  expect(requests).toEqual(["?limit=100", "?limit=100&cursor=next%2Bpage"]);
  await expect(
    page.getByRole("button", { name: "下载下一页审计", exact: true }),
  ).toHaveCount(0);
});
