import { createServer } from "vite";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Own Vite in this process so Windows never has to kill a shell's process tree.
const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({
  root,
  server: { host: "127.0.0.1", port: 18083, strictPort: true },
});
await server.listen();
const child = spawn(
  process.execPath,
  [
    fileURLToPath(
      new URL("../node_modules/@playwright/test/cli.js", import.meta.url),
    ),
    "test",
    "--config",
    "playwright.ui.config.ts",
    ...process.argv.slice(2),
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ACCP_UI_MANAGED_SERVER: "1" },
    windowsHide: true,
  },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => child.kill(signal));
try {
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} finally {
  await server.close();
}
