import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { paths } from "@spider/db-core";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MoveRequest, MoveResult, Outcome, RoamConfig } from "@spider/roam/contracts";
import { DEFAULT_INTERCOM_LIMITS, DEFAULT_LIMITS } from "@spider/roam/contracts";
import { readLocalIdentity } from "@spider/roam/runtime";
import { createMoveCommand, registerMoveCommand } from "../move-command";
import spiderExtension, { SPIDER_PARAMETERS } from "../../extension";
import { createHostSessionFixture, hostUnitPorts, withPiEvents } from "../../__tests__/fixtures/pi-events";
import * as admissionModule from "../admission";
import * as activationModule from "../move-activation";
import * as hubControl from "@spider/roam/control-socket";

const HUB = "00000000-0000-4000-8000-000000000001", BOX = "00000000-0000-4000-8000-000000000002";
const config = (enabled = true, role: "hub" | "box" = "hub"): RoamConfig => ({ enabled, role, machineId: role === "hub" ? HUB : BOX, hubMachineId: HUB,
  peers: role === "hub" ? [{ machineId: BOX, alias: "box-1.invalid", node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/core", globalRoot: "/fixture/global" }] : [],
  discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS,
  intercom: { enabled: false, mode: "hub-only", machineAlias: "hub.invalid", protocolFeature: "federation-v1", routes: [], limits: DEFAULT_INTERCOM_LIMITS } });
const context = (): ExtensionCommandContext => ({ mode: "tui", hasUI: true, cwd: "/fixture/workspace", ui: { notify: vi.fn(), setStatus: vi.fn() },
  sessionManager: { getSessionId: () => "session-a", getSessionFile: () => "/fixture/session.jsonl", getHeader: () => ({ type: "session", id: "session-a", version: 3, cwd: "/fixture/workspace" }) } } as unknown as ExtensionCommandContext);
const result = (code: 0 | 1 | 2 | 3 = 0): Outcome<MoveResult> => ({ code, reason: code === 3 ? "destination-unknown" : "complete", operationId: "move-a",
  home: { sessionId: "session-a", machineId: BOX, epoch: 2, moveId: "move-a", updatedAt: 1 }, epoch: 2, repairCommand: "spider roam recover move-a",
  value: code === 0 ? { sourceCleanup: { status: "done" }, home: { sessionId: "session-a", machineId: BOX, epoch: 2, moveId: "move-a", updatedAt: 1 }, terminal: "terminal-a", intercomAddress: "session-a@box-1.invalid", warnings: ["route-unavailable:peer.invalid", "tool-auth-missing:fixture-tool"] } : null });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("Mac slash move targets only persistent top-level current session", async () => {
  const requests: MoveRequest[] = [], handler = createMoveCommand(async input => { requests.push(input); return result(); }, () => config());
  const value = await handler("box-1.invalid", context());
  expect(value.code).toBe(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ sessionId: "session-a", destinationMachine: BOX, operation: { machineId: HUB, kind: "move", args: { sessionId: "session-a", destinationMachine: BOX } } });
}, 5000);
it.each(["child", "fork", "print", "transient", "nonpersistent"])("refuses %s slash moves without effects", async kind => {
  const moveEffects: MoveRequest[] = [], ctx = context();
  if (kind === "child") vi.stubEnv("PI_SUBAGENT_CHILD", "1");
  if (kind === "fork") Object.assign(ctx.sessionManager, { getHeader: () => ({ id: "session-a", parentSession: "/fixture/parent.jsonl" }) });
  if (kind === "print") Object.assign(ctx, { mode: "print", hasUI: false });
  if (kind === "transient") Object.assign(ctx.sessionManager, { getHeader: () => null });
  if (kind === "nonpersistent") Object.assign(ctx.sessionManager, { getSessionFile: () => undefined });
  const value = await createMoveCommand(async input => { moveEffects.push(input); return result(); }, () => config())("box-1.invalid", ctx);
  expect(value.code).toBe(1);
  expect(value.reason).toBe("persistent-top-level-required");
  expect(moveEffects).toEqual([]);
}, 5000);
it("box slash move points to Mac without request rows", async () => {
  const boxRequestRows: MoveRequest[] = [];
  const value = await createMoveCommand(async input => { boxRequestRows.push(input); return result(); }, () => config(true, "box"))("mac", context());
  expect(value.text).toContain("Mac");
  expect(value.reason).toBe("mac-hub-required");
  expect(boxRequestRows).toHaveLength(0);
}, 5000);
it("/move with roaming disabled refuses with a clear reason", async () => {
  const moveEffects: MoveRequest[] = [];
  const value = await createMoveCommand(async input => { moveEffects.push(input); return result(); }, () => config(false))("box-1.invalid", context());
  expect(value.reason).toBe("roaming-disabled");
  expect(moveEffects).toEqual([]);
}, 5000);
it("pending outcome explains paused source", async () => {
  const pending = await createMoveCommand(async () => result(3), () => config())("box-1.invalid", context());
  expect(pending.text).toContain("The source is paused to avoid running two copies.");
  expect(pending.text).toContain("spider roam recover move-a");
}, 5000);
it("shows the exact validated refusal message and blockers in /move", async () => {
  const refusal = { ...result(1), reason: "move-preflight-blocked", value: null,
    refusal: { code: "move-preflight-blocked", blockers: ["outbound-ask:a8f3"], message: "Unsettled work blocks this move." } };
  const value = await createMoveCommand(async () => refusal, () => config())("box-1.invalid", context());
  expect(value.text).toContain("Unsettled work blocks this move."); expect(value.text).toContain("outbound-ask:a8f3");
}, 5000);

it("reports progress before waiting, names the destination alias and avoids unproved paused claims", async () => {
  const ctx = context(); let finish!: (value: Outcome<MoveResult>) => void;
  const move = createMoveCommand(() => new Promise(resolve => { finish = resolve; }), () => config());
  const pending = move("box-1.invalid", ctx);
  expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Move started"), "info");
  finish(result());
  expect((await pending).text).toContain("box-1.invalid");
  const lock = await createMoveCommand(async () => ({ ...result(3), reason: "move-lock-pending" }), () => config())("box-1.invalid", context());
  expect(lock.text).not.toContain("The source is paused");
}, 5000);

it("lost control replies retain the known operation ID and exact recovery command", async () => {
  const ctx = context(); let operationId = "";
  const value = await createMoveCommand(async input => { operationId = input.operation.id; throw new Error("synthetic lost reply"); }, () => config())("box-1.invalid", ctx);
  expect(value).toMatchObject({ code: 3, reason: "move-control-unavailable", operationId, repairCommand: `spider roam recover ${operationId}` });
  expect(operationId).not.toBe("");
  expect(value.text).toContain(operationId);
  expect(value.text).toContain(`spider roam recover ${operationId}`);
  expect(value.text).not.toContain("The source is paused");
  expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("roam-move", undefined);
}, 5000);

it("long moves use one persistent status without periodic notifications", async () => {
  vi.useFakeTimers();
  const ctx = context(); let finish!: (value: Outcome<MoveResult>) => void, operationId = "";
  const move = createMoveCommand(input => { operationId = input.operation.id; return new Promise(resolve => { finish = resolve; }); }, () => config());
  const pending = move("box-1.invalid", ctx);
  expect(ctx.ui.setStatus).toHaveBeenCalledWith("roam-move", expect.stringContaining(operationId));
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  const completed = result(); completed.operationId = operationId; completed.home!.moveId = operationId;
  completed.value!.home.moveId = operationId; completed.reason = "moved"; completed.repairCommand = null;
  finish(completed); expect((await pending).code).toBe(0);
  expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("roam-move", undefined);
}, 5000);

it("an answered invalid success remains a refusal rather than a transport outage", async () => {
  const invalid = { ...result(), home: null };
  const value = await createMoveCommand(async () => invalid, () => config())("box-1.invalid", context());
  expect(value).toMatchObject({ code: 1, reason: "invalid-move-control-reply", repairCommand: null });
}, 5000);

it("distinguishes an unreadable roaming config from disabled roaming", async () => {
  const outcome = await createMoveCommand(async () => result(), () => { throw new Error("unreadable"); })("box-1.invalid", context());
  expect(outcome.reason).toBe("roaming-config-unavailable");
}, 5000);

it("does not imply gh or Git readiness when production reports tool-auth-unverified", async () => {
  const success = result();
  success.value!.warnings = ["tool-auth-unverified"];
  const value = await createMoveCommand(async () => success, () => config())("box-1.invalid", context());
  expect(value.text).toContain("gh auth status"); expect(value.text).toContain("Git identity");
  expect(value.text).toContain("not checked");
}, 5000);

it("success reports the new intercom address and actual route and tool warnings", async () => {
  const success = await createMoveCommand(async () => result(), () => config())("box-1.invalid", context());
  const destinationTerminal = "terminal-a", expectedIntercomAddress = "session-a@box-1.invalid", actualRouteAndToolWarnings = result().value!.warnings;
  const toolWarningBlocksMove = success.code !== 0;
  expect(success.text).toContain(destinationTerminal);
  expect(success.intercomAddress).toBe(expectedIntercomAddress);
  expect(success.warnings).toEqual(actualRouteAndToolWarnings);
  expect(toolWarningBlocksMove).toBe(false);
}, 5000);
it.each(["", "box-1.invalid extra", "--yes", "box-1.invalid\nsecret"])("invalid slash arguments %j have no effects", async args => {
  const effect = vi.fn(async () => result());
  expect((await createMoveCommand(effect, () => config())(args, context())).code).toBe(2);
  expect(effect).not.toHaveBeenCalled();
}, 5000);
it("model tool cannot provision or mutate home", () => {
  expect(SPIDER_PARAMETERS.properties.action.enum).not.toEqual(expect.arrayContaining(["move"]));
  for (const name of ["move", "roam", "enable", "provision", "claim", "forget", "cancel", "recover"]) expect(SPIDER_PARAMETERS.properties.action.enum).not.toContain(name);
  for (const name of ["destinationMachine", "confirmation", "credentials", "consent"]) expect(SPIDER_PARAMETERS.properties).not.toHaveProperty(name);
}, 5000);
it("registers move only as a user command", () => {
  const registerCommand = vi.fn();
  registerMoveCommand({ registerCommand } as unknown as ExtensionAPI, async () => result());
  expect(registerCommand).toHaveBeenCalledWith("move", expect.objectContaining({ handler: expect.any(Function) }));
}, 5000);

it("a stale /move command refuses after disable without contacting the hub", async () => {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "mc-")), previous = paths.globalRoot;
  try {
    paths.globalRoot = root; mkdirSync(join(root, "roam"), { mode: 0o700 });
    writeFileSync(join(root, "roam", "machine.json"), JSON.stringify({ machineId: HUB }), { mode: 0o600 });
    const file = join(root, "roam", "config.json"); writeFileSync(file, JSON.stringify(config(true)), { mode: 0o600 });
    let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    const pi = withPiEvents({ registerTool() {}, registerCommand(name: string, command: { handler: typeof handler }) { if (name === "move") handler = command.handler; }, on() {}, sendMessage() {} });
    const request = vi.spyOn(hubControl, "requestHubControl");
    spiderExtension(pi as never, hostUnitPorts); expect(handler).toBeTypeOf("function");
    writeFileSync(file, JSON.stringify(config(false)), { mode: 0o600 });
    const ctx = context(); await handler!("box-1.invalid", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Roaming is disabled"), "warning");
    expect(request).not.toHaveBeenCalled();
  } finally { paths.globalRoot = previous; rmSync(root, { recursive: true, force: true }); }
}, 5000);

