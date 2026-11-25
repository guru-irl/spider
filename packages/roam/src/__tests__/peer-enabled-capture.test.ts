import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { handleAgentOperation } from "../agent";
import { installBoxEnrollment, setBoxRoamingEnabled } from "../enrollment";
import { openJournal } from "../journal";
import { setEnrolledPeerEnabled } from "../peer-enabled";
import { parseConfig } from "../config";
import { readLocalIdentity } from "../runtime";
import { participantCaptureInitialized } from "../session-control";
import type { Operation, Peer } from "../contracts";
import type { ProvisionTransport } from "../transport";

const HUB = "00000000-0000-4000-8000-000000000001", BOX = "00000000-0000-4000-8000-000000000002";
const closes: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) close(); });

function fixture() {
  const box = createReplica("global", BOX); closes.push(() => box.close());
  box.db.prepare("INSERT INTO global_memory(uuid,category,content,created_at) VALUES('memory-a','insight','before enable',1)").run();
  const roam = join(box.root, "roam"); mkdirSync(roam, { mode: 0o700 });
  writeFileSync(join(roam, "machine.json"), JSON.stringify({ machineId: BOX }), { mode: 0o600 });
  installBoxEnrollment(box.root, BOX, HUB, "fixture.service");
  const journal = openJournal(join(roam, "hub-operations.db")), participantJournal = openJournal(join(roam, "journal.db"));
  const peer: Peer = { machineId: BOX, alias: "box-1.invalid", node: process.execPath, pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/core", globalRoot: box.root };
  const config = parseConfig({ role: "hub", enabled: true, machineId: HUB, hubMachineId: HUB, peers: [peer], discoveryRoots: [], coreUnit: "fixture.service" });
  const requests: Operation[] = [];
  let failCapture = false, flags = 0;
  const captureAtFlag: boolean[] = [];
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected provisioning call"); };
  const transport: ProvisionTransport = {
    pinIntercomPeer: unexpected, probeHome: unexpected, probeAgentDirectory: unexpected,
    previewSettings: unexpected, claimIdentity: unexpected, launchRelease: unexpected,
    transport: {
    resolve: async value => value, bootstrapProbe: async () => { throw new Error("Unexpected probe"); },
    async exec(_peer, argv) {
      const operation = JSON.parse(argv[2]) as Operation; requests.push(operation);
      if (failCapture) return Buffer.from(JSON.stringify({ code: 1, reason: "store-not-roamable", operationId: operation.id, epoch: null, value: null }));
      return Buffer.from(JSON.stringify(await handleAgentOperation(operation, { config: readLocalIdentity(box.root), root: box.root,
        journal: participantJournal, openStore(key) {
          if (key !== "global") throw new Error("Unexpected store");
          return { db: box.db, effects: {} as never, policy: {} as never };
        } })));
    },
    run: async () => { throw new Error("Unexpected run"); }, read: async () => { throw new Error("Unexpected read"); }, write: async () => { throw new Error("Unexpected write"); },
  },
    async executeProvision(_peer, request) {
      captureAtFlag.push(participantCaptureInitialized(box.db, BOX, "global"));
      setBoxRoamingEnabled(box.root, BOX, HUB, request.enabled as boolean); flags++;
      return { enabled: request.enabled };
    },
  };
  return { box, peer, config, journal, transport, requests, captureAtFlag, flags: () => flags, failCapture() { failCapture = true; } };
}

it("explicit participant enable initializes global capture before publishing participation", async () => {
  const f = fixture();
  expect(participantCaptureInitialized(f.box.db, BOX, "global")).toBe(false);
  await setEnrolledPeerEnabled({ ...f, enabled: true });
  expect(readLocalIdentity(f.box.root).enabled).toBe(true);
  expect(f.captureAtFlag).toEqual([true]);
  expect(participantCaptureInitialized(f.box.db, BOX, "global")).toBe(true);
  expect(f.requests).toEqual([expect.objectContaining({ kind: "enable-capture", machineId: BOX, args: { storeKey: "global" } })]);
  expect(f.box.db.prepare("SELECT entity,row_key FROM roam_changes").all()).toEqual([{ entity: "global_memory", row_key: "memory-a" }]);
  f.box.db.prepare("UPDATE global_memory SET content='after enable' WHERE uuid='memory-a'").run();
  expect(f.box.db.prepare("SELECT count(*) AS n FROM roam_changes WHERE entity='global_memory'").get()).toEqual({ n: 2 });
});

it("explicit participant re-enable restores global capture after a release reset without duplicate seed rows", async () => {
  const f = fixture();
  await setEnrolledPeerEnabled({ ...f, enabled: true });
  const count = { n: 1 };
  expect(f.box.db.prepare("SELECT count(*) AS n FROM roam_changes").get()).toEqual(count);
  await setEnrolledPeerEnabled({ ...f, enabled: false });
  f.box.db.prepare("UPDATE roam_meta SET capture_enabled=0 WHERE id=1").run();
  await setEnrolledPeerEnabled({ ...f, enabled: true });
  expect(participantCaptureInitialized(f.box.db, BOX, "global")).toBe(true);
  expect(f.box.db.prepare("SELECT count(*) AS n FROM roam_changes").get()).toEqual(count);
});

it("explicit participant enable refuses a failed capture initialization before changing participation", async () => {
  const f = fixture(); f.failCapture();
  await expect(setEnrolledPeerEnabled({ ...f, enabled: true })).rejects.toThrow("peer-capture-unconfirmed");
  expect(readLocalIdentity(f.box.root).enabled).toBe(false);
  expect(f.flags()).toBe(0);
});
