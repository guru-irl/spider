import { afterEach, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, lstatSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { RELEASE_ENTRIES } from "../release-request";
import { createReplica } from "@spider/db-core/testutil";
import { main } from "../cli";
import * as transportModule from "../transport";
import * as hubModule from "../production-hub";
import * as provisionModule from "../provision";
import { DEFAULT_LIMITS } from "../contracts";
import { openJournal } from "../journal";
import { confirmProvision, pinProvisionRelease, stageProvisionRelease } from "../provision-cli";
import { healthyInventory } from "./bootstrap-fixture";
const HUB = "00000000-0000-4000-8000-000000000001";
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function fixture() {
  const f = createReplica("global", HUB); fixtures.push(f);
  const journal = openJournal(join(f.root, "roam", "journal.db")), release = join(f.root, "release.tgz"); writeFileSync(release, "release-one", { mode: 0o600 });
  const request = { operationId: "provision-1", target: "box-1.invalid", machineId: "00000000-0000-4000-8000-000000000002", hubMachineId: HUB,
    files: [{ path: "auth.json", size: 12, mode: 0o600 }], releaseHash: "a".repeat(64) };
  return { ...f, journal, release, request };
}
it.each([
  [true, "y", false, null, true], [true, "n", false, null, false],
  [false, "", false, null, false], [false, "", true, null, false], [false, "", true, "copilot-auth", true],
] as const)("consent tty=%s answer=%s yes=%s named=%s", async (tty, answer, yes, consent, expected) => {
  const f = fixture(); let prompts = 0;
  const approved = await confirmProvision(f.journal, f.request, { tty, yes, consent, actor: "fixture-user", now: () => 123,
    async ask(text) { prompts++; expect(text).toContain("box-1.invalid"); expect(text).toContain("copilot-auth"); return answer; } });
  expect(approved).toBe(expected); expect(prompts).toBe(tty ? 1 : 0);
  const rows = f.journal.read("provision-1").filter(row => row.action === "human-consent");
  expect(rows).toHaveLength(expected ? 1 : 0);
  if (expected) expect(rows[0].result).toMatchObject({ actor: "fixture-user", at: 123, operationId: "provision-1", releaseHash: "a".repeat(64), files: f.request.files });
}, 5000);
it("requires consent for every provider in selected credential files", async () => {
  const f = fixture(), request = { ...f.request, providers: ["github-copilot", "demo"] };
  const base = { tty: false, yes: true, consent: "copilot-auth", actor: "fixture-user", now: () => 123, ask: async () => "" };
  expect(await confirmProvision(f.journal, request, base)).toBe(false);
  expect(f.journal.read(request.operationId).filter(row => row.action === "human-consent")).toEqual([]);
  expect(await confirmProvision(f.journal, request, { ...base, consentedProviders: ["demo"] })).toBe(true);
  expect(f.journal.read(request.operationId).find(row => row.action === "human-consent")?.result.providers).toEqual(["demo", "github-copilot"]);
  await expect(confirmProvision(f.journal, { ...request, providers: ["github-copilot", "other"] }, base)).rejects.toThrow("different arguments");
}, 5000);

it("does not reuse human consent for a different box settings snapshot", async () => {
  const f = fixture(), request = { ...f.request, settingsFingerprint: "a".repeat(64), settingsKeys: ["theme"] };
  const ports = { tty: false, yes: true, consent: "copilot-auth", actor: "fixture-user", now: () => 123, ask: async () => "" };
  expect(await confirmProvision(f.journal, request, ports)).toBe(true);
  expect(await confirmProvision(f.journal, request, ports)).toBe(true);
  await expect(confirmProvision(f.journal, { ...request, settingsFingerprint: "b".repeat(64) }, ports)).rejects.toThrow("settings-preview-changed");
  expect(f.journal.read(request.operationId).filter(row => row.action === "human-consent")).toHaveLength(1);
  expect(f.journal.read(request.operationId).find(row => row.action === "human-consent")?.result)
    .toMatchObject({ settingsFingerprint: "a".repeat(64), settingsKeys: ["theme"] });
}, 5000);

it("names the target and all credential providers in interactive consent", async () => {
  const f = fixture(), request = { ...f.request, providers: ["github-copilot", "demo"] }; let prompt = "";
  expect(await confirmProvision(f.journal, request, { tty: true, yes: false, consent: null, actor: "fixture-user", now: () => 123,
    async ask(text) { prompt = text; return "y"; } })).toBe(true);
  expect(prompt).toContain("box-1.invalid"); expect(prompt).toContain("copilot-auth"); expect(prompt).toContain("demo");
}, 5000);

it("stages a regular release override privately with a stable retry path", async () => {
  const f = fixture();
  chmodSync(f.release, 0o644);
  const first = await stageProvisionRelease({ root: f.root, operationId: "stable-op", release: f.release, maximum: 1024 });
  expect(lstatSync(first.file).mode & 0o777).toBe(0o600);
  expect(lstatSync(f.release).mode & 0o777).toBe(0o644);
  expect(readFileSync(first.file, "utf8")).toBe("release-one");
  expect(await stageProvisionRelease({ root: f.root, operationId: "stable-op", release: f.release, maximum: 1024 })).toEqual(first);
  writeFileSync(f.release, "different");
  await expect(stageProvisionRelease({ root: f.root, operationId: "stable-op", release: f.release, maximum: 1024 })).rejects.toThrow("release-arguments-changed");
}, 5000);

it("packages the running installed release offline without lifecycle scripts and reuses its snapshot", async () => {
  const f = fixture(), installed = join(f.root, "installed"); mkdirSync(installed, { mode: 0o700 });
  writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "@guru-irl/spider", version: "0.0.0", files: ["dist", "scripts"],
    scripts: { prepare: "node -e \"require('node:fs').writeFileSync('prepared','bad')\"" } }));
  for (const entry of RELEASE_ENTRIES) {
    mkdirSync(dirname(join(installed, entry)), { recursive: true });
    writeFileSync(join(installed, entry), "// SPIDER_BUILD_ID=unknown@2026-11-13T00:00:00.000Z v0.0.0\n");
  }
  const input = { root: f.root, operationId: "installed-release", maximum: 4 * 1024 * 1024, bundleUrl: new URL(`file://${installed}/dist/roam/cli.mjs`) };
  const staged = await stageProvisionRelease(input), inode = statSync(staged.file).ino;
  const entries = execFileSync("tar", ["-tzf", staged.file], { encoding: "utf8", timeout: 1000 });
  for (const entry of RELEASE_ENTRIES) expect(entries).toContain(`package/${entry}`);
  expect(existsSync(join(installed, "prepared"))).toBe(false);
  expect(staged.sha256).toBe(createHash("sha256").update(readFileSync(staged.file)).digest("hex"));
  expect(await stageProvisionRelease(input)).toEqual(staged);
  expect(statSync(staged.file).ino).toBe(inode);
}, 5000);

