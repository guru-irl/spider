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

it("still refuses malformed or incomplete terminal lists", async () => {
  expect(await inspectPairTerminals("core-b", reply({ terminals: [], machines: {}, hidden_finished: 0 }))).toBe("unknown");
  expect(await inspectPairTerminals("core-b", reply({ terminals: [], machines: [], hidden_finished: 1 }))).toBe("unknown");
  expect(await inspectPairTerminals("core-b", reply({ machines: [], hidden_finished: 0 }))).toBe("unknown");
  expect(await inspectPairTerminals("core-b", reply({ terminals: [{ address: "t1" }, { address: "t1" }], hidden_finished: 0 }))).toBe("unknown");
  expect(await inspectPairTerminals("core-b", reply({ terminals: [], machines: [], hidden_finished: 0 }))).toBe("empty");
});
