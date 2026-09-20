import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

test("real GitHub immutable candidate, duplicate sync, diff and human publication", async ({
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
  const result = await page.evaluate(async (token) => {
    async function api(path: string, body?: unknown, version?: number) {
      const response = await fetch("/api/v1" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(body === undefined
            ? {}
            : { "Idempotency-Key": crypto.randomUUID() }),
          ...(version ? { "If-Match": `"${version}"` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(`${path}: ${response.status} ${data.code}`);
      return data;
    }
    const project = await api("/projects", {
      name: "Git acceptance " + Date.now(),
      reason: "Isolated source acceptance",
    });
    const repo = await api(`/projects/${project.id}/repositories`, {
      url: "https://github.com/JavaWeh/ACCP",
      default_branch: "main",
      reason: "Registered public source",
    });
    const context = await api(`/projects/${project.id}/git-contexts`, {
      name: "Git README",
      type: "PROJECT_STANDARD",
      repository_id: repo.id,
      path: "README.md",
      ref: "main",
      reason: "Use registered Git authority",
    });
    const started = performance.now();
    const first = await api(
      `/contexts/${context.id}/source-sync`,
      { reason: "Read public GitHub" },
      1,
    );
    const externalMS = performance.now() - started;
    const same = await api(
      `/contexts/${context.id}/source-sync`,
      { reason: "Verify deduplication" },
      2,
    );
    if (same.id !== first.id) throw new Error("Duplicate version");
    const diff = await api(`/contexts/${context.id}/versions/${first.id}/diff`);
    if (!diff.after.includes("ACCP") || diff.before !== "")
      throw new Error("Wrong initial diff");
    return {
      project: project.id,
      context: context.id,
      version: first.id,
      commit: first.git_provenance.commit_sha,
      blob: first.git_provenance.blob_sha,
      externalMS,
    };
  }, token);
  expect(result.commit).toMatch(/^[a-f0-9]{40}$/);
  expect(result.blob).toMatch(/^[a-f0-9]{40}$/);
  await page.goto(`/?project=${result.project}&page=contexts`);
  await page.getByRole("button", { name: "使用企业账号登录 →" }).click();
  await page
    .getByRole("button")
    .filter({
      has: page.getByRole("heading", { name: "Git README", exact: true }),
    })
    .click();
  const dialog = page.getByRole("dialog", { name: "Git README", exact: true });
  await dialog.getByRole("button", { name: "查看差异与任务影响" }).click();
  await expect(dialog.getByText("候选正文", { exact: true })).toBeVisible();
  await expect(dialog.getByText("本页暂无受影响任务。")).toBeVisible();
  await dialog.getByRole("button", { name: "发布版本", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "发布版本", exact: true }),
  ).toHaveCount(0);
  const published = await page.evaluate(
    async ({ token, context, version }) => {
      const r = await fetch(`/api/v1/contexts/${context}/versions/${version}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return r.json();
    },
    { token, ...result },
  );
  expect(published.status).toBe("PUBLISHED");
  expect(published.git_provenance.commit_sha).toBe(result.commit);
  console.log(
    JSON.stringify({
      commit: result.commit,
      blob: result.blob,
      external_git_ms: Math.round(result.externalMS),
      duplicate: true,
      human_published: true,
    }),
  );
});