it.each(["auth", "build"])("missing %s refuses before transport", async missing => {
  const f = fixture(), agent = join(f.root, "agent"), installed = join(f.root, "installed");
  mkdirSync(agent, { mode: 0o700 }); mkdirSync(installed, { mode: 0o700 });
  writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "@guru-irl/spider" }));
  writeFileSync(join(f.root, "roam", "machine.json"), JSON.stringify({ machineId: HUB }), { mode: 0o600 });
  writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify({ enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB,
    peers: [{ machineId: f.request.machineId, alias: f.request.target, node: "/home/fixture/node", pi: "/home/fixture/.local/bin/pi", cli: "/home/fixture/cli", core: "/home/fixture/hc", globalRoot: "/home/fixture/.pi/agent/spider" }], discoveryRoots: [], coreUnit: "fixture.service", limits: DEFAULT_LIMITS }), { mode: 0o600 });
  if (missing === "build") writeFileSync(join(agent, "auth.json"), JSON.stringify({ "github-copilot": { type: "oauth", refresh: "fixture", access: "fixture", expires: 1 } }), { mode: 0o600 });
  vi.stubEnv("PI_CODING_AGENT_DIR", agent); vi.stubEnv("SPIDER_GLOBAL_ROOT", f.root);
  const remote = vi.spyOn(transportModule, "createProvisionTransport").mockImplementation(() => { throw new Error("must not construct transport"); });
  let errors = "";
  expect(await main(["roam", "provision", f.request.target, "--yes", "--consent", "copilot-auth", "--operation-id", "missing-input"],
    { out() {}, err(text) { errors += text; } }, { bundleUrl: new URL(`file://${installed}/dist/roam/cli.mjs`) })).toBe(1);
  expect(errors).toContain(missing === "auth" ? "copilot-auth-unavailable" : "installed-build-unavailable");
  expect(remote).not.toHaveBeenCalled();
}, 5000);

