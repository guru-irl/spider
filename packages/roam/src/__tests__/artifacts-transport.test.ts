import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClientFixture } from "../../../herdr/src/__tests__/testutil";
import { pullArtifact, stageArtifact, transferArtifact } from "../artifacts";
import { DEFAULT_LIMITS } from "../contracts";
import { openJournal } from "../journal";
import { manifestDigest } from "../staging";
import { createTransport } from "../transport";

it("a plain Node child can load artifact operations", () => {
  const entry = new URL("../artifacts.ts", import.meta.url).href;
  const script = `import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (context.parentURL?.endsWith('.ts') && (specifier.startsWith('./') || specifier.startsWith('../')) && !/\\.[cm]?[jt]s$/.test(specifier)) return next(specifier + '.ts', context);
      return next(specifier, context);
    } });
    await import(${JSON.stringify(entry)});`;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    env: { ...process.env, NODE_NO_WARNINGS: "1" }, encoding: "utf8", timeout: 3000,
  });
  expect(child.status, child.stderr).toBe(0);
  expect(child.stderr).toBe("");
}, 5000);

it.each(["push", "pull"] as const)("artifact %s reports a failed peer process rather than pending", async direction => {
  const fixture = await createClientFixture();
  try {
    const machineId = "00000000-0000-4000-8000-000000000002";
    const peer = { machineId, alias: "box-1.invalid", node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/core", globalRoot: "/fixture/global" };
    const source = join(fixture.root, "source"), sourceRoot = join(fixture.root, "source-staging");
    writeFileSync(source, "portable bytes");
    const limits = { ...DEFAULT_LIMITS, retryDelaysMs: [] };
    const manifest = await stageArtifact(source, "batch", limits, { root: sourceRoot, artifactId: "batch-a" });
    await fixture.configure({ machines: [{ id: "remote-core", name: peer.alias }], roamFixture: {
      execReplyBase64: Buffer.from('{"code":0,"reason":"complete"}').toString("base64"), execExitCode: 1,
    } });
    await fixture.writeRoamFile(peer.alias, join(peer.globalRoot, "roam", "machine.json"), Buffer.from(JSON.stringify({ machineId })));
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    const ports = { root: direction === "push" ? sourceRoot : join(fixture.root, "incoming"), limits, transport,
      journal: openJournal(join(fixture.root, "journal.db")), operationId: "transfer-a" };
    const result = direction === "push" ? await transferArtifact(peer, manifest, ports) : await pullArtifact(peer, manifest, ports);
    expect(result).toMatchObject({ code: 1, reason: "Peer command failed (exit 1)" });
    expect(result.value).toBeNull();
  } finally { await fixture.close(); }
}, 5000);

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
