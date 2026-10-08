import { test, expect } from "@playwright/test";
import { installFixtureRoutes, expectNoBrowserErrors } from "./fixtures.js";
import { statusFixture, envelope } from "../__tests__/fixtures/redesign-contract.js";
test("shell smoke refreshes fixture status", async ({ page }) => {
  const errors = expectNoBrowserErrors(page), fixtures = await installFixtureRoutes(page);
  await page.goto("/#/");
  await expect(page.getByRole("button", { name: "Overview", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "Calibration & data", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Daily credits", exact: true })).toBeVisible();
  await expect(page.locator(".freshness")).toHaveAttribute("data-state", "fresh");
  const indicator = page.locator(".freshness-indicator"), beforeLabel = await indicator.getAttribute("aria-label"); expect(beforeLabel).toMatch(/^Last update \w{3} \d{1,2} [A-Z]{3} \d\d:\d\d$/);
  const before = fixtures.count("/api/status"); fixtures.replace("/api/status", { status: 200, body: envelope(statusFixture({ lastIngestAt: Date.now() - 600000 })) });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => fixtures.count("/api/status")).toBeGreaterThan(before);
  await expect(page.locator(".freshness")).toHaveAttribute("data-state", "stale");
  await expect(page.locator(".status-dot")).toHaveCSS("background-color", "rgb(155, 150, 144)");
  await expect(indicator).toHaveAttribute("aria-label", /^Last update \w{3} \d{1,2} [A-Z]{3} \d\d:\d\d\. Older than five minutes$/);
  expect(await indicator.getAttribute("aria-label")).not.toBe(beforeLabel);
  await page.getByRole("button", { name: "Calibration & data", exact: true }).click(); await expect(page).toHaveURL(/#\/calibration$/);
  await expect(page.getByRole("heading", { name: "Correction", exact: true })).toBeVisible();
  expect(errors()).toEqual([]); expect(fixtures.unexpected).toEqual([]);
});

test("fixture stale scenario and unexpected API paths are explicit", async ({ page }) => {
  const fixtures = await installFixtureRoutes(page, "stale"); await page.goto("/");
  await expect(page.locator(".freshness")).toHaveAttribute("data-state", "stale");
  const response = await page.evaluate(async () => (await fetch("/api/session/bad/id")).status);
  expect(response).toBe(500); expect(fixtures.unexpected).toEqual(["/api/session/bad/id"]);
});

test("production hash routes mount real pages and unknown routes use Overview", async ({ page }) => {
  const routes = await installFixtureRoutes(page);
  for (const [hash, selector] of [["#/", ".overview-page"], ["#/session/session-garden", ".session-header"], ["#/calibration", ".correction-stats"], ["#/unknown", ".overview-page"]]) {
    await page.goto(`/${hash}`); await expect(page.locator(selector!)).toBeVisible();
    await expect(page.locator("#usage-app main")).not.toContainText("This section is not included");
  }
  expect(routes.unexpected).toEqual([]);
});


test("production Back pops dashboard history without adding an entry", async ({ page }) => {
  await installFixtureRoutes(page); await page.goto("/#/"); await expect(page.locator(".overview-page")).toBeVisible();
  const hash = await page.evaluate(() => location.hash);
  await page.locator('[data-session="session-garden"]').click(); await expect(page.locator(".session-header")).toBeVisible();
  const length = await page.evaluate(() => history.length); await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator(".overview-page")).toBeVisible(); expect(await page.evaluate(() => location.hash)).toBe(hash); expect(await page.evaluate(() => history.length)).toBe(length);
});
