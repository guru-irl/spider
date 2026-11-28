import { expect, it, vi } from "vitest";
import * as identities from "@spider/herdr/jobs/handoff";
import { localProcessTree } from "../relocate/local-process";

const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("node:child_process", async (original) => {
  const childProcess = await original<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execFile = Object.assign(childProcess.execFile.bind(null), { [promisify.custom]: list });
  return { ...childProcess, execFile };
});

it("retains sightings but cannot verify descendants under a PID reused outside the stop tree", async () => {
  const owner = 83001, replaced = 83002, grandchild = 83003, verified = 83004, uid = process.getuid!();
  const row = (pid: number, parent: number) => `${pid} ${parent} ${pid} ${uid} S fixture`;
  const snapshot = (parent: number) => ({ stdout: [row(owner, 1), row(replaced, parent), row(grandchild, replaced), row(verified, owner)].join("\n") });
  list.mockResolvedValueOnce(snapshot(owner)).mockResolvedValueOnce(snapshot(83005));
  const probe = vi.spyOn(identities, "processStartIdentity").mockImplementation(pid => `birth-${pid}`);
  try {
    const { descendants } = await localProcessTree(owner, { verifyAncestry: true });
    expect(descendants).toEqual([
      { pid: grandchild, startIdentity: `birth-${grandchild}`, command: "fixture", ancestryVerified: false },
      { pid: verified, startIdentity: `birth-${verified}`, command: "fixture" },
      { pid: replaced, startIdentity: `birth-${replaced}`, command: "fixture", ancestryVerified: false },
    ]);
  } finally { probe.mockRestore(); }
});
