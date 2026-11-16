import type { IntercomIntakeFence } from "@spider/intercom/protocol";
import type { FreezePorts } from "../freeze.js";

/** Storage and producer tests do not own a broker. This double enforces the port's generation contract. */
export function fixtureIntercom(sessionId: string): NonNullable<FreezePorts["intercom"]> {
  let current: IntercomIntakeFence | undefined, open = false;
  const check = async (fence: IntercomIntakeFence) => {
    if (open || !current || JSON.stringify(current) !== JSON.stringify(fence)) throw new Error("Intercom generation changed");
  };
  return { address: { sessionId, scopeId: null }, ports: {
    async close(address, moveId, expectedEpoch, generation) {
      const fence = { address, moveId, expectedEpoch, generation: generation ?? "fixture-generation" };
      if (current && !open && JSON.stringify(current) !== JSON.stringify(fence)) throw new Error("Intercom generation changed");
      current = fence; open = false; return fence;
    }, drain: check, checkGeneration: check,
    async inspect(fence) { await check(fence); return { blockers: [], cancelledWork: [], warnings: [] }; },
    async abort(fence) { await check(fence); open = true; },
    async ready() { throw new Error("This fixture has no destination"); },
  } };
}
