import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { main } from "../cli";
import { provisionIntercomEnrollment } from "../intercom-enrollment";
import { createIntercomRegistry } from "../intercom-registry";
import { scenario, cleanupPairScenarios } from "./intercom-pair-fixture";
const A = "00000000-0000-4000-8000-000000000002";
afterEach(cleanupPairScenarios);
it("a scoped recipe alone cannot authorize key setup without a live recorded pair unit", async () => {
  const f = await scenario(), plan = f.request.pairs[0], blob = f.publicKey.split(" ")[1];
  const pair = { ...plan, sshUser: "fixture", hostKey: { type: "ssh-ed25519", base64: blob }, hostKeyAlias: `spider-${"a".repeat(32)}` };
  const approval = { approved: true, actor: "fixture", at: 1000, operationId: "enroll-1", graphDigest: createHash("sha256").update(JSON.stringify([plan])).digest("hex"), pairs: [plan] };
  let out = "";
  expect(await main(["--global-root", f.source.globalRoot, "roam", "intercom", "setup-local"], { out: text => { out += text; }, err: () => {} },
    { stdin: Buffer.from(JSON.stringify({ action: "ensure-key", pair, approval })), pairPorts: f.locals.get(A)! })).toBe(0);
  expect(JSON.parse(out)).toMatchObject({ ok: false, reason: "connector-not-pair-scoped" });
  expect(f.calls.some(call => call.includes("ed25519"))).toBe(false);
}, 5000);

it("refuses an unapproved private setup before observing an existing unit", async () => {
  const f = await scenario(); expect((await provisionIntercomEnrollment(f.request, f.enrollment)).code).toBe(0);
  const record = (await createIntercomRegistry(f.source.globalRoot).get("pair-1"))!, before = f.calls.length;
  let out = "";
  await main(["--global-root", f.source.globalRoot, "roam", "intercom", "setup-local"], { out: text => { out += text; }, err: () => {} },
    { stdin: Buffer.from(JSON.stringify({ action: "ensure-key", pair: record.pair, approval: { approved: false } })), pairPorts: f.locals.get(A)! });
  expect(JSON.parse(out)).toMatchObject({ ok: false, reason: "peer-consent-required" });
  expect(f.calls).toHaveLength(before);
}, 5000);
