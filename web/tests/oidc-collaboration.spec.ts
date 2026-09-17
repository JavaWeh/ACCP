import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

test("real OIDC task editing, archive restore and bound pagination with runtime roles", async ({
  page,
}) => {
  const users = JSON.parse(
    readFileSync(process.env.ACCP_OIDC_CREDENTIALS_FILE!, "utf8"),
  );
  const user = users.find((u: { username: string }) => u.username === "admin");
  const issued = page.waitForResponse(
    (r) =>
      r.url().includes("/protocol/openid-connect/token") &&
      r.request().method() === "POST",
  );
  await page.goto("/");
  await page.getByRole("button", { name: "使用企业账号登录 →" }).click();
  await page.locator("#username").fill(user.username);
  await page.locator("#password").fill(user.password);
  await page.locator("#kc-login").click();
  const token = (await (await issued).json()).access_token;
  await expect(
    page.getByRole("heading", { name: "工作概览", exact: true }),
  ).toBeVisible();
  const seed = await page.evaluate(async (token) => {
    async function api(path: string, body?: unknown, version?: number) {
      const response = await fetch("/api/v1" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(body !== undefined
            ? { "Idempotency-Key": crypto.randomUUID() }
            : {}),
          ...(version ? { "If-Match": `"${version}"` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(`${path}: ${response.status} ${data.code}`);
      return data;
    }
    const me = await api("/me"),
      project = await api("/projects", {
        name: "Collaboration acceptance " + Date.now(),
        reason: "Isolated acceptance",
      });
    const repo = await api(`/projects/${project.id}/repositories`, {
      url: "https://github.com/example/orders",
      default_branch: "main",
      reason: "Register fixture",
    });
    const content = await api(`/projects/${project.id}/contents`, {
      content: "Acceptance input",
      media_type: "text/plain",
    });
    const context = await api(`/projects/${project.id}/contexts`, {
      name: "Acceptance requirements",
      type: "REQUIREMENT",
      source: { kind: "ACCP", canonical_uri: "urn:accp:acceptance" },
    });
    const version = await api(
      `/contexts/${context.id}/versions`,
      {
        source_revision: "1",
        content_uri: content.content_uri,
        content_digest: content.content_digest,
        media_type: "text/plain",
        change_summary: "Initial",
      },
      1,
    );
    await api(`/contexts/${context.id}/versions/${version.id}/publish`, {}, 1);
    const task = await api(`/projects/${project.id}/tasks`, {
      title: "OIDC lifecycle draft",
      objective: "Verify human lifecycle",
      owner_user_id: me.id,
      repository_id: repo.id,
      context_version_ids: [version.id],
      acceptance_criteria: ["Retain history"],
    });
    const opts = await api(
      `/projects/${project.id}/context-version-options?sort=title&limit=25`,
    );
    if (opts.items[0]?.id !== version.id)
      throw new Error("Published selector failed");
    return { project: project.id, task: task.id };
  }, token);
  // Stay in the authenticated document while changing its shareable location.
  await page.evaluate(({ project, task }) => {
    history.pushState(null, "", `/?project=${project}&page=tasks&task=${task}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, seed);
  // Refresh the project catalogue after creating the fixture via the same authenticated API.
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "项目管理", exact: true })
    .click();
  // The seeded project is picked up after reauthentication without retaining browser tokens.
  await page.goto(`/?project=${seed.project}&page=tasks&task=${seed.task}`);
  await page.getByRole("button", { name: "使用企业账号登录 →" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("任务变更与责任记录", { exact: true }).click();
  await dialog.getByRole("button", { name: "变更类型" }).click();
  await page.getByRole("option", { name: "编辑草稿", exact: true }).click();
  await dialog.getByLabel("任务标题", { exact: true }).fill("OIDC edited task");
  await dialog.getByLabel("变更原因").fill("Correct acceptance draft");
  await dialog.getByRole("button", { name: "确认变更", exact: true }).click();
  await expect(dialog).toContainText("OIDC edited task");
  const result = await page.evaluate(
    async ({ token, task, project }) => {
      async function post(action: string, version: number, body: unknown) {
        const r = await fetch(`/api/v1/tasks/${task}/${action}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
            "If-Match": `"${version}"`,
          },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`${action}: ${r.status}`);
        return r.json();
      }
      await post("commands", 2, {
        command: "CANCEL",
        reason: "End before archive",
      });
      await post("archive", 3, { reason: "Archive evidence" });
      await post("restore", 4, { reason: "Restore evidence" });
      const response = await fetch(`/api/v1/tasks/${task}/changes?limit=25`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const changes = await response.json();
      const audit = await fetch(
        `/api/v1/projects/${project}/audit-records?sort=-updated&search=${task}&limit=25`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      return { changes: changes.items.length, auditStatus: audit.status };
    },
    { token, task: seed.task, project: seed.project },
  );
  expect(result).toEqual({ changes: 3, auditStatus: 200 });
});
