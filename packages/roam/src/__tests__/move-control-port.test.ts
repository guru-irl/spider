import { expect, it, vi } from "vitest";
import { guardMoveControl, parseMoveControlRequest } from "../move-control";

it("disabled move-control requests refuse before validation or dispatch", async () => {
  const effects: unknown[] = [], handler = guardMoveControl(() => false, async input => { effects.push(input); return { code: 0, reason: "complete", value: null }; });
  for (const input of [{ op: "move", session: "session-a", machine: "hub.invalid" }, { op: "recover", operationId: "move-a" }, { op: "unknown" }, null]) {
    expect(await handler(input)).toMatchObject({ code: 1, reason: "roaming-disabled" });
  }
  expect(effects).toEqual([]);
}, 5000);
it.each([null, {}, { op: "move" }, { op: "move", session: "session-a", machine: "hub.invalid", credentials: "secret" }, { op: "claim", session: "session-a" }, { op: "recover", operationId: "bad\nvalue" }, { op: "unknown" }])("malformed move control %j performs no effects", async input => {
  const effect = vi.fn();
  expect(await guardMoveControl(() => true, effect)(input)).toMatchObject({ code: 2, reason: "invalid-move-control" });
  expect(effect).not.toHaveBeenCalled();
}, 5000);
it.each([
  { op: "move", session: "session-a", machine: "hub.invalid" }, { op: "recover", operationId: "move-a" }, { op: "cancel", operationId: "move-a" },
  { op: "claim", session: "session-a", machine: "hub.invalid" }, { op: "stop", session: "session-a" }, { op: "resume", session: "session-a" },
  { op: "forget", machine: "box-1.invalid", confirmation: "destroyed 00000000-0000-4000-8000-000000000002" },
])("enabled move control %j reaches only its validated typed handler", async input => {
  const effect = vi.fn(async () => ({ code: 3 as const, reason: "destination-unknown", value: null }));
  expect(await guardMoveControl(() => true, effect)(input)).toMatchObject({ code: 3, reason: "destination-unknown" });
  expect(effect).toHaveBeenCalledOnce();
  expect(effect).toHaveBeenCalledWith(parseMoveControlRequest(input));
}, 5000);
it('cancel without a move handler names the hub startup repair', async () => {
  expect(await guardMoveControl(() => true)({ op: 'cancel', operationId: 'move-a' })).toMatchObject({ code: 1, reason: 'move-control-unavailable', repairCommand: 'spider roam enable' });
});

it("unavailable control evidence does not leak exception text", async () => {
  const value = await guardMoveControl(() => true, async () => { throw new Error("SECRET-SENTINEL"); })({ op: "recover", operationId: "move-a" });
  expect(value).toMatchObject({ code: 1, reason: "move-control-unavailable", repairCommand: 'spider roam enable' });
  expect(JSON.stringify(value)).not.toContain("SECRET-SENTINEL");
}, 5000);
