import { expect, it } from "vitest";
import { inspectPairTerminals } from "../intercom-pair-resources";

type Run = Parameters<typeof inspectPairTerminals>[1];
const reply = (value: unknown): Run => async argv => {
  expect(argv).toEqual(["core-b", "ls", "--all", "--json"]);
  return { code: 0, stdout: JSON.stringify(value) } as Awaited<ReturnType<Run>>;
};

it("reads a terminal list that has no machines field, as older cores print it", async () => {
  expect(await inspectPairTerminals("core-b", reply({ terminals: [], hidden_finished: 0 }))).toBe("empty");
  expect(await inspectPairTerminals("core-b", reply({ terminals: [{ address: "t3" }], hidden_finished: 0 }))).toBe("occupied");
  expect(await inspectPairTerminals("core-b", reply({ terminals: [{ address: "box-1.invalid/t1" }], hidden_finished: 0 }))).toBe("empty");
});

it.each([
  ["live", { address: "t1", agent: "", cwd: "/home/fixture", state: "live", turn: 0 }, "occupied"],
  ["finished", { address: "t1", agent: "", cwd: "/home/fixture", state: "finished", turn: 0, exit_code: 0, reason: "exit" }, "empty"],
  ["signalled", { address: "t1", agent: "", cwd: "/home/fixture", state: "finished", turn: 0, exit_code: null, reason: "signal" }, "empty"],
  ["unknown", { address: "t1", agent: "", cwd: "/home/fixture", state: "starting", turn: 0 }, "unknown"],
  ["missing exit", { address: "t1", state: "finished", reason: "exit" }, "unknown"],
  ["missing reason", { address: "t1", state: "finished", exit_code: 0 }, "unknown"],
  ["invalid exit", { address: "t1", state: "finished", exit_code: "0", reason: "exit" }, "unknown"],
] as const)("classifies %s rows without requiring labels", async (_name, terminal, expected) => {
  expect(await inspectPairTerminals("core-b", reply({ terminals: [terminal], hidden_finished: 0 }))).toBe(expected);
});

it("live rows still block when retained finished rows are also present", async () => {
  expect(await inspectPairTerminals("core-b", reply({ terminals: [
    { address: "t1", state: "finished", exit_code: 0, reason: "exit" }, { address: "t2", state: "live" },
  ], hidden_finished: 0 }))).toBe("occupied");
});

it("still refuses malformed or incomplete terminal lists", async () => {
  expect(await inspectPairTerminals("core-b", reply({ terminals: [], machines: {}, hidden_finished: 0 }))).toBe("unknown");
  expect(await inspectPairTerminals("core-b", reply({ terminals: [], machines: [], hidden_finished: 1 }))).toBe("unknown");
  expect(await inspectPairTerminals("core-b", reply({ machines: [], hidden_finished: 0 }))).toBe("unknown");
  expect(await inspectPairTerminals("core-b", reply({ terminals: [{ address: "t1" }, { address: "t1" }], hidden_finished: 0 }))).toBe("unknown");
  expect(await inspectPairTerminals("core-b", reply({ terminals: [], machines: [], hidden_finished: 0 }))).toBe("empty");
});
