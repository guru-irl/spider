import { expect, it } from "vitest";
import { parseHubReadiness, parseReadiness } from "../roam/readiness";

const common = { sessionId: "s-1", epoch: 1, cwd: "/fixture", file: "/fixture/s.jsonl", core: "core-1", terminal: "t1" };
const local = { origin: "box-local" as const, machineId: "00000000-0000-4000-8000-000000000001", ...common };
const hub = { origin: "hub-operation" as const, opId: "start-1", ...common };
it.each([local, hub])("parses durable $origin readiness without inventing fields", ready => {
  expect(parseReadiness(JSON.parse(JSON.stringify(ready)))).toEqual(ready);
  expect(parseReadiness(ready)).not.toHaveProperty("operationId");
}, 5000);
it("box-local readiness cannot satisfy the receipt parser", () => {
  expect(() => parseHubReadiness(local)).toThrow("readiness-origin-mismatch");
  expect(parseHubReadiness(hub)).toEqual(hub);
  expect(parseReadiness(local)).not.toHaveProperty("opId");
}, 5000);
it.each([
  { ...local, opId: "invented" }, { ...local, operationId: "invented" },
  { origin: "hub-operation", ...common }, { ...hub, machineId: local.machineId },
  { origin: "box-local", ...common }, { origin: "unknown", ...common },
])("rejects contradictory readiness provenance %#", ready => {
  expect(() => parseReadiness(ready)).toThrow("readiness-origin-mismatch");
}, 5000);
it.each([null, [], { ...hub, cwd: "relative" }, { ...local, epoch: 0 }])("rejects invalid owner fields %#", ready => {
  expect(() => parseReadiness(ready)).toThrow("readiness-invalid");
}, 5000);
