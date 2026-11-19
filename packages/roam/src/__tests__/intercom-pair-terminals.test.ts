import { expect, it } from "vitest";
import { inspectPairTerminals } from "../intercom-pair-resources";

type Run = Parameters<typeof inspectPairTerminals>[1];
const reply = (value: unknown): Run => async argv => {
  expect(argv).toEqual(["core-b", "ls", "--all", "--json"]);
  return { code: 0, stdout: JSON.stringify(value) } as Awaited<ReturnType<Run>>;
};

it("reads a terminal list that has no machines field, as older cores print it", async () => {
  expect(await inspectPairTerminals("core-b", reply({ terminals: [], hidden_finished: 0 }))).toBe("empty");
  expect(await inspectPairTerminals("core-b", reply({ terminals: [{ address: "t3", state: "live" }], hidden_finished: 0 }))).toBe("occupied");
  expect(await inspectPairTerminals("core-b", reply({ terminals: [{ address: "box-1.invalid/t1", state: "live" }], hidden_finished: 0 }))).toBe("empty");
});

it.each([
  ["live", { address: "t1", agent: "", cwd: "/home/fixture", state: "live", turn: 0 }, "occupied"],
  ["base-36 live", { address: "ta", agent: "", cwd: "/home/fixture", state: "live", turn: 0 }, "occupied"],
  ["base-36 finished", { address: "ta", agent: "", cwd: "/home/fixture", state: "finished", turn: 0, exit_code: 0, reason: "exited" }, "empty"],
  ["finished", { address: "t1", agent: "", cwd: "/home/fixture", state: "finished", turn: 0, exit_code: 0, reason: "exited" }, "empty"],
  ["nonzero exit", { address: "t1", agent: "", cwd: "/home/fixture", state: "finished", turn: 0, exit_code: 7, reason: "exited" }, "empty"],
  ["killed with signal", { address: "t1", agent: "", cwd: "/home/fixture", state: "finished", turn: 0, signal: 9, reason: "killed" }, "empty"],
  ["holder lost", { address: "t1", agent: "", cwd: "/home/fixture", state: "finished", turn: 0, reason: "holder_lost" }, "empty"],
  ["null exit metadata", { address: "t1", state: "finished", exit_code: null, signal: null, reason: "killed" }, "empty"],
  ["unknown", { address: "t1", agent: "", cwd: "/home/fixture", state: "starting", turn: 0 }, "unknown"],
  ["omitted exit_code", { address: "t1", state: "finished", reason: "holder_lost" }, "empty"],
  ["missing reason", { address: "t1", state: "finished", exit_code: 0 }, "unknown"],
  ["empty reason", { address: "t1", state: "finished", exit_code: 0, reason: "" }, "unknown"],
  ["invalid exit", { address: "t1", state: "finished", exit_code: "0", reason: "exited" }, "unknown"],
  ["invalid signal", { address: "t1", state: "finished", exit_code: 0, signal: "9", reason: "killed" }, "unknown"],
  ["fractional signal", { address: "t1", state: "finished", exit_code: 0, signal: 9.5, reason: "killed" }, "unknown"],
  ["uppercase terminal", { address: "tA", state: "live" }, "unknown"],
] as const)("classifies %s rows without requiring labels", async (_name, terminal, expected) => {
  expect(await inspectPairTerminals("core-b", reply({ terminals: [terminal], hidden_finished: 0 }))).toBe(expected);
});

it("live rows still block when retained finished rows are also present", async () => {
  expect(await inspectPairTerminals("core-b", reply({ terminals: [
    { address: "t1", state: "finished", exit_code: 0, reason: "exited" }, { address: "t2", state: "live" },
  ], hidden_finished: 0 }))).toBe("occupied");
});

it.each([
  { address: "box-1.invalid/t1", state: "finished", reason: "killed", signal: 9 },
  { address: "box-1.invalid/t1", state: "finished", exit_code: "invalid", reason: 7 },
  { address: "box-1.invalid/t1" },
])("ignores state on unrelated routed rows %#", async terminal => {
  expect(await inspectPairTerminals("core-b", reply({ terminals: [terminal], hidden_finished: 0 }))).toBe("empty");
});

it("still refuses malformed or incomplete terminal lists", async () => {
  expect(await inspectPairTerminals("core-b", reply({ terminals: [], machines: {}, hidden_finished: 0 }))).toBe("unknown");
  expect(await inspectPairTerminals("core-b", reply({ terminals: [], machines: [], hidden_finished: 1 }))).toBe("unknown");
  expect(await inspectPairTerminals("core-b", reply({ machines: [], hidden_finished: 0 }))).toBe("unknown");
  expect(await inspectPairTerminals("core-b", reply({ terminals: [{ address: "t1" }, { address: "t1" }], hidden_finished: 0 }))).toBe("unknown");
  expect(await inspectPairTerminals("core-b", reply({ terminals: [{ address: "BOX-1.invalid/t1" }, { address: "box-1.invalid/t1" }], hidden_finished: 0 }))).toBe("unknown");
  expect(await inspectPairTerminals("core-b", reply({ terminals: [{ address: "box-1.invalid/not-a-terminal" }], hidden_finished: 0 }))).toBe("unknown");
  expect(await inspectPairTerminals("core-b", reply({ terminals: [], machines: [], hidden_finished: 0 }))).toBe("empty");
});
