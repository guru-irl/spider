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
      if (home.state === "running" && home.machineId === request.destinationMachine && home.moveId) {
        const pending = await ports.journal.load(home.moveId);
        if (pending && !pending.result && pending.installed && pending.plan.moveId === home.moveId &&
            pending.plan.destinationPlacement.machineId === home.machineId && pending.plan.source.epoch + 2 === home.epoch) {
          moveId = home.moveId;
          const placement = pending.installed.placement;
          step = "commit-home";
          value(await ports.publishHome(home, home.machineId));
          value(await ports.activate(home, placement));
          step = "start-destination";
          value(await ports.start(home, placement));
          step = "confirm";
          const confirmed = value(await ports.confirm(home, placement));
          const result = { moveId, home, placement, terminal: confirmed.terminal, disposition: "relocated" as const };
          await save({ ...pending, completed: [...new Set([...pending.completed, "commit-home", "start-destination", "confirm"] as const)],
            terminal: confirmed.terminal, result });
          return { ok: true, value: result };
        }
      }
      let checkpoint: RelocateCheckpoint;
      if (home.state === "moving") {
        moveId = home.moveId;
        if (request.destinationMachine !== home.machineId && request.destinationMachine !== home.destination) {
          refuse("move-in-progress", "The session is already moving to another destination.",
            `Finish spider roam relocate ${request.sessionId} ${home.destination}, or undo with spider roam relocate ${request.sessionId} ${home.machineId}.`);
        }
        const pending = await ports.journal.load(moveId);
        if (!pending) refuse("journal-unavailable", "The relocation checkpoint is unavailable.");
        checkpoint = pending;
      } else {
        moveId = ports.newMoveId();
        const plan = value(await ports.check(request, home, moveId));
        checkpoint = { plan, completed: ["check"], captured: null, installed: null, terminal: null, result: null };
        await save(checkpoint);
      }
      const plan = checkpoint.plan;
      const done = (name: RelocateStep) => checkpoint.completed.includes(name);
      const complete = async (done: RelocateStep, update: Partial<RelocateCheckpoint> = {}) => {
        checkpoint = { ...checkpoint, ...update, completed: [...checkpoint.completed, done] };
        await save(checkpoint);
      };
      const moving = movingHome(plan);
      const committed = committedHome(plan);
      if (home.state === "moving" && request.destinationMachine === plan.source.machineId) {
        step = "stop-source";
        value(await ports.stopSource(plan, moving));
        const restored: RunningHome = { ...home, state: "running", destination: null,
          epoch: home.epoch + 1, updatedAt: plan.startedAt };
        step = "commit-home";
        value(await ports.activate(restored, plan.sourcePlacement));
        await cas(home, restored);
        value(await ports.publishHome(restored, restored.machineId));
        step = "start-destination";
        value(await ports.start(restored, plan.sourcePlacement));
        step = "confirm";
        const confirmed = value(await ports.confirm(restored, plan.sourcePlacement));
        const result = { moveId, home: restored, placement: plan.sourcePlacement,
          terminal: confirmed.terminal, disposition: "undone" as const };
        await save({ ...checkpoint, terminal: confirmed.terminal, result });
        return { ok: true, value: result };
      }
      step = "mark-moving";
      if (home.state !== "moving") await cas(plan.source, moving);
      if (!done(step)) {
        value(await ports.publishHome(moving, moving.machineId));
        await complete(step);
      }
      step = "stop-source";
      if (!done(step)) {
        value(await ports.stopSource(plan, moving));
        await complete(step);
      }
      step = "pull-source";
      const captured = checkpoint.captured ?? value(await ports.pullSource(plan));
      if (!done(step)) await complete(step, { captured });
      step = "push-destination";
      if (!done(step)) {
        value(await ports.pushDestination(plan, captured));
        await complete(step);
      }
      step = "install-destination";
      const installed = checkpoint.installed ?? value(await ports.installDestination(plan, captured, committed));
      if (!done(step)) await complete(step, { installed });
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
