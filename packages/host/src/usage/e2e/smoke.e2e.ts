import { test, expect } from "@playwright/test";
import { installFixtureRoutes, expectNoBrowserErrors } from "./fixtures.js";
import { statusFixture, envelope } from "../__tests__/fixtures/redesign-contract.js";
test("shell smoke refreshes fixture status", async ({ page }) => {
  const errors = expectNoBrowserErrors(page), fixtures = await installFixtureRoutes(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Overview", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "Calibration & data", exact: true })).toBeVisible();
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
  expect(errors()).toEqual([]); expect(fixtures.unexpected).toEqual([]);
});

test("fixture stale scenario and unexpected API paths are explicit", async ({ page }) => {
  const fixtures = await installFixtureRoutes(page, "stale"); await page.goto("/");
  await expect(page.locator(".freshness")).toHaveAttribute("data-state", "stale");
  const response = await page.evaluate(async () => (await fetch("/api/session/bad/id")).status);
  expect(response).toBe(500); expect(fixtures.unexpected).toEqual(["/api/session/bad/id"]);
});
