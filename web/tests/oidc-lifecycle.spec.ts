import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

test("rotated real IdP key is refreshed, expired access token is rejected, and PKCE reauthenticates", async ({
  page,
}) => {
  const users = JSON.parse(
    readFileSync(process.env.ACCP_OIDC_CREDENTIALS_FILE!, "utf8"),
  );
  const admin = users.find(
    (user: { username: string }) => user.username === "admin",
  );
  const issued = page.waitForResponse(
    (response) =>
      response.url().endsWith("/protocol/openid-connect/token") &&
      response.request().method() === "POST",
  );
  await page.goto("/");
  await page.getByRole("button", { name: "使用企业账号登录 →" }).click();
  await page.locator("#username").fill(admin.username);
  await page.locator("#password").fill(admin.password);
  await page.locator("#kc-login").click();
  const tokens = await (await issued).json();
  const header = JSON.parse(
    Buffer.from(tokens.access_token.split(".")[0], "base64url").toString(),
  );
  const claims = JSON.parse(
    Buffer.from(tokens.access_token.split(".")[1], "base64url").toString(),
  );
  expect(header.kid).toBe(process.env.ACCP_EXPECTED_SIGNING_KID);
  expect(
    (
      await page.request.get("/api/v1/me", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
    ).status(),
  ).toBe(200);
  const wait = claims.exp * 1000 - Date.now() + 1200;
  expect(wait).toBeLessThan(20000);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, wait)));
  expect(
    (
      await page.request.get("/api/v1/me", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
    ).status(),
  ).toBe(401);
  await page.reload();
  const renewed = page.waitForResponse(
    (response) =>
      response.url().endsWith("/protocol/openid-connect/token") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "使用企业账号登录 →" }).click();
  const fresh = await (await renewed).json();
  expect(fresh.access_token).not.toBe(tokens.access_token);
  expect(
    (
      await page.request.get("/api/v1/me", {
        headers: { Authorization: `Bearer ${fresh.access_token}` },
      })
    ).status(),
  ).toBe(200);
});
