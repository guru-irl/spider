import type { Clock } from "../contracts";
import type {
  CapturedSession, InstalledSession, MovingHome, RelocateCheckpoint, RelocateHome, RelocateId, RelocateOutcome, RelocateSuccess,
  RelocatePlan, RelocatePorts, RelocateRequest, RelocateStep, RunningHome, SessionPlacement,
  SettledHome, V0Refusal, V0RefusalCode, V0Result,
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
function branchAdvice(home: RunningHome, installed: InstalledSession | null, captured: CapturedSession | null): Pick<RelocateSuccess, "branchRecovery"> {
  const workspace = captured?.workspace;
  if (installed?.branchDetached !== true || !workspace?.branch?.startsWith("refs/heads/") ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(workspace.head)) return {};
  const savedBranch = workspace.branch.slice("refs/heads/".length);
  const branch = `spider-relocated-${home.epoch}-${workspace.head.slice(0, 12)}`;
  return { branchRecovery: { savedBranch, command: `git switch -c ${branch} ${workspace.head}` } };
}
function restoredHome(plan: RelocatePlan): RunningHome {
  return { ...plan.source, state: "running", epoch: plan.source.epoch + 2,
    moveId: plan.moveId, destination: null, updatedAt: plan.startedAt };
}
const steps: readonly RelocateStep[] = ["check", "mark-moving", "stop-source", "pull-source",
  "push-destination", "install-destination", "commit-home", "start-destination", "confirm"];
function sameHome(left: RelocateHome, right: RelocateHome): boolean {
  return left.sessionId === right.sessionId && left.machineId === right.machineId &&
    left.epoch === right.epoch && left.state === right.state && left.destination === right.destination &&
    left.moveId === right.moveId && left.updatedAt === right.updatedAt;
}
// The journal adapter parses storage. This boundary additionally checks recovery policy:
// a saved result may justify skipping an effect only for this exact moving home.
function matchesMoving(checkpoint: RelocateCheckpoint | null, home: MovingHome): checkpoint is RelocateCheckpoint {
  try {
    if (!checkpoint) return false;
    const { plan, completed, captured, installed } = checkpoint;
    return (plan.source.state === "running" || plan.source.state === "stopped") &&
      sameHome(movingHome(plan), home) && plan.sourcePlacement.sessionId === home.sessionId &&
      plan.sourcePlacement.machineId === home.machineId && plan.destinationPlacement.sessionId === home.sessionId &&
      Array.isArray(completed) && completed.length > 0 && completed.length <= 6 &&
      completed.every((step, index) => step === steps[index]) &&
      (captured !== null) === completed.includes("pull-source") &&
      (installed !== null) === completed.includes("install-destination") && checkpoint.result === null &&
      (!captured || (captured.session.sessionId === home.sessionId && captured.workspace.moveId === home.moveId)) &&
      (!installed || (installed.placement.sessionId === home.sessionId && installed.placement.machineId === home.destination));
  } catch { return false; }
}
const failureCodes: Record<RelocateStep, V0RefusalCode> = {
  check: "home-unavailable", "mark-moving": "sync-failed", "stop-source": "stop-timeout",
  "pull-source": "transfer-failed", "push-destination": "transfer-failed",
  "install-destination": "install-failed", "commit-home": "sync-failed",
  "start-destination": "start-pending", confirm: "start-pending",
};

interface Readiness { clock: Clock; timeoutMs: number }

function waitForConfirmation<T>(attempt: () => Promise<V0Result<T>>, readiness: Readiness, pending: V0Refusal): Promise<V0Result<T>> {
  return new Promise((resolve, reject) => {
    let expired = false;
    let cancelPoll: (() => void) | undefined;
    const cancelDeadline = readiness.clock.later(readiness.timeoutMs, () => {
      expired = true;
      cancelPoll?.();
      resolve({ ok: false, refusal: pending });
    });
    const poll = async () => {
      try {
        const result = await attempt();
        if (expired) return;
        if (!result.ok && result.refusal.code === "start-pending") {
          cancelPoll = readiness.clock.later(250, () => { void poll(); });
        } else {
          cancelDeadline();
          resolve(result);
        }
      } catch (error) {
        cancelDeadline();
        reject(error);
      }
    };
    void poll();
  });
}

/** Hub-only orchestration. All durable state and exclusion belong to the ports. */
export async function relocate(request: RelocateRequest, ports: RelocatePorts, readiness?: Readiness): Promise<RelocateOutcome> {
  let home: RelocateHome | null = null;
  let moveId: RelocateId | null = null;
  let step: RelocateStep = "check";
  let entered = false;
  function refuse(code: V0RefusalCode, message: string, nextStep =
    `Retry spider roam relocate ${request.sessionId} ${request.destinationMachine}.`): never {
    throw new PortRefusal({ code, message, nextStep });
  }
  const cas = async (expected: RelocateHome, next: RelocateHome) => {
    const result = await ports.homes.compareAndSwap(expected, next).catch(async error => {
      // A lost reply may hide an applied CAS. Never report the cached prior home.
      try { home = await ports.homes.read(request.sessionId); } catch { home = null; }
      throw error;
    });
    home = result.home;
    if (result.kind === "conflict") refuse("home-conflict", "The session home changed during relocation.");
  };
  const save = async (checkpoint: RelocateCheckpoint) => {
    try { await ports.journal.save(checkpoint); }
    catch { refuse("journal-unavailable", "The relocation checkpoint could not be saved."); }
  };
  const confirm = async (home: RunningHome, placement: SessionPlacement) => {
    const attempt = () => ports.confirm(home, placement);
    return value(await (readiness ? waitForConfirmation(attempt, readiness, {
      code: "start-pending",
      message: `The home is committed to ${home.machineId}, but pi has not confirmed startup.`,
      nextStep: `Retry spider roam relocate ${request.sessionId} ${request.destinationMachine} to check startup.`,
    }) : attempt()));
  };
  const check = async (source: SettledHome): Promise<RelocateCheckpoint> => {
    moveId = ports.newMoveId();
    const plan = value(await ports.check(request, source, moveId));
    return { plan, completed: ["check"], captured: null, installed: null, terminal: null, result: null };
  };
  try {
    return await ports.withSession(request.sessionId, async () => {
      entered = true;
      home = await ports.homes.read(request.sessionId);
      let checkedFirst: RelocateCheckpoint | undefined;
      let initialPlacement: SessionPlacement | undefined;
      if (!home) {
        const machineId = value(await ports.initialSource(request.sessionId));
        const candidate: RunningHome = { sessionId: request.sessionId, machineId,
          epoch: ports.initialEpoch?.(request.sessionId) ?? 1, state: "running", destination: null, moveId: null, updatedAt: 0 };
        if (machineId === request.destinationMachine) {
          initialPlacement = value(await ports.locate(machineId, request.sessionId));
        } else {
          checkedFirst = await check(candidate);
          await save(checkedFirst);
        }
        home = await ports.homes.initialize(request.sessionId, machineId);
        if (!sameHome({ ...home, updatedAt: candidate.updatedAt }, candidate)) {
          refuse("home-conflict", "The initial session home changed during check.");
        }
      }
      if (home.state === "running" && home.machineId === request.destinationMachine && home.moveId) {
        let pending: RelocateCheckpoint | null;
        try { pending = await ports.journal.load(home.moveId); } catch { pending = null; }
        let recovery: { placement: SessionPlacement; disposition: "relocated" | "undone" } | null = null;
        try {
          if (pending && pending.result === null) {
            if (pending.installed && sameHome(committedHome(pending.plan), home)) {
              recovery = { placement: pending.installed.placement, disposition: "relocated" };
            } else if (sameHome(restoredHome(pending.plan), home)) {
              recovery = { placement: pending.plan.sourcePlacement, disposition: "undone" };
            }
          }
        } catch { /* An authoritative settled home can resume without a journal. */ }
        if (pending && recovery) {
          moveId = home.moveId;
          const { placement, disposition } = recovery;
          step = "commit-home";
          value(await ports.publishHome(home, home.machineId));
          value(await ports.activate(home, placement));
          step = "start-destination";
          value(await ports.start(home, placement));
          step = "confirm";
          const confirmed = await confirm(home, placement);
          const result = { moveId, home, placement, terminal: confirmed.terminal, disposition,
            ...(disposition === "relocated" ? branchAdvice(home, pending.installed, pending.captured) : {}) };
          await save({ ...pending, completed: disposition === "relocated" ? steps : pending.completed,
            terminal: confirmed.terminal, result });
          return { ok: true, value: result };
        }
      }
      if (home.state !== "moving" && home.machineId === request.destinationMachine) {
        moveId = home.moveId;
        const placement = initialPlacement ?? value(await ports.locate(home.machineId, request.sessionId));
        const resumed: RunningHome = { ...home, state: "running",
          epoch: home.state === "stopped" ? home.epoch + 1 : home.epoch };
        if (home.state === "stopped") {
          step = "commit-home";
          value(await ports.activate(resumed, placement));
          await cas(home, resumed);
          value(await ports.publishHome(resumed, resumed.machineId));
        } else {
          step = "commit-home";
          value(await ports.publishHome(resumed, resumed.machineId));
          value(await ports.activate(resumed, placement));
        }
        step = "start-destination";
        value(await ports.start(resumed, placement));
        step = "confirm";
        const confirmed = await confirm(resumed, placement);
        return { ok: true, value: { moveId, home: resumed, placement, terminal: confirmed.terminal, disposition: "already-home" } };
      }
      let checkpoint: RelocateCheckpoint;
      if (home.state === "moving") {
        moveId = home.moveId;
        if (request.destinationMachine !== home.machineId && request.destinationMachine !== home.destination) {
          refuse("move-in-progress", "The session is already moving to another destination.",
            `Finish spider roam relocate ${request.sessionId} ${home.destination}, or undo with spider roam relocate ${request.sessionId} ${home.machineId}.`);
        }
        step = "mark-moving";
        let pending: RelocateCheckpoint | null;
        try { pending = await ports.journal.load(moveId); } catch { pending = null; }
        if (!matchesMoving(pending, home)) {
          refuse("journal-unavailable", "The relocation checkpoint is missing or unreadable.",
            `Use spider roam set-home ${request.sessionId} ${home.machineId} --force only with a local backup; unsynced work can be lost.`);
        }
        checkpoint = pending;
      } else if (checkedFirst) {
        checkpoint = checkedFirst;
      } else {
        checkpoint = await check(home);
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
        const confirmed = await confirm(restored, plan.sourcePlacement);
        const result = { moveId, home: restored, placement: plan.sourcePlacement,
          terminal: confirmed.terminal, disposition: "undone" as const };
        await save({ ...checkpoint, terminal: confirmed.terminal, result });
        return { ok: true, value: result };
      }
      step = "mark-moving";
      if (home.state !== "moving") await cas(checkedFirst ? home : plan.source, moving);
      if (!done(step)) {
        try { value(await ports.publishHome(moving, moving.machineId)); }
        catch (error) {
          // The one safe rollback boundary: no destination work has begun.
          const restored: RunningHome = { ...moving, state: "running", destination: null, epoch: moving.epoch + 1 };
          await cas(moving, restored);
          // Best effort: the authoritative running home is safe even if the
          // source is still unreachable. Its loop can reactivate on later sync.
          try { value(await ports.publishHome(restored, restored.machineId)); } catch { /* keep the original refusal */ }
          throw error;
        }
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
      const confirmed = await confirm(committed, installed.placement);
      const result = { moveId, home: committed, placement: installed.placement,
        terminal: confirmed.terminal, disposition: "relocated" as const, ...branchAdvice(committed, installed, captured) };
      await complete(step, { terminal: confirmed.terminal, result });
      return { ok: true, value: result };
    });
  } catch (error) {
    if (!entered && error instanceof Error && error.name === "HerdrError" && "code" in error && error.code === "lock-occupied") {
      return { ok: false, step, home, moveId, refusal: {
        code: "session-busy", message: "Another operation on this session is still in progress.",
        nextStep: "Wait for that operation to finish, then retry relocation.",
      } };
    }
    return { ok: false, step, home, moveId, refusal: error instanceof PortRefusal ? error.refusal : {
      code: failureCodes[step], message: `Relocation could not finish ${step}.`,
      nextStep: `Retry spider roam relocate ${request.sessionId} ${request.destinationMachine}.`,
    } };
  }
}
