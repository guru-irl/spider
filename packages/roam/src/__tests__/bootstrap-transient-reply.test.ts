import { expect, it } from "vitest";
import { parseBootstrapInventory } from "../bootstrap-reply";
import { bootstrapPeer, inventoryEnvelope } from "./bootstrap-fixture";

it.each([true, false])("retains the validated transient classification %s", transient => {
  const envelope = inventoryEnvelope(); Object.assign(envelope.value.core, { transient });
  expect(parseBootstrapInventory(Buffer.from(JSON.stringify(envelope)), bootstrapPeer, 0, null).core).toMatchObject({ transient });
});

it("retains unknown classification when the recorded diagnostic unit is absent", () => {
  const envelope = inventoryEnvelope(); Object.assign(envelope.value.core, { unit: null, unitExists: false, unitOwned: false, transient: null });
  expect(parseBootstrapInventory(Buffer.from(JSON.stringify(envelope)), bootstrapPeer, 0, "stale.service").core).toMatchObject({ unit: null, transient: null });
});

it.each(["yes", null, 1])("rejects an invalid classification for a present unit: %j", transient => {
  const envelope = inventoryEnvelope(); Object.assign(envelope.value.core, { transient });
  expect(() => parseBootstrapInventory(Buffer.from(JSON.stringify(envelope)), bootstrapPeer, 0, null)).toThrowError(expect.objectContaining({ code: "invalid-bootstrap-reply" }));
});

it("rejects a transient claim without a unit", () => {
  const envelope = inventoryEnvelope(); Object.assign(envelope.value.core, { unit: null, unitExists: false, unitOwned: false, transient: true });
  expect(() => parseBootstrapInventory(Buffer.from(JSON.stringify(envelope)), bootstrapPeer, 0, null)).toThrowError(expect.objectContaining({ code: "invalid-bootstrap-reply" }));
});
