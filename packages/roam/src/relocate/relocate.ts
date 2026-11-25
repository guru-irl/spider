import type {
  MovingHome, RelocateCheckpoint, RelocateHome, RelocateId, RelocateOutcome,
  RelocatePlan, RelocatePorts, RelocateRequest, RelocateStep, RunningHome,
  V0Refusal, V0RefusalCode, V0Result,
} from "./types";

class PortRefusal extends Error {
  constructor(readonly refusal: V0Refusal) { super(refusal.message); }
}
function value<T>(result: V0Result<T>): T {
  if (!result.ok) throw new PortRefusal(result.refusal);
  return result.value;
}
function movingHome(plan: RelocatePlan): MovingHome {
  return { ...plan.source, state: "moving", epoch: plan.source.epoch + 1,
    moveId: plan.moveId, destination: plan.destinationPlacement.machineId, updatedAt: plan.startedAt };
}
function committedHome(plan: RelocatePlan): RunningHome {
  return { ...plan.source, machineId: plan.destinationPlacement.machineId, state: "running",
    epoch: plan.source.epoch + 2, moveId: plan.moveId, destination: null, updatedAt: plan.startedAt };
}
const failureCodes: Record<RelocateStep, V0RefusalCode> = {
  check: "home-unavailable", "mark-moving": "sync-failed", "stop-source": "stop-timeout",
  "pull-source": "transfer-failed", "push-destination": "transfer-failed",
  "install-destination": "install-failed", "commit-home": "sync-failed",
  "start-destination": "start-pending", confirm: "start-pending",
};

/** Hub-only orchestration. All durable state and exclusion belong to the ports. */
export async function relocate(request: RelocateRequest, ports: RelocatePorts): Promise<RelocateOutcome> {
  let home: RelocateHome | null = null;
  let moveId: RelocateId | null = null;
  let step: RelocateStep = "check";
  const refuse = (code: V0RefusalCode, message: string, nextStep =
    `Retry spider roam relocate ${request.sessionId} ${request.destinationMachine}.`): never => {
    throw new PortRefusal({ code, message, nextStep });
  };
  const cas = async (expected: RelocateHome, next: RelocateHome) => {
    const result = await ports.homes.compareAndSwap(expected, next);
    home = result.home;
    if (result.kind === "conflict") refuse("home-conflict", "The session home changed during relocation.");
  };
  const save = async (checkpoint: RelocateCheckpoint) => {
    try { await ports.journal.save(checkpoint); }
    catch { refuse("journal-unavailable", "The relocation checkpoint could not be saved."); }
  };
  try {
    return await ports.withSession(request.sessionId, async () => {
      home = await ports.homes.read(request.sessionId);
      if (!home) {
        const source = value(await ports.initialSource(request.sessionId));
        home = await ports.homes.initialize(request.sessionId, source);
      }
      if (home.state === "moving") refuse("move-in-progress", "A relocation is already in progress.");
      moveId = ports.newMoveId();
      const plan = value(await ports.check(request, home, moveId));
      let checkpoint: RelocateCheckpoint = {
        plan, completed: ["check"], captured: null, installed: null, terminal: null, result: null,
      };
      await save(checkpoint);
      const complete = async (done: RelocateStep, update: Partial<RelocateCheckpoint> = {}) => {
        checkpoint = { ...checkpoint, ...update, completed: [...checkpoint.completed, done] };
        await save(checkpoint);
      };
      const moving = movingHome(plan);
      const committed = committedHome(plan);
      step = "mark-moving";
      await cas(plan.source, moving);
      value(await ports.publishHome(moving, moving.machineId));
      await complete(step);
      step = "stop-source";
      value(await ports.stopSource(plan, moving));
      await complete(step);
      step = "pull-source";
      const captured = value(await ports.pullSource(plan));
      await complete(step, { captured });
      step = "push-destination";
      value(await ports.pushDestination(plan, captured));
      await complete(step);
      step = "install-destination";
      const installed = value(await ports.installDestination(plan, captured, committed));
      await complete(step, { installed });
      step = "commit-home";
      await cas(moving, committed);
      value(await ports.publishHome(committed, committed.machineId));
      await complete(step);
      step = "start-destination";
      const started = value(await ports.start(committed, installed.placement));
      await complete(step, { terminal: started.terminal });
      step = "confirm";
      const confirmed = value(await ports.confirm(committed, installed.placement));
      const result = { moveId, home: committed, placement: installed.placement,
        terminal: confirmed.terminal, disposition: "relocated" as const };
      await complete(step, { terminal: confirmed.terminal, result });
      return { ok: true, value: result };
    });
  } catch (error) {
    return { ok: false, step, home, moveId, refusal: error instanceof PortRefusal ? error.refusal : {
      code: failureCodes[step], message: `Relocation could not finish ${step}.`,
      nextStep: `Retry spider roam relocate ${request.sessionId} ${request.destinationMachine}.`,
    } };
  }
}
