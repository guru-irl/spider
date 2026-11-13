import { expect, it } from "vitest";
import { createHubProcessProbe } from "../production-hub";
it.each(["EPERM", "ESRCH"])("a private hub ticket cannot belong to a PID returning %s", async code => {
  const probe = createHubProcessProbe(async () => ({ kind: "unknown" as const }), () => { throw Object.assign(new Error("absent owner"), { code }); });
  expect(await probe(12345)).toEqual({ kind: "absent" });
}, 5000);
it("a live hub process is identified by its start time and real probe failures remain unknown", async () => {
  const live = createHubProcessProbe(async () => ({ kind: "live" as const, startIdentity: "posix:current" }), () => {});
  const unknown = createHubProcessProbe(async () => ({ kind: "absent" as const }), () => { throw Object.assign(new Error("probe failed"), { code: "EIO" }); });
  expect(await live(12345)).toEqual({ kind: "live", startIdentity: "posix:current" });
  expect(await unknown(12345)).toEqual({ kind: "unknown" });
}, 5000);