it("previews and records the fixed selection and exact selected Copilot auth bytes", async () => {
  const f = fixture(), agent = join(f.root, "agent"); mkdirSync(agent, { mode: 0o700 });
  const copilot = { type: "oauth", access: "selected-fixture", refresh: "refresh-fixture" };
  writeFileSync(join(agent, "auth.json"), JSON.stringify({ "github-copilot": copilot, other: { key: "other-fixture".repeat(20) } }), { mode: 0o600 });
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ theme: "fixture" }), { mode: 0o600 });
  writeFileSync(join(agent, "models.json"), '{"providers":{}}', { mode: 0o600 });
  writeFileSync(join(agent, "keybindings.json"), "{}", { mode: 0o600 });
  writeFileSync(join(agent, "AGENTS.md"), "fixture instructions\n", { mode: 0o600 });
  for (const dir of ["themes", "skills/fixture", "skills/unselected", "extensions"]) mkdirSync(join(agent, dir), { recursive: true, mode: 0o700 });
  writeFileSync(join(agent, "themes/fixture.css"), "fixture theme\n", { mode: 0o600 });
  writeFileSync(join(agent, "skills/fixture/SKILL.md"), "fixture skill\n", { mode: 0o600 });
  writeFileSync(join(agent, "extensions/fixture.ts"), "fixture extension\n", { mode: 0o600 });
  writeFileSync(join(agent, "extensions/unselected.ts"), "not selected\n", { mode: 0o600 });
  writeFileSync(join(agent, "skills/unselected/SKILL.md"), "not selected\n", { mode: 0o600 });
  writeFileSync(join(f.root, "roam", "machine.json"), JSON.stringify({ machineId: HUB }), { mode: 0o600 });
  writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify({ enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB,
    peers: [{ machineId: f.request.machineId, alias: f.request.target, node: "/home/fixture/node", pi: "/home/fixture/.local/bin/pi", cli: "/home/fixture/cli", core: "/home/fixture/hc", globalRoot: "/home/fixture/.pi/agent/spider" }], coreUnit: "fixture.service" }), { mode: 0o600 });
  vi.stubEnv("PI_CODING_AGENT_DIR", agent); vi.stubEnv("SPIDER_GLOBAL_ROOT", f.root);
  vi.spyOn(hubModule, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  vi.spyOn(transportModule, "createProvisionTransport").mockReturnValue({ transport: {} } as never);
  let expectedByTransfer: number | undefined, selectedByTransfer: readonly string[] = [], expectedFiles: unknown;
  vi.spyOn(provisionModule, "provision").mockImplementation(async (request, ports) => {
    const details = request as typeof request & { expectedAuthBytes?: number; expectedFiles?: unknown };
    expectedByTransfer = details.expectedAuthBytes; selectedByTransfer = request.selected; expectedFiles = details.expectedFiles;
    await ports.present({ target: request.peer.alias, machineId: request.peer.machineId, inventory: healthyInventory(),
      destinations: { ...ports.destination, globalRoot: request.peer.globalRoot, pi: request.peer.pi },
      selectedFiles: [], settingsKeys: ["theme"], settingsFingerprint: "a".repeat(64), providers: request.confirmedProviders, warnings: [] });
    await ports.confirm(request.peer.alias, request.confirmedProviders);
    return { code: 0, reason: "installed", operationId: request.operation.id, home: null, epoch: null, repairCommand: null, value: { hostingReady: true } };
  });
  let output = "", errors = "";
  expect(await main(["roam", "provision", f.request.target, "--release", f.release,
    "--yes", "--consent", "copilot-auth", "--operation-id", "preview-1"], { out(text) { output += text; }, err(text) { errors += text; } })).toBe(0);
  const size = Buffer.byteLength(JSON.stringify({ "github-copilot": copilot }) + "\n");
  expect(output).toContain(`Selected auth.json: ${size} bytes, mode 600.`);
  expect(output).not.toContain("selected-fixture"); expect(output).not.toContain("other-fixture");
  expect(output).not.toContain("fixture instructions"); expect(output).not.toContain("fixture theme"); expect(errors).toBe("");
  const metadata = [
    { path: "AGENTS.md", size: Buffer.byteLength("fixture instructions\n"), mode: 0o600 },
    { path: "keybindings.json", size: 2, mode: 0o600 },
    { path: "models.json", size: Buffer.byteLength('{"providers":{}}'), mode: 0o600 },
    { path: "settings.json", size: Buffer.byteLength('{\n  "theme": "fixture"\n}\n'), mode: 0o600 },
    { path: "themes/fixture.css", size: Buffer.byteLength("fixture theme\n"), mode: 0o600 },
  ];
  for (const file of metadata) {
    expect(output).toContain(`Selected ${file.path}: ${file.size} bytes, mode 600.`);
    expect(output).toContain(`/home/fixture/.pi/agent/${file.path}`);
  }
  expect(output).toContain("Settings keys changing: theme"); expect(output).not.toContain("defaultProvider");
  expect(output).not.toContain("compaction.modelOverrides.*.reserveTokens"); expect(output).not.toContain("retry.provider.maxRetryDelayMs");
  expect(output).not.toContain("skills/fixture"); expect(output).not.toContain("extensions/fixture");
  expect(expectedByTransfer).toBe(size);
  expect(selectedByTransfer).toEqual(["settings.json", "models.json", "keybindings.json", "themes", "AGENTS.md"]);
  expect(expectedFiles).toEqual(metadata);
  const consentFiles = f.journal.read("preview-1").find(row => row.action === "human-consent")?.result.files;
  expect(consentFiles).toEqual([{ path: "auth.json", size, mode: 0o600 }, ...metadata]);
}, 5000);

