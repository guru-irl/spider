import { createHash } from "node:crypto";
import { closeSync, constants, mkdtempSync, openSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { GitPorts, WorkspaceSnapshot } from "./contracts";
import { stageArtifact } from "./artifacts";
import { artifactId as validateArtifactId, privateDirectory } from "./staging";

export interface SnapshotHeads { index: string; working: string }

/** Snapshot refs are immutable and may never name ordinary user branches. */
export function snapshotPrivateRefs(snapshot: WorkspaceSnapshot): { index: string; working: string } {
  try { validateArtifactId(snapshot.moveId); } catch { throw new Error("workspace-snapshot-invalid"); }
  if (snapshot.stage !== "pre" && snapshot.stage !== "final" || !Array.isArray(snapshot.refs) || !snapshot.sparse ||
      typeof snapshot.sparse.enabled !== "boolean" || !(snapshot.sparse.cone === null || typeof snapshot.sparse.cone === "boolean")) {
    throw new Error("workspace-snapshot-invalid");
  }
  const prefix = `refs/spider-roam/${snapshot.moveId}/${snapshot.stage}`;
  const refs = { index: `${prefix}/index`, working: `${prefix}/working` };
  if (snapshot.refs.length !== 2 || new Set(snapshot.refs).size !== 2 ||
      !snapshot.refs.includes(refs.index) || !snapshot.refs.includes(refs.working)) throw new Error("workspace-snapshot-invalid");
  return refs;
}

/** Verify the advertised trees and the exact HEAD -> index -> working parent chain. */
export async function verifySnapshotObjects(snapshot: WorkspaceSnapshot, root: string, heads: SnapshotHeads, ports: GitPorts): Promise<void> {
  const oid = snapshot.objectFormat === "sha1" ? /^[a-f0-9]{40}$/ : snapshot.objectFormat === "sha256" ? /^[a-f0-9]{64}$/ : null;
  if (!oid || ![snapshot.head, snapshot.indexTree, snapshot.workingTree, heads.index, heads.working].every(value => oid.test(value))) {
    throw new Error("workspace-snapshot-invalid");
  }
  try {
    const run = async (...argv: string[]) => (await ports.run(root, ["git", ...argv])).toString("utf8").trim();
    const indexTree = await run("rev-parse", "--verify", `${heads.index}^{tree}`);
    const workingTree = await run("rev-parse", "--verify", `${heads.working}^{tree}`);
    const indexParents = (await run("rev-list", "--parents", "-n", "1", heads.index)).split(" ");
    const workingParents = (await run("rev-list", "--parents", "-n", "1", heads.working)).split(" ");
    if (indexTree !== snapshot.indexTree || workingTree !== snapshot.workingTree ||
        indexParents.length !== 2 || indexParents[0] !== heads.index || indexParents[1] !== snapshot.head ||
        workingParents.length !== 2 || workingParents[0] !== heads.working || workingParents[1] !== heads.index) {
      throw new Error("invalid");
    }
  } catch { throw new Error("workspace-snapshot-invalid"); }
}

async function readBundleHeads(file: string, root: string, ports: GitPorts): Promise<Map<string, string>> {
  let lines: string[];
  try { lines = (await ports.run(root, ["git", "bundle", "list-heads", file])).toString("utf8").trim().split("\n"); }
  catch { throw new Error("workspace-bundle-invalid"); }
  const heads = new Map<string, string>();
  for (const line of lines) {
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) (refs\/[^\s]+)$/.exec(line);
    if (!match || heads.has(match[2])) throw new Error("workspace-bundle-invalid");
    heads.set(match[2], match[1]);
  }
  return heads;
}

/** Read only the two immutable heads declared by the snapshot. */
export async function bundleHeads(snapshot: WorkspaceSnapshot, file: string, root: string, ports: GitPorts): Promise<SnapshotHeads> {
  const refs = snapshotPrivateRefs(snapshot), heads = await readBundleHeads(file, root, ports);
  if (heads.size !== 2 || !heads.has(refs.index) || !heads.has(refs.working)) throw new Error("workspace-bundle-invalid");
  return { index: heads.get(refs.index)!, working: heads.get(refs.working)! };
}

