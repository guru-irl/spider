import { expect, it, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const read = (file: string) => readFileSync(resolve(file), "utf8");
it("installed browser channel precedence and config import have no side effects", async () => {
  const before = { ...process.env }; const paths = [".spider/scratch/playwright/results", ".spider/scratch/playwright/report"].map(existsSync);
  try {
    for (const [override, ci, want] of [["chrome-beta", "true", "chrome-beta"], ["", "true", "chrome"], ["", "", "msedge"]] as const) {
      vi.resetModules(); vi.stubEnv("SPIDER_PLAYWRIGHT_CHANNEL", override); vi.stubEnv("CI", ci); const snapshot = { ...process.env };
      const config = (await import("../../../../../playwright.config.js")).default;
      expect(process.env).toEqual(snapshot); expect(config.use?.channel).toBe(want); expect(config.use?.headless).toBe(true);
      expect(config.use?.launchOptions?.args).toEqual(["--use-mock-keychain", "--password-store=basic", "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-features=MediaRouter"]);
      expect(config.workers).toBe(1); expect(config.timeout).toBe(60000); expect(config.expect?.timeout).toBe(15000);
      expect(config.testMatch).toBe("**/*.e2e.ts"); expect(config.testDir).toBe("packages/host/src/usage/e2e");
      expect(config.outputDir).toBe(ci ? "playwright-results" : ".spider/scratch/playwright/results");
      expect(config.webServer).toMatchObject({ timeout: 180000, reuseExistingServer: false });
      expect(config.use?.trace).toBe("retain-on-failure"); expect(config.use?.screenshot).toBe("only-on-failure");
    }
  } finally { vi.unstubAllEnvs(); vi.resetModules(); }
  expect(process.env).toEqual(before); expect([".spider/scratch/playwright/results", ".spider/scratch/playwright/report"].map(existsSync)).toEqual(paths);
});
it.each(["0", "-1", "65536", "abc", "4.5", "4177evil"])("rejects invalid owned port %s", async port => {
  vi.resetModules(); vi.stubEnv("SPIDER_PLAYWRIGHT_PORT", port);
  try { await expect(import("../../../../../playwright.config.js")).rejects.toThrow("Invalid Playwright port"); } finally { vi.unstubAllEnvs(); vi.resetModules(); }
});
it("shares a validated port between command env base URL and readiness URL", async () => {
  vi.resetModules(); vi.stubEnv("SPIDER_PLAYWRIGHT_PORT", "4277");
  try { const config = (await import("../../../../../playwright.config.js")).default; expect(config.use?.baseURL).toBe("http://127.0.0.1:4277"); expect(config.webServer).toMatchObject({ url: "http://127.0.0.1:4277/ready", env: { SPIDER_PLAYWRIGHT_PORT: "4277" } }); } finally { vi.unstubAllEnvs(); vi.resetModules(); }
});
it("Vitest stays disjoint, root config is typechecked and CI always runs Chrome", () => {
  expect(read("vitest.config.ts")).toContain('include: ["packages/**/src/**/*.test.ts"]'); expect(read("vitest.config.ts")).toContain('"packages/host/src/usage/e2e/**"'); expect(JSON.parse(read("tsconfig.json")).include).toContain("playwright.config.ts");
  const workflow = read(".github/workflows/ci.yml"); expect(workflow).toContain("command -v google-chrome"); expect(workflow).toContain("google-chrome --version"); expect(workflow).toContain("npx --no-install playwright test"); expect(workflow.indexOf("export TMPDIR=")).toBeLessThan(workflow.indexOf("npx --no-install playwright test")); expect(workflow).toContain("timeout-minutes: 35"); expect(workflow).toContain("timeout-minutes: 15"); expect(workflow).toContain("if: failure()"); expect(workflow).toContain("actions/upload-artifact@v4");
  const launcher = read("scripts/usage-dashboard-playwright.mjs"); expect(launcher.indexOf("TMPDIR")).toBeLessThan(launcher.indexOf("spawn(")); expect(launcher).toContain("playwright/cli.js");
  for (const source of [workflow, launcher, read("playwright.config.ts"), read("scripts/usage-dashboard-e2e-server.mjs")]) expect(source).not.toMatch(/playwright install|PLAYWRIGHT_BROWSERS_PATH|executablePath|CDPSession|Browser.getBrowserCommandLine/);
  expect(read(".gitignore")).toContain("playwright-results/"); expect(read(".gitignore")).toContain("playwright-report/");
});

it("e2e CSP exactly matches the production security policy", async () => {
  const { usageSecurityHeaders } = await import("../server-security.js");
  const csp = read("scripts/usage-dashboard-e2e-server.mjs").match(/const csp = "([^"]+)";/)![1]!;
  expect(csp).toBe(usageSecurityHeaders()["Content-Security-Policy"]);
});