it("selects only explicitly named skills and includes their supporting files", async () => {
  const f = fixture(), agent = join(f.root, "agent"); mkdirSync(agent, { mode: 0o700 });
  writeFileSync(join(agent, "auth.json"), JSON.stringify({ "github-copilot": { type: "oauth", access: "fixture" } }), { mode: 0o600 });
  for (const name of ["selected/references", "other"]) mkdirSync(join(agent, "skills", name), { recursive: true, mode: 0o700 });
  writeFileSync(join(agent, "skills/selected/SKILL.md"), "private skill body", { mode: 0o600 });
  writeFileSync(join(agent, "skills/selected/references/guide.md"), "private supporting body", { mode: 0o600 });
  writeFileSync(join(agent, "skills/other/SKILL.md"), "unselected body", { mode: 0o600 });
  writeFileSync(join(f.root, "roam", "machine.json"), JSON.stringify({ machineId: HUB }), { mode: 0o600 });
  writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify({ enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB,
    peers: [{ machineId: f.request.machineId, alias: f.request.target, node: "/home/fixture/node", pi: "/home/fixture/.local/bin/pi", cli: "/home/fixture/cli", core: "/home/fixture/hc", globalRoot: "/home/fixture/.pi/agent/spider" }], coreUnit: "fixture.service" }), { mode: 0o600 });
  vi.stubEnv("PI_CODING_AGENT_DIR", agent); vi.stubEnv("SPIDER_GLOBAL_ROOT", f.root);
  vi.spyOn(hubModule, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  vi.spyOn(transportModule, "createProvisionTransport").mockReturnValue({ transport: {} } as never);
  let requested: readonly string[] = [], metadata: unknown;
  vi.spyOn(provisionModule, "provision").mockImplementation(async (request, ports) => {
    requested = request.selected; metadata = request.expectedFiles; await ports.confirm(request.peer.alias, request.confirmedProviders);
    return { code: 0, reason: "installed", operationId: request.operation.id, home: null, epoch: null, repairCommand: null, value: { hostingReady: true } };
  });
  let output = "", errors = "";
  expect(await main(["roam", "provision", f.request.target, "--release", f.release, "--skill", "selected",
    "--yes", "--consent", "copilot-auth", "--operation-id", "selected-skill"], { out(text) { output += text; }, err(text) { errors += text; } })).toBe(0);
  expect(requested).toEqual(["skills/selected"]);
  expect(metadata).toEqual([
    { path: "skills/selected/SKILL.md", size: Buffer.byteLength("private skill body"), mode: 0o600 },
    { path: "skills/selected/references/guide.md", size: Buffer.byteLength("private supporting body"), mode: 0o600 },
  ]);
  expect(output).toContain("/home/fixture/.pi/agent/skills/selected/references/guide.md");
  expect(output).not.toContain("skills/other"); expect(output).not.toContain("private skill body"); expect(output).not.toContain("private supporting body");
  expect(errors).toBe("");
}, 5000);

