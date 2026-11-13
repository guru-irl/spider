import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { main } from "../supervisor-main";
import { runLocalDoctor } from "../local-diagnostics";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it("keeps production hosting fenced when the intent source is missing", async () => {
  let out = "", err = "";
  expect(await main([], { out: text => { out += text; }, err: text => { err += text; } })).toBe(1);
  expect(err).toContain("running-intent-source-unavailable");
  expect(out).toBe("");
}, 5000);

it("doctor names the missing authoritative source on a box", async () => {
  const base = resolve(".spider/scratch/roam-supervisor-doctor");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(base, "case-")); roots.push(root);
  await mkdir(join(root, "roam"), { mode: 0o700 });
  await writeFile(join(root, "roam", "config.json"), JSON.stringify({ enabled: true, role: "box",
    machineId: "10e674f6-9567-4109-a66c-a6870586c3e1", hubMachineId: "cc675f62-57b4-4c33-9a9d-cd2d3e711fa3",
    peers: [], discoveryRoots: [], coreUnit: "fixture" }), { mode: 0o600 });
  const report = await runLocalDoctor({ root });
  expect(report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "block", reason: expect.stringContaining("running-intent-source-unavailable") })]));
}, 5000);
