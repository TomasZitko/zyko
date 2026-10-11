import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4000",
    trace: "retain-on-failure",
    launchOptions: { args: ["--no-proxy-server", "--host-resolver-rules=MAP *.sites.localhost 127.0.0.1"] },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: { command: "./e2e/server.sh", url: "http://localhost:4000/readyz", timeout: 120_000, reuseExistingServer: false },
});
