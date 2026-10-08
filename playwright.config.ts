import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";
const rawPort = process.env.SPIDER_PLAYWRIGHT_PORT ?? "4177";
if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) throw new Error("Invalid Playwright port");
const port = String(Number(rawPort));
const origin = `http://127.0.0.1:${port}`;
const config: PlaywrightTestConfig = defineConfig({
  testDir: "packages/host/src/usage/e2e", testMatch: "**/*.e2e.ts", workers: 1, timeout: 60000, expect: { timeout: 15000 },
  outputDir: process.env.CI ? "playwright-results" : ".spider/scratch/playwright/results",
  reporter: [["list"], ["html", { outputFolder: process.env.CI ? "playwright-report" : ".spider/scratch/playwright/report", open: "never" }]],
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  use: { headless: true, channel: process.env.SPIDER_PLAYWRIGHT_CHANNEL || (process.env.CI ? "chrome" : "msedge"), baseURL: origin,
    trace: "retain-on-failure", screenshot: "only-on-failure",
    launchOptions: { args: ["--use-mock-keychain", "--password-store=basic", "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-features=MediaRouter"] },
  },
  webServer: { command: "node scripts/usage-dashboard-e2e-server.mjs", url: `${origin}/ready`, timeout: 180000, reuseExistingServer: false, gracefulShutdown: { signal: "SIGTERM", timeout: 5000 }, env: { SPIDER_PLAYWRIGHT_PORT: port } },
});

export default config;