it("a real extension activation failure releases the lock and leaves a homeless session usable", async () => {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "mc-")), previous = paths.globalRoot;
  try {
    paths.globalRoot = root; mkdirSync(join(root, "roam"), { mode: 0o700 });
    writeFileSync(join(root, "roam", "machine.json"), JSON.stringify({ machineId: HUB }), { mode: 0o600 });
    writeFileSync(join(root, "roam", "config.json"), JSON.stringify(config()), { mode: 0o600 });
    const warnings: string[] = [], releases: string[] = [], seen = new Set<string>();
    const ports: admissionModule.AdmissionPorts & { setContext(ctx: any): void } = { expectedEpoch: null, setContext() {}, lockUntracked: () => true,
      async localMachine() { return HUB; }, knownParticipant: () => false,
      warnOnce(id, reason) { if (!seen.has(id)) { seen.add(id); warnings.push(reason); } },
      async load() { return { home: null, states: [], origin: null, participating: false, captureSafe: true, unfinishedFreeze: false, initialConflict: false }; },
      async lock() { return async () => { releases.push("released"); }; } };
    vi.spyOn(admissionModule, "createAdmissionPorts").mockReturnValue(ports);
    const activation = vi.spyOn(activationModule, "createMoveActivation").mockRejectedValue(new Error("activation-failed"));
    const host = createHostSessionFixture({ cwd: root, sessionId: "homeless", sessionFile: join(root, "session.jsonl") });
    spiderExtension(host.pi as never, hostUnitPorts);
    const start = host.hooks.get("session_start")![0], input = host.hooks.get("input")![0];
    await start({ reason: "startup" }, host.ctx);
    expect(activation).toHaveBeenCalledOnce(); expect(releases).toEqual(["released"]);
    expect(await input({ text: "continue" }, host.ctx)).toBeUndefined();
    expect(warnings).toHaveLength(1); expect(warnings[0]).toMatch(/move setup failed/i);
    await start({ reason: "reload" }, host.ctx); expect(warnings).toHaveLength(1);
  } finally { paths.globalRoot = previous; rmSync(root, { recursive: true, force: true }); }
}, 5000);

it.each(["missing", "disabled", "enabled"] as const)("extension registers /move only when roaming is enabled at load: %s", state => {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "mc-")), previous = paths.globalRoot;
  try {
    paths.globalRoot = root;
    if (state !== "missing") {
      mkdirSync(join(root, "roam"), { mode: 0o700 });
      writeFileSync(join(root, "roam", "machine.json"), JSON.stringify({ machineId: HUB }), { mode: 0o600 });
      writeFileSync(join(root, "roam", "config.json"), JSON.stringify(config(state === "enabled")), { mode: 0o600 });
      expect(readLocalIdentity(root).enabled).toBe(state === "enabled");
    }
    const commands: string[] = [];
    const pi = withPiEvents({ registerTool() {}, registerCommand(name: string) { commands.push(name); }, on() {}, sendMessage() {} });
    spiderExtension(pi as never, hostUnitPorts);
    expect(commands.includes("move")).toBe(state === "enabled");
  } finally { paths.globalRoot = previous; rmSync(root, { recursive: true, force: true }); }
}, 5000);