function writeAll(fd: number, bytes: Buffer): void {
  let position = 0;
  while (position < bytes.length) position += writeSync(fd, bytes, position, bytes.length - position);
}

/** Git omits heads excluded by a prerequisite even when the destination already has them. */
function appendKnownHeads(file: string, lines: readonly string[]): void {
  if (!lines.length) return;
  const input = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  const target = `${file}.heads`;
  let output: number | null = null;
  try {
    const header = Buffer.alloc(1024 * 1024);
    let used = 0, end = -1;
    while (end < 0 && used < header.length) {
      const count = readSync(input, header, used, Math.min(64 * 1024, header.length - used), used);
      if (!count) break;
      used += count;
      end = header.subarray(0, used).indexOf("\n\n");
    }
    if (end < 0 || !header.subarray(0, end).toString("utf8").startsWith("# v")) throw new Error("workspace-bundle-invalid");
    output = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    writeAll(output, header.subarray(0, end));
    writeAll(output, Buffer.from(`\n${lines.join("\n")}\n\n`));
    const chunk = Buffer.alloc(384 * 1024);
    let position = end + 2;
    for (;;) {
      const count = readSync(input, chunk, 0, chunk.length, position);
      if (!count) break;
      writeAll(output, chunk.subarray(0, count));
      position += count;
    }
    closeSync(output); output = null;
    renameSync(target, file);
  } finally {
    closeSync(input);
    if (output !== null) closeSync(output);
    rmSync(target, { force: true });
  }
}

