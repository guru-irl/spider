import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import * as selected from "../selected-files";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync), fchmodSync: vi.fn(actual.fchmodSync) };
});
const roots: string[] = [];
function fixture() {
  const scratch = join(process.cwd(), ".spider", "scratch"); fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(join(scratch, "private-modes-")); roots.push(root);
  const agent = join(root, "agent"); fs.mkdirSync(agent, { mode: 0o700 });
  return { root, agent };
}
// The filesystem is real; only an impossible-to-create foreign uid is injected.
const inspect = (selected as unknown as { inspectAgentPrivateModes: (root: string, repair?: boolean) => unknown }).inspectAgentPrivateModes;
afterEach(() => { vi.mocked(fs.lstatSync).mockReset(); vi.mocked(fs.fchmodSync).mockReset(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it("repairs sign-in files and a group-writable folder without changing their bytes", () => {
  const { agent } = fixture(), folder = join(agent, "sessions"); fs.mkdirSync(folder, { mode: 0o700 }); fs.chmodSync(folder, 0o775);
  for (const name of ["settings.json", "auth.json", "models.json"]) {
    fs.writeFileSync(join(agent, name), "{\"theme\":\"sample\"}\n", { mode: 0o600 }); fs.chmodSync(join(agent, name), 0o664);
  }
  const uid = process.getuid!();
  const expected = ["auth.json", "models.json", "sessions", "settings.json"].map(name => ({
    path: join(agent, name), uid, before: name === "sessions" ? 0o775 : 0o664, after: name === "sessions" ? 0o700 : 0o600,
  }));
  expect(inspect(agent)).toEqual(expected);
  expect(fs.lstatSync(folder).mode & 0o7777).toBe(0o775); // Preview is read-only.
  expect(inspect(agent, true)).toEqual(expected);
  expect(fs.lstatSync(folder).mode & 0o7777).toBe(0o700);
  for (const name of ["settings.json", "auth.json", "models.json"]) {
    expect(fs.lstatSync(join(agent, name)).mode & 0o7777).toBe(0o600);
    expect(fs.readFileSync(join(agent, name), "utf8")).toBe("{\"theme\":\"sample\"}\n");
  }
  expect(inspect(agent, true)).toEqual([]);
});

it("refuses a foreign owner with the full path, mode, uid and repair", async () => {
  const { agent } = fixture(), file = join(agent, "settings.json"); fs.writeFileSync(file, "{}", { mode: 0o600 }); fs.chmodSync(file, 0o664);
  const original = (await vi.importActual<typeof fs>("node:fs")).lstatSync, uid = process.getuid!() + 1;
  vi.mocked(fs.lstatSync).mockImplementation(((path: fs.PathLike, options?: unknown) => {
    const stat = original(path, options as never);
    if (String(path) === file) Object.defineProperty(stat, "uid", { value: uid });
    return stat;
  }) as typeof fs.lstatSync);
  expect(() => inspect(agent, true)).toThrow(expect.objectContaining({ code: "unsafe-destination", details: expect.objectContaining({ path: file, mode: 0o664, uid, problem: "owner" }) }));
  expect(fs.lstatSync(file).mode & 0o7777).toBe(0o664);
});

it("refuses symlinks without changing their targets and names the link", () => {
  const { root, agent } = fixture(), outside = join(root, "outside"), link = join(agent, "settings.json");
  fs.writeFileSync(outside, "{}", { mode: 0o600 }); fs.chmodSync(outside, 0o664); fs.symlinkSync(outside, link);
  expect(() => inspect(agent, true)).toThrow(expect.objectContaining({ code: "unsafe-destination", details: expect.objectContaining({ path: link, uid: process.getuid!(), problem: "symlink" }) }));
  expect(fs.lstatSync(outside).mode & 0o7777).toBe(0o664);
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
});

it("reports failed tightening and leaves the mode unchanged", () => {
  const { agent } = fixture(), file = join(agent, "settings.json"); fs.writeFileSync(file, "{}", { mode: 0o600 }); fs.chmodSync(file, 0o664);
  vi.mocked(fs.fchmodSync).mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
  expect(() => inspect(agent, true)).toThrow(expect.objectContaining({ code: "unsafe-destination", details: expect.objectContaining({ path: file, mode: 0o664, uid: process.getuid!(), problem: "tightening-failed" }) }));
  expect(fs.lstatSync(file).mode & 0o7777).toBe(0o664);
});