it("requires a separate noninteractive provider consent for credential-bearing models", async () => {
  const f = fixture(), agent = join(f.root, "agent"); mkdirSync(agent, { mode: 0o700 });
  writeFileSync(join(agent, "auth.json"), JSON.stringify({ "github-copilot": { type: "oauth", access: "fixture" } }), { mode: 0o600 });
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { demo: { apiKey: "fixture-secret" } } }), { mode: 0o600 });
  writeFileSync(join(f.root, "roam", "machine.json"), JSON.stringify({ machineId: HUB }), { mode: 0o600 });
  writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify({ enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB,
    peers: [{ machineId: f.request.machineId, alias: f.request.target, node: "/home/fixture/node", pi: "/home/fixture/.local/bin/pi", cli: "/home/fixture/cli", core: "/home/fixture/hc", globalRoot: "/home/fixture/.pi/agent/spider" }], coreUnit: "fixture.service" }), { mode: 0o600 });
  vi.stubEnv("PI_CODING_AGENT_DIR", agent); vi.stubEnv("SPIDER_GLOBAL_ROOT", f.root);
  vi.spyOn(hubModule, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  const remote = vi.spyOn(transportModule, "createProvisionTransport").mockReturnValue({ transport: {} } as never);
  let requested: readonly string[] = [];
  vi.spyOn(provisionModule, "provision").mockImplementation(async (request, ports) => {
    requested = request.confirmedProviders;
    if (!await ports.confirm(request.peer.alias, request.confirmedProviders)) return { code: 1, reason: "consent-refused", operationId: request.operation.id, home: null, epoch: null, repairCommand: null, value: null };
    return { code: 0, reason: "installed", operationId: request.operation.id, home: null, epoch: null, repairCommand: null, value: { hostingReady: true } };
  });
  let output = "", errors = "";
  const args = ["roam", "provision", f.request.target, "--release", f.release, "--yes", "--consent", "copilot-auth", "--operation-id", "provider-consent"];
  expect(await main(args, { out(text) { output += text; }, err(text) { errors += text; } })).toBe(1);
  expect(errors).toContain("provision-provider-consent-required"); expect(remote).not.toHaveBeenCalled();
  errors = "";
  expect(await main([...args, "--consent-provider", "demo"], { out(text) { output += text; }, err(text) { errors += text; } })).toBe(0);
  expect(requested).toEqual(["demo", "github-copilot"]);
  expect(f.journal.read("provider-consent").find(row => row.action === "human-consent")?.result.providers).toEqual(["demo", "github-copilot"]);
  expect(output).not.toContain("fixture-secret"); expect(errors).toBe("");
}, 5000);

it("names the auth file when its selected provider contains a credential command", async () => {
  const f = fixture(), agent = join(f.root, "agent"); mkdirSync(agent, { mode: 0o700 });
  writeFileSync(join(agent, "auth.json"), JSON.stringify({ "github-copilot": { type: "api_key", key: "!private-command" } }), { mode: 0o600 });
  writeFileSync(join(f.root, "roam", "machine.json"), JSON.stringify({ machineId: HUB }), { mode: 0o600 });
  writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify({ enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB,
    peers: [{ machineId: f.request.machineId, alias: f.request.target, node: "/home/fixture/node", pi: "/home/fixture/.local/bin/pi", cli: "/home/fixture/cli", core: "/home/fixture/hc", globalRoot: "/home/fixture/.pi/agent/spider" }], coreUnit: "fixture.service" }), { mode: 0o600 });
  vi.stubEnv("PI_CODING_AGENT_DIR", agent); vi.stubEnv("SPIDER_GLOBAL_ROOT", f.root);
  const remote = vi.spyOn(transportModule, "createProvisionTransport").mockImplementation(() => { throw new Error("must not construct transport"); });
  let errors = "";
  expect(await main(["roam", "provision", f.request.target, "--yes", "--consent", "copilot-auth"], { out() {}, err(text) { errors += text; } })).toBe(1);
  expect(errors).toContain("unsupported-credential-command"); expect(errors).toContain("auth.json");
  expect(errors).not.toContain("private-command"); expect(remote).not.toHaveBeenCalled();
}, 5000);

