import { test, expect, chromium } from "@playwright/test";
import { readdir, realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolve, join } from "node:path";
const profiles = async (dir: string) => (await readdir(dir).catch(() => [])).filter(n => n.startsWith("playwright_chromiumdev_profile-"));
test("profiles stay in scratch", async ({}, testInfo) => {
  const scratch = await realpath(resolve(".spider/scratch/playwright/tmp")), actual = await realpath(tmpdir()); expect(actual).toBe(scratch);
  const home = process.env.HOME, before = await profiles(actual), homeBefore = await profiles(homedir());
  // Read-only observation of Node's default system temp, never scratch.
  expect(process.env.SPIDER_PLAYWRIGHT_ORIGINAL_TMPDIR).toEqual(expect.any(String));
  const systemTemps = [...new Set(["/tmp", process.env.SPIDER_PLAYWRIGHT_ORIGINAL_TMPDIR!])];
  const systemBefore = await Promise.all(systemTemps.map(profiles));
  const browser = await chromium.launch({ channel: testInfo.project.use.channel, headless: true, ...testInfo.project.use.launchOptions });
  let created: string[] = [];
  try {
    const context = await browser.newContext(); try { await context.newPage(); created = (await profiles(actual)).filter(n => !before.includes(n)); expect(created.length).toBeGreaterThan(0); for (const p of created) expect(await realpath(join(actual, p))).toContain(scratch + "/"); expect(process.env.HOME).toBe(home); } finally { await context.close(); }
  } finally { await browser.close(); }
  expect((await profiles(actual)).filter(n => !before.includes(n))).toEqual([]); expect(await profiles(homedir())).toEqual(homeBefore); expect(await Promise.all(systemTemps.map(profiles))).toEqual(systemBefore); expect(process.env.HOME).toBe(home);
  const proof = JSON.stringify({ channel: testInfo.project.use.channel, tmpdir: actual, liveProfiles: created.map(p => join(actual, p)), cleaned: true, homeUnchanged: true, observedDefaultTemps: systemTemps });
  await writeFile(resolve(".spider/scratch/playwright/profile-proof.json"), proof);
  await testInfo.attach("profile-location", { body: Buffer.from(proof), contentType: "application/json" });
});
