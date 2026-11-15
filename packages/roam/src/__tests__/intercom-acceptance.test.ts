import { expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
// @ts-ignore The executable runner is exercised through its public functions.
import { buildMatrix, complete, parseOptions, profileIds, storyWorkers } from "../../../../scripts/herdr-e2e.mjs";

it("selects every packaged intercom story serially and never counts missing results as passed", () => {
  const ids = ["R11", "R12", "R13"];
  expect(parseOptions(["--tier", "headless", "--story", ids.join(",")], {}).ids).toEqual(ids);
  for (const id of ids) {
    expect(profileIds.headless).toContain(id);
    expect(profileIds.ci).not.toContain(id);
    expect(storyWorkers({ tier: "headless", ids: [id] })).toBe(1);
    expect(buildMatrix("ci", profileIds.ci, []).find((row: { id: string }) => row.id === id).result).toBe("not exercised");
  }
  expect(storyWorkers({ tier: "headless", ids })).toBe(1);
  const missing = buildMatrix("headless", ids, []);
  expect(missing.filter((row: { id: string }) => ids.includes(row.id)).map((row: { result: string }) => row.result)).toEqual(["failed", "failed", "failed"]);
  expect(complete(missing, ids)).toBe(false);
}, 5000);

it("exposes the packaged supervisor lifecycle for injected platform ports", async () => {
  const entry = pathToFileURL(resolve("dist/roam/supervisor.mjs")).href;
  const packaged = await import(/* @vite-ignore */ entry);
  expect(packaged.startProductionSupervisor).toBeTypeOf("function");
}, 5000);

it("exposes the packaged hub lifecycle for a fixture-owned clock", async () => {
  const entry = pathToFileURL(resolve("dist/roam/cli-main.mjs")).href;
  const packaged = await import(/* @vite-ignore */ entry);
  expect(packaged.startProductionHub).toBeTypeOf("function");
}, 5000);
