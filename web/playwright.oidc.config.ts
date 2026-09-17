import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: process.env.ACCP_OIDC_GIT_CONTEXT
    ? "oidc-git-context.spec.ts"
    : process.env.ACCP_OIDC_LIFECYCLE
      ? "oidc-lifecycle.spec.ts"
      : process.env.ACCP_OIDC_COLLABORATION
        ? "oidc-collaboration.spec.ts"
        : "oidc.spec.ts",
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: process.env.ACCP_OIDC_URL || "https://accp.localhost:18443",
    locale: "zh-CN",
    trace: "off",
    screenshot: "off",
    launchOptions: {
      executablePath: process.env.ACCP_OIDC_BROWSER,
      args: [
        "--host-resolver-rules=MAP accp.localhost caddy, MAP idp.localhost caddy",
      ],
    },
  },
  reporter: "list",
});