it.each(["path", "command"])("reports affected files for a %s refusal before transport", async kind => {
  const f = fixture(), agent = join(f.root, "agent"); mkdirSync(agent, { mode: 0o700 });
  writeFileSync(join(agent, "auth.json"), JSON.stringify({ "github-copilot": { type: "oauth", access: "fixture" } }), { mode: 0o600 });
  const foreign = ["", "Users", "example", "private"].join("/");
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { demo: kind === "path" ? { baseUrl: foreign } : { apiKey: "!private-command" } } }), { mode: 0o600 });
  if (kind === "path") writeFileSync(join(agent, "AGENTS.md"), foreign, { mode: 0o600 });
  writeFileSync(join(f.root, "roam", "machine.json"), JSON.stringify({ machineId: HUB }), { mode: 0o600 });
  writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify({ enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB,
    peers: [{ machineId: f.request.machineId, alias: f.request.target, node: "/home/fixture/node", pi: "/home/fixture/.local/bin/pi", cli: "/home/fixture/cli", core: "/home/fixture/hc", globalRoot: "/home/fixture/.pi/agent/spider" }], coreUnit: "fixture.service" }), { mode: 0o600 });
  vi.stubEnv("PI_CODING_AGENT_DIR", agent); vi.stubEnv("SPIDER_GLOBAL_ROOT", f.root);
  const remote = vi.spyOn(transportModule, "createProvisionTransport").mockImplementation(() => { throw new Error("must not construct transport"); });
  let errors = "";
  expect(await main(["roam", "provision", f.request.target, "--yes", "--consent", "copilot-auth"], { out() {}, err(text) { errors += text; } })).toBe(1);
  expect(errors).toContain(kind === "path" ? "unsupported-path" : "unsupported-credential-command");
  expect(errors).toContain("models.json");
  if (kind === "path") expect(errors).toContain("AGENTS.md");
  expect(errors).not.toContain(foreign); expect(errors).not.toContain("private-command"); expect(remote).not.toHaveBeenCalled();
}, 5000);

it("rejects extra selected-file arguments before contacting a box", async () => {
  const f = fixture(), agent = join(f.root, "agent"); mkdirSync(agent, { mode: 0o700 });
  writeFileSync(join(agent, "auth.json"), JSON.stringify({ "github-copilot": { type: "oauth", access: "fixture" } }), { mode: 0o600 });
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { other: { apiKey: "fixture-secret" } } }), { mode: 0o600 });
  writeFileSync(join(f.root, "roam", "machine.json"), JSON.stringify({ machineId: HUB }), { mode: 0o600 });
  writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify({ enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB,
    peers: [{ machineId: f.request.machineId, alias: f.request.target, node: "/home/fixture/node", pi: "/home/fixture/.local/bin/pi", cli: "/home/fixture/cli", core: "/home/fixture/hc", globalRoot: "/home/fixture/.pi/agent/spider" }], coreUnit: "fixture.service" }), { mode: 0o600 });
  vi.stubEnv("PI_CODING_AGENT_DIR", agent); vi.stubEnv("SPIDER_GLOBAL_ROOT", f.root);
  const remote = vi.spyOn(transportModule, "createProvisionTransport").mockImplementation(() => { throw new Error("must not construct transport"); });
  let errors = "";
  expect(await main(["roam", "provision", f.request.target, "--release", f.release, "--select", "models.json", "--yes", "--consent", "copilot-auth"], { out() {}, err(text) { errors += text; } })).toBe(2);
  expect(errors).toContain("Invalid provisioning arguments"); expect(errors).not.toContain("fixture-secret");
  expect(remote).not.toHaveBeenCalled();
}, 5000);

it("pins the release hash across retry and refuses a symlink override", async () => {
  const f = fixture();
  const first = await pinProvisionRelease(f.release, 1024);
  await confirmProvision(f.journal, { ...f.request, releaseHash: first.sha256 }, { tty: false, yes: true, consent: "copilot-auth", actor: "fixture-user", now: () => 1, ask: async () => "" });
  writeFileSync(f.release, "release-two"); const second = await pinProvisionRelease(f.release, 1024);
  await expect(confirmProvision(f.journal, { ...f.request, releaseHash: second.sha256 }, { tty: false, yes: true, consent: "copilot-auth", actor: "fixture-user", now: () => 2, ask: async () => "" })).rejects.toThrow("different arguments");
  const link = join(f.root, "linked.tgz"); symlinkSync(f.release, link);
  await expect(pinProvisionRelease(link, 1024)).rejects.toThrow("release");
}, 5000);
