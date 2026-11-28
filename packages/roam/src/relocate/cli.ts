import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { RoamConfig } from "../contracts";
import { resolveControlMachine, resolveControlSession } from "../commands";
import { forgottenDestinationRefusal } from "../revocation";
import { forceWarning, setHomeReplicationRefusal } from "./set-home";
import type { StoppedRelocateSuccess } from "./relocate";
import type { V0PlacementControlServices } from "./service";
import type { RelocateSuccess, RunningHome, SessionId, V0CommandIO, V0PublicControl, V0Refusal, V0Result } from "./types";

export async function readV0Confirmation(prompt: string, streams: {
  input: Readable & { isTTY?: boolean }; output: Writable & { isTTY?: boolean };
} = { input: process.stdin, output: process.stderr }): Promise<string | null> {
  if (!streams.input.isTTY || !streams.output.isTTY) return null;
  const reader = createInterface(streams), abort = new AbortController();
  const onClose = () => abort.abort();
  reader.once("close", onClose);
  try { return await reader.question(prompt, { signal: abort.signal }); }
  catch { return null; }
  finally { reader.off("close", onClose); reader.close(); }
}

const token = (value: string | undefined): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value);
export function parseV0Control(argv: readonly string[]): V0PublicControl | null {
  const args = argv.at(-1) === "--json" ? argv.slice(0, -1) : argv;
  const [group, kind, session, machine, force] = args;
  if (group !== "roam" || !token(session) || !token(machine)) return null;
  if (kind === "relocate" && args.length === 4) return { kind, session, machine };
  if (kind === "set-home" && args.length === 5 && force === "--force") return { kind, session, machine, force: true, confirmation: null };
  return null;
}

export async function runV0Control(control: V0PublicControl, config: RoamConfig,
  catalog: readonly { id: string; name: string | null }[], services: V0PlacementControlServices,
  io: V0CommandIO, options: { json?: boolean; isForgotten?: (machineId: string) => boolean } = {}): Promise<number> {
  const emit = (result: V0Result<RelocateSuccess | StoppedRelocateSuccess | RunningHome>): number => {
    if (options.json) io.out(`${JSON.stringify(result)}\n`);
    else if (!result.ok) io.err(`${result.refusal.message}\n${result.refusal.nextStep}\n`);
    else if ("stop" in result.value) {
      const { home, stop } = result.value;
      const status = stop.status === "stopped" ? "Stopped" : stop.status === "stopping" ? "Stopping" : "Stop pending";
      io.out(`Session is at ${home.machineId}; ${status}.\n`);
      if (stop.reason) io.out(`${stop.reason}\n`);
    }
    else if ("home" in result.value) {
      if (result.value.localPid) io.out(`Session is already running on the Mac (pi PID ${result.value.localPid}). Use the terminal where you started it.\n`);
      else io.out(`Session is at ${result.value.home.machineId}; terminal ${result.value.terminal}.\n`);
      const branch = result.value.branchRecovery;
      if (branch) io.out(`Git HEAD is detached. The saved branch ${branch.savedBranch} was left unchanged. In the destination checkout, run ${branch.command} to save the imported commit on a branch.\n`);
      io.out("Processes started outside Spider in this folder keep running.\n");
    }
    else {
      io.out(`Home assigned to ${result.value.machineId}.\n`);
      if (result.value.machineId === config.hubMachineId) {
        if (!config.enabled) io.out("Run spider roam enable on the Mac first.\n");
        io.out(`Run spider roam relocate ${result.value.sessionId} mac to start the session.\n`);
      }
    }
    return result.ok ? 0 : 1;
  };
  const refuse = (refusal: V0Refusal) => emit({ ok: false, refusal });
  if (config.role !== "hub" || config.machineId !== config.hubMachineId) return refuse({ code: "mac-required", message: "Relocation and home reassignment must run on the Mac.", nextStep: "Run this command on the Mac." });
  if (control.kind === "relocate" && !config.enabled) return refuse({ code: "replication-disabled", message: "Relocation needs replication enabled.", nextStep: "Enable replication on the Mac, then retry relocation." });
  const resolved = resolveControlSession(control.session, catalog);
  if ("reason" in resolved) return refuse({
    code: resolved.candidates.length ? "ambiguous-session" : "session-not-found",
    message: resolved.candidates.length ? `Session matches multiple candidates: ${resolved.candidates.join(", ")}.` : "The session was not found.",
    nextStep: resolved.candidates.length ? "Retry with one full session ID from those candidates." : "Choose an existing session ID or exact name.",
  });
  const destinationMachine = resolveControlMachine(control.machine, config);
  if (!destinationMachine) return refuse({ code: "machine-not-found", message: "The destination does not identify exactly one machine.", nextStep: "Use mac or one configured machine ID or alias." });
  const sessionId = resolved.sessionId as SessionId;
  try {
    if (destinationMachine !== config.machineId && options.isForgotten?.(destinationMachine)) return refuse(forgottenDestinationRefusal);
    if (control.kind === "relocate") return emit(await services.relocate({ sessionId, destinationMachine }));
    const cannotReplicate = setHomeReplicationRefusal(destinationMachine, config);
    if (cannotReplicate) return refuse(cannotReplicate);
    const phrase = `reassign ${sessionId} to ${destinationMachine}; source will not run`;
    const confirmation = control.confirmation ?? await io.confirmation(`${forceWarning}\nType exactly: ${phrase}\n> `);
    if (confirmation !== phrase) return refuse({ code: "confirmation-required", message: "Home reassignment requires the exact typed confirmation.", nextStep: "Retry set-home --force interactively and type the requested phrase exactly." });
    return emit(await services.setHome({ sessionId, destinationMachine, force: true, confirmation }));
  } catch { return refuse({ code: "home-unavailable", message: "The v0 home service is unavailable.", nextStep: "Start the v0 hub on the Mac, then retry this command." }); }
}
