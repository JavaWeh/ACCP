import { defineConfig } from "@playwright/test";
const target = new URL(process.env.ACCP_WEB_URL || "http://127.0.0.1:18082");
if (
  target.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
)
  throw new Error(
    "Browser acceptance requires an isolated loopback development deployment.",
  );
export default defineConfig({
  testDir: "./tests",
  testIgnore: "ui.spec.ts",
  timeout: 45000,
  workers: 1,
  retries: 0,
  use: {
    locale: "zh-CN",
    channel: "chromium",
    baseURL: process.env.ACCP_WEB_URL || "http://127.0.0.1:18082",
    viewport: { width: 1440, height: 1000 },
    trace: "off",
    screenshot: "only-on-failure",
  },
  reporter: [["list"]],
  outputDir: "test-results",
});