/** Create and stage only an incremental bundle based on destination-verified commits. */
export async function bundleWorkspace(
  snapshot: WorkspaceSnapshot, verifiedPrerequisites: readonly string[], ports: GitPorts,
): Promise<WorkspaceSnapshot> {
  const refs = snapshotPrivateRefs(snapshot);
  const verified = [...new Set(verifiedPrerequisites)];
  if (!verified.length || snapshot.prerequisites.some(commit => !verified.includes(commit))) {
    throw new Error("workspace-prerequisite-missing: fetch the required commits on the destination");
  }
  const oid = snapshot.objectFormat === "sha1" ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/;
  if (!verified.every(commit => oid.test(commit))) throw new Error("workspace-prerequisite-invalid: fetch the required commits on the destination");
  let sharedBase = false;
  for (const commit of verified) {
    try { await ports.run(snapshot.root, ["git", "cat-file", "-e", `${commit}^{commit}`]); }
    catch { throw new Error("workspace-prerequisite-missing: fetch the required commits on both machines"); }
    try {
      await ports.run(snapshot.root, ["git", "merge-base", "--is-ancestor", commit, snapshot.head]);
      sharedBase = true;
    } catch { /* A verified pre-stage commit need not be an ancestor of HEAD. */ }
  }
  if (!sharedBase) throw new Error("workspace-prerequisite-missing: fetch a shared merge base on the destination");
  let heads: SnapshotHeads;
  try {
    const resolveRef = async (ref: string) => (await ports.run(snapshot.root, ["git", "rev-parse", "--verify", `${ref}^{commit}`])).toString("utf8").trim();
    heads = { index: await resolveRef(refs.index), working: await resolveRef(refs.working) };
  } catch { throw new Error("workspace-snapshot-invalid"); }
  await verifySnapshotObjects(snapshot, snapshot.root, heads, ports);
  const known = async (head: string): Promise<boolean> => {
    for (const prerequisite of verified) {
      if (head === prerequisite) return true;
      try {
        await ports.run(snapshot.root, ["git", "merge-base", "--is-ancestor", head, prerequisite]);
        return true;
      } catch { /* The next verified prerequisite may contain this head. */ }
    }
    return false;
  };
  const indexKnown = await known(heads.index), workingKnown = await known(heads.working);

  const artifactId = `workspace-${createHash("sha256").update(JSON.stringify([
    snapshot.moveId, snapshot.repoKey, snapshot.workspaceId, snapshot.stage,
  ])).digest("hex")}`;
  privateDirectory(ports.scratch);
  const directory = mkdtempSync(join(ports.scratch, ".workspace-bundle-"));
  const file = join(directory, "workspace.bundle");
  try {
    closeSync(openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
    if (indexKnown && workingKnown) {
      const pack = await ports.run(snapshot.root, ["git", "pack-objects", "--stdout"], { stdin: Buffer.alloc(0) });
      const version = snapshot.objectFormat === "sha256" ? "# v3 git bundle\n@object-format=sha256\n" : "# v2 git bundle\n";
      const header = `${version}${verified.map(commit => `-${commit} prerequisite\n`).join("")}` +
        `${heads.index} ${refs.index}\n${heads.working} ${refs.working}\n\n`;
      writeFileSync(file, Buffer.concat([Buffer.from(header), pack]), { mode: 0o600 });
    } else {
      try { await ports.run(snapshot.root, ["git", "bundle", "create", file, ...snapshot.refs, ...verified.map(commit => `^${commit}`)]); }
      catch { throw new Error("workspace-bundle-invalid: fetch the required commits and retry"); }
      const advertised = await readBundleHeads(file, snapshot.root, ports);
      const missing: string[] = [];
      for (const [ref, head, isKnown] of [[refs.index, heads.index, indexKnown], [refs.working, heads.working, workingKnown]] as const) {
        const actual = advertised.get(ref);
        if (actual === undefined) {
          if (!isKnown) throw new Error("workspace-bundle-invalid");
          missing.push(`${head} ${ref}`);
        } else if (actual !== head) throw new Error("workspace-snapshot-invalid");
        advertised.delete(ref);
      }
      if (advertised.size) throw new Error("workspace-bundle-invalid");
      appendKnownHeads(file, missing);
    }
    try { await ports.run(snapshot.root, ["git", "bundle", "verify", file]); }
    catch { throw new Error("workspace-bundle-invalid: fetch the required commits and retry"); }
    const actualHeads = await bundleHeads(snapshot, file, snapshot.root, ports);
    if (actualHeads.index !== heads.index || actualHeads.working !== heads.working) throw new Error("workspace-snapshot-invalid");
    const size = statSync(file).size;
    const prior = new Map<string, number>();
    for (const { action, result } of ports.journal.read(snapshot.moveId)) {
      if (action !== "workspace-bundle") continue;
      if (typeof result.artifactId !== "string" || typeof result.byteLength !== "number" ||
          !Number.isSafeInteger(result.byteLength) || result.byteLength < 0 ||
          prior.has(result.artifactId) && prior.get(result.artifactId) !== result.byteLength) {
        throw new Error("workspace-bundle-journal-invalid");
      }
      prior.set(result.artifactId, result.byteLength);
    }
    if (prior.has(artifactId) && prior.get(artifactId) !== size) throw new Error("workspace-bundle-conflict");
    const total = [...prior.entries()].reduce((sum, [id, length]) => sum + (id === artifactId ? 0 : length), size);
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(ports.limits.workspaceBytes) ||
        ports.limits.workspaceBytes <= 0 || total > ports.limits.workspaceBytes) {
      throw new Error("workspace-bundle-limit: fetch the missing commits or increase the configured limit");
    }
    const manifest = await stageArtifact(file, "workspace", ports.limits, { root: ports.scratch, artifactId });
    if (!prior.has(artifactId)) {
      ports.journal.record(snapshot.moveId, "workspace-bundle", { artifactId, byteLength: manifest.byteLength, stage: snapshot.stage });
    }
    return { ...snapshot, prerequisites: verified, bundle: { kind: "ready", artifactId, byteLength: manifest.byteLength } };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
