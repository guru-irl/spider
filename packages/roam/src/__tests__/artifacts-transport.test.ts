import { expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClientFixture } from "../../../herdr/src/__tests__/testutil";
import { stageArtifact, transferArtifact } from "../artifacts";
import { DEFAULT_LIMITS } from "../contracts";
import { openJournal } from "../journal";
import { manifestDigest } from "../staging";
import { createTransport } from "../transport";

it("artifact push retains the real transport's authenticated peer handle", async () => {
  const fixture = await createClientFixture();
  try {
    const machineId = "00000000-0000-4000-8000-000000000002";
    const sourceMachine = "00000000-0000-4000-8000-000000000001";
    const peer = { machineId, alias: "box-1.invalid", node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/core", globalRoot: "/fixture/global" };
    const source = join(fixture.root, "source");
    writeFileSync(source, "portable bytes");
    const root = join(fixture.root, "staging");
    const manifest = await stageArtifact(source, "batch", DEFAULT_LIMITS, { root, artifactId: "batch-a" });
    const digest = manifestDigest(manifest);
    const file = join(peer.globalRoot, "roam", "staging", "incoming", sourceMachine, "artifacts", manifest.id, "complete", digest);
    await fixture.configure({ machines: [{ id: "remote-core", name: peer.alias }], roamFixture: {
      execReplyBase64: Buffer.from(JSON.stringify({ code: 0, reason: "complete", state: "done", file,
        artifactId: manifest.id, sha256: manifest.sha256, manifestDigest: digest })).toString("base64"),
    } });
    await fixture.writeRoamFile(peer.alias, join(peer.globalRoot, "roam", "machine.json"), Buffer.from(JSON.stringify({ machineId })));
    const transport = createTransport({ binary: fixture.hcBinary, env: { ...fixture.localEnv, HOME: fixture.root }, enrolled: [peer] });
    const result = await transferArtifact(peer, manifest, { root, limits: DEFAULT_LIMITS, transport,
      journal: openJournal(join(fixture.root, "journal.db")), operationId: "transfer-a" });
    expect(result).toMatchObject({ code: 0, operationId: "transfer-a", value: { file } });
    const payload = (await fixture.calls()).filter(call => call.argv[0] === "exec" && call.argv.includes("receive"));
    expect(payload).toHaveLength(1);
    expect(payload[0].argv).toContain(peer.alias);
  } finally { await fixture.close(); }
}, 5000);
