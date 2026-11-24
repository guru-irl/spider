import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { paths } from "@spider/db-core";
import type { MoveRequest, MoveResult, SourceCleanup, Outcome, RoamConfig } from "@spider/roam/contracts";
import { readLocalIdentity } from "@spider/roam/runtime";
import { controlText, resolveControlMachine, safeControlOutcome } from "@spider/roam/commands";

export interface MoveCommandResult extends Outcome<MoveResult> { text: string; intercomAddress: string | null; warnings: readonly string[] }
export function createMoveCommand(request: (input: MoveRequest) => Promise<Outcome<MoveResult>>, config: () => RoamConfig = () => readLocalIdentity(paths.globalRoot)) {
  return async (args: string, ctx: ExtensionCommandContext): Promise<MoveCommandResult> => {
    const refuse = (code: 1 | 2, reason: string, text = reason): MoveCommandResult => ({ code, reason, text, operationId: "", home: null, epoch: null, repairCommand: null, value: null, intercomAddress: null, warnings: [] });
    if (!args || args !== args.trim() || !/^[^\s\u0000-\u001f\u007f-][^\s\u0000-\u001f\u007f]*$/.test(args)) return refuse(2, "invalid-move-arguments", "Run /move <machine>.");
    let pinned: RoamConfig;
    try { pinned = config(); } catch { return refuse(1, "roaming-config-unavailable", "Roaming configuration is unavailable. Run spider roam doctor on the Mac."); }
    if (!pinned.enabled) return refuse(1, "roaming-disabled", "Roaming is disabled. Run spider roam enable on the Mac.");
    if (pinned.role !== "hub") return refuse(1, "mac-hub-required", "Run spider move <session> <machine> on the Mac hub.");
    const sessionId = ctx.sessionManager.getSessionId(), file = ctx.sessionManager.getSessionFile(), header = ctx.sessionManager.getHeader();
    if (process.env.PI_SUBAGENT_CHILD === "1" || ctx.mode !== "tui" || !ctx.hasUI || !sessionId || !file || !isAbsolute(file) || !header || header.id !== sessionId || header.parentSession)
      return refuse(1, "persistent-top-level-required", "Move requires the current persistent top-level interactive session.");
    const destinationMachine = resolveControlMachine(args, pinned);
    if (!destinationMachine) return refuse(2, "machine-not-enrolled");
    const operation = { id: randomUUID(), kind: "move", machineId: pinned.machineId, expectedEpoch: null, args: { sessionId, destinationMachine } };
    ctx.ui.notify("Move started; keep the Mac awake until it finishes.", "info");
    ctx.ui.setStatus("roam-move", `Move in progress. Operation: ${operation.id}`);
    try {
      const safe = safeControlOutcome(await request({ operation, sessionId, destinationMachine }));
      const details = safe.value as { terminal?: string; intercomAddress?: string; warnings?: string[]; sourceCleanup?: SourceCleanup } | null;
      const warnings = details?.warnings ?? [], intercomAddress = details?.intercomAddress ?? null;
      if (safe.code === 0 && (!safe.home || !intercomAddress || !details?.sourceCleanup)) return refuse(1, "invalid-move-control-reply");
      const value: MoveResult | null = safe.code === 0 && safe.home && intercomAddress && details?.sourceCleanup
        ? { home: safe.home, terminal: details?.terminal ?? null, intercomAddress, warnings, sourceCleanup: details.sourceCleanup } : null;
      const alias = safe.home?.machineId === pinned.hubMachineId ? "mac" : pinned.peers.find(peer => peer.machineId === safe.home?.machineId)?.alias;
      return { ...safe, value, text: controlText(safe, alias).trimEnd(), intercomAddress, warnings };
    } catch {
      const repairCommand = `spider roam recover ${operation.id}`;
      return { code: 3, reason: "move-control-unavailable", operationId: operation.id, home: null, epoch: null,
        repairCommand, value: null, intercomAddress: null, warnings: [],
        text: `The move request may not have reached the hub, or its reply was lost. The outcome is unknown.\nOperation: ${operation.id}\n${repairCommand}` };
    }
    finally { ctx.ui.setStatus("roam-move", undefined); }
  };
}
export function registerMoveCommand(pi: ExtensionAPI, request: (input: MoveRequest) => Promise<Outcome<MoveResult>>): void {
  const move = createMoveCommand(request);
  pi.registerCommand("move", { description: "Move this persistent top-level session to an enrolled machine", async handler(args, ctx) {
    const result = await move(args, ctx);
    if (ctx.hasUI) ctx.ui.notify(result.text, result.code === 0 ? "info" : "warning");
    else process.stderr.write(`${result.text}\n`);
  } });
}
