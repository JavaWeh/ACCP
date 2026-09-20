import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: [
    "ui.spec.ts",
    "product.spec.ts",
    "events.spec.ts",
    "handoff.spec.ts",
  ],
  timeout: 30000,
  workers: 1,
  use: {
    locale: "zh-CN",
    channel: process.env.ACCP_UI_BROWSER || "chromium",
    baseURL: "http://127.0.0.1:18083",
    viewport: { width: 1440, height: 1000 },
    trace: "off",
    screenshot: "only-on-failure",
  },
  webServer: process.env.ACCP_UI_MANAGED_SERVER
    ? undefined
    : {
        command:
          "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 18083 --strictPort",
        url: "http://127.0.0.1:18083",
        reuseExistingServer: false,
      },
  reporter: [["list"]],
  outputDir: "test-results/ui",
});
