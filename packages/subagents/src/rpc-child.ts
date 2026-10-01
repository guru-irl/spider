import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";

export type SteerDelivery = "delivered" | "accepted but not confirmed" | "no reply yet, delivery unknown" | "refused";
export interface SteerAck {
  /** RPC success is acceptance, not evidence of conversation entry. */
  accepted: boolean;
  requestId?: string;
  childAccepted?: boolean;
  delivered?: boolean;
  queued?: boolean;
  delivery?: SteerDelivery;
  transformed?: boolean;
  observedText?: string;
  error?: string;
}

/** LF alone delimits RPC records. Preserve Unicode separators and split UTF-8 bytes. */
export function attachRpcReader(stream: NodeJS.ReadableStream, onEvent: (event: Record<string, any>) => void, onError: (error: Error) => void): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const line = (text: string) => {
    if (!text.trim()) return;
    try { onEvent(JSON.parse(text.endsWith("\r") ? text.slice(0, -1) : text)); }
    catch (error) { onError(error instanceof Error ? error : new Error(String(error))); }
  };
  stream.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const text = buffer.slice(0, index); buffer = buffer.slice(index + 1); line(text);
    }
  });
  stream.on("end", () => { buffer += decoder.end(); if (buffer) line(buffer); });
}

/** Event types a sink persists (see Runner.rpcSink). Losing one is a loss of run history. */
export const PERSISTED_EVENT_TYPES: readonly string[] = ["warning", "extension_error", "queue_update", "steer_delivery"];
/** Streaming partials: each carries the whole message so far and a full message event follows. Never buffered. */
const PARTIAL_EVENT_TYPES: readonly string[] = ["message_update", "tool_execution_update"];

/** Bounds on what is held while the sink is unbound (a reload gap is seconds long). Non-persisted and
 *  persisted events have separate budgets, so the former can never push out the latter. */
export const MAX_BUFFERED_EVENTS: number = 500;
export const MAX_BUFFERED_BYTES: number = 1024 * 1024;
export const MAX_BUFFERED_PERSISTED: number = 1000;
export const MAX_BUFFERED_PERSISTED_BYTES: number = 4 * 1024 * 1024;

interface Buffered { seq: number; event: Record<string, any>; bytes: number }

/**
 * Routes events to a sink that can be unbound across a /reload. While unbound, events queue (bounded,
 * partials skipped) and replay in order to the next sink. If anything the sink would have persisted
 * had to be dropped, the replay starts with a warning carrying `eventsLost`, which the runner turns
 * into a note on the run's final result, so the loss is never silent.
 */
export interface EventGate {
  report(event: Record<string, any>): void;
  unbind(): void;
  bind(next: (event: Record<string, any>) => void): void;
}

export function createEventGate(initial?: (event: Record<string, any>) => void): EventGate {
  let sink = initial, buffering = false, seq = 0;
  const persisted: Buffered[] = [], other: Buffered[] = [];
  let persistedBytes = 0, otherBytes = 0, lostPersisted = 0, droppedOther = 0;
  const deliver = (event: Record<string, any>) => { try { sink?.(event); } catch { /* reporting cannot block pipe drainage */ } };
  const sizeOf = (event: Record<string, any>) => { try { return JSON.stringify(event).length; } catch { return 0; } };
  const report = (event: Record<string, any>) => {
    if (!buffering) return deliver(event);
    if (PARTIAL_EVENT_TYPES.includes(event.type)) return;
    const isPersisted = PERSISTED_EVENT_TYPES.includes(event.type);
    const queue = isPersisted ? persisted : other;
    const item: Buffered = { seq: seq++, event, bytes: sizeOf(event) };
    queue.push(item);
    if (isPersisted) persistedBytes += item.bytes; else otherBytes += item.bytes;
    const maxCount = isPersisted ? MAX_BUFFERED_PERSISTED : MAX_BUFFERED_EVENTS;
    const maxBytes = isPersisted ? MAX_BUFFERED_PERSISTED_BYTES : MAX_BUFFERED_BYTES;
    while (queue.length > maxCount || ((isPersisted ? persistedBytes : otherBytes) > maxBytes && queue.length > 0)) {
      const evicted = queue.shift()!;
      if (isPersisted) { persistedBytes -= evicted.bytes; lostPersisted++; } else { otherBytes -= evicted.bytes; droppedOther++; }
    }
  };
  return {
    report: report,
    unbind(): void { buffering = true; sink = undefined; },
    bind(next: (event: Record<string, any>) => void): void {
      sink = next; buffering = false;
      const replay = [...persisted, ...other].sort((a, b) => a.seq - b.seq);
      persisted.length = 0; other.length = 0; persistedBytes = 0; otherBytes = 0;
      if (lostPersisted) deliver({ type: "warning", eventsLost: lostPersisted, message: `Events lost during reload: ${lostPersisted} child event(s) did not fit the reload buffer and were dropped.` });
      else if (droppedOther) deliver({ type: "warning", message: `Reload gap: ${droppedOther} non-persisted child event(s) were dropped from the reload buffer.` });
      lostPersisted = 0; droppedOther = 0;
      for (const { event } of replay) deliver(event);
    },
  };
}

export function ownRpcChild(child: ChildProcess, prompt: string, onEvent?: (event: Record<string, any>) => void) {
  let closed = false, settled = false, stopping = false, discardAfterSettle = false;
  let steering: string[] = [], followUp: string[] = [];
  let promptAccepted = false, failureReason: string | undefined, stderrTail = "";
  type Pending = { command: string; message?: string; childAccepted?: boolean; additions?: string[]; entries?: string[]; queuedText?: string; observed?: boolean; reportedDelivery?: SteerDelivery; finish: (ack: SteerAck) => void; timer?: ReturnType<typeof setTimeout> };
  const pending = new Map<string, Pending>();
  let activeSteer: string | undefined;
  let steerBusy = false;
  const waitingSteers: Array<{ message: string; finish: (ack: SteerAck) => void; timer: ReturnType<typeof setTimeout> }> = [];
  // The sink can be unbound across a /reload: events then queue (bounded) and replay in order
  // to the next sink, while protocol handling below keeps running on the live pipes.
  const gate = createEventGate(onEvent);
  const report = gate.report;
  const deliveryAck = (p: Pending): SteerAck => ({ accepted: p.childAccepted === true || p.observed === true, delivered: p.observed === true,
    queued: !p.observed && p.queuedText !== undefined && steering.includes(p.queuedText),
    delivery: p.observed ? "delivered" : p.childAccepted ? "accepted but not confirmed" : "no reply yet, delivery unknown",
    ...(p.observed ? { observedText: p.queuedText, transformed: p.queuedText !== p.message } : {}) });
  const deliveryEvent = (id: string, p: Pending, reason?: string) => {
    const ack = deliveryAck(p);
    if (p.reportedDelivery === "delivered") return;
    p.reportedDelivery = ack.delivery;
    report({ type: "steer_delivery", requestId: id, steer: p.message, ...ack,
      message: `Steer ${ack.delivery}.${ack.transformed ? " Child input transformed the text." : ""}${reason ? ` ${reason}` : ""}` });
  };
  const refused = (message: string, error: string, id: string = randomUUID()): SteerAck => {
    const ack: SteerAck = { accepted: false, requestId: id, delivered: false, delivery: "refused", error };
    report({ type: "steer_delivery", requestId: id, steer: message, ...ack, message: `Steer refused: ${error}` });
    return ack;
  };
  // Queue events have no request IDs. Exact text wins; a rewrite needs a
  // sole addition across the whole acceptance window and a success reply.
  // Exit/abort/settlement without a reply cannot confirm a tentative rewrite.
  const correlate = (p: Pending) => {
    const additions = p.additions ?? [];
    p.queuedText = additions.includes(p.message!) ? p.message : additions.length === 1 ? additions[0] : undefined;
    p.observed = p.queuedText !== undefined && (p.entries ?? []).includes(p.queuedText)
      && (p.queuedText === p.message || p.childAccepted === true);
  };
  const releaseSteer = (id: string) => {
    if (activeSteer !== id) return;
    activeSteer = undefined; steerBusy = false;
    const next = waitingSteers.shift();
    if (next) { clearTimeout(next.timer); void startSteer(next.message).then(next.finish); }
  };
  const failPending = (error: string) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer); pending.delete(id);
      if (p.command === "steer") {
        correlate(p);
        deliveryEvent(id, p, error);
        p.finish({ ...deliveryAck(p), requestId: id, error });
      } else p.finish({ accepted: false, error });
    }
    activeSteer = undefined; steerBusy = false;
    for (const next of waitingSteers.splice(0)) { clearTimeout(next.timer); next.finish(refused(next.message, `Not sent: ${error}`)); }
  };
  const finalizeSettledSteers = () => {
    for (const [id, p] of pending) if (p.command === "steer") {
      clearTimeout(p.timer); pending.delete(id);
      const reason = p.observed ? undefined : p.childAccepted ? `Run settled; accepted, delivery not confirmed.${steering.length || followUp.length ? " Remaining queue was discarded." : ""}` : "Run settled before the child replied; delivery unknown.";
      deliveryEvent(id, p, reason);
      p.finish({ ...deliveryAck(p), requestId: id, ...(reason ? { error: reason } : {}) });
    }
    activeSteer = undefined; steerBusy = false;
    for (const next of waitingSteers.splice(0)) {
      clearTimeout(next.timer); next.finish(refused(next.message, "Not sent: run settled; start a fresh run."));
    }
  };
  const close = () => { if (closed) return; closed = true; child.stdin?.end(); };
  const send = (command: Record<string, any>): boolean => {
    if (closed || !child.stdin?.writable || child.stdin.destroyed) return false;
    try { child.stdin.write(JSON.stringify(command) + "\n"); return true; }
    catch { return false; }
  };
  const maybeComplete = () => {
    if (!stopping && pending.size === 0 && (discardAfterSettle || (settled && steering.length === 0 && followUp.length === 0))) close();
  };
  const request = (command: Record<string, any>, timeoutMs?: number): Promise<SteerAck> => new Promise(resolve => {
    const id = randomUUID();
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      const p = pending.get(id);
      if (!p) return;
      p.timer = undefined;
      if (command.type === "steer") {
        // The bytes were written. No reply is uncertainty, not rejection.
        // Retain the request and its serialized window for late replies/events.
        deliveryEvent(id, p);
        resolve({ ...deliveryAck(p), requestId: id });
      } else {
        pending.delete(id);
        resolve({ accepted: false, error: "No RPC acceptance response." });
      }
      maybeComplete();
    }, timeoutMs);
    timer?.unref();
    pending.set(id, { command: command.type, message: command.message, finish: resolve, timer });
    if (command.type === "steer") activeSteer = id;
    if (!send({ ...command, id })) {
      clearTimeout(timer); pending.delete(id);
      const error = "Child RPC pipe is closed.";
      resolve(command.type === "steer" ? refused(command.message, error, id) : { accepted: false, error });
      if (command.type === "steer") releaseSteer(id);
    }
  });
  const onExit = () => {
    closed = true;
    if (!promptAccepted && !stopping && !failureReason) {
      failureReason = `Child exited before acknowledging the prompt.${stderrTail.trim() ? ` Stderr tail:\n${stderrTail.trim()}` : " No stderr diagnostics."}`;
      report({ type: "warning", message: failureReason });
    }
    failPending("Child process has exited.");
  };
  child.on("exit", onExit); child.on("error", onExit);
  child.stdin?.on("error", () => { closed = true; failPending("Child RPC pipe failed."); });
  child.stdout?.on("error", error => report({ type: "warning", message: `Child stdout failed: ${error.message}` }));
  child.stderr?.on("error", error => report({ type: "warning", message: `Child stderr failed: ${error.message}` }));
  // A child's diagnostics must not fill stderr while the parent is busy.
  child.stderr?.on("data", chunk => { stderrTail = (stderrTail + String(chunk)).slice(-4096); });
  attachRpcReader(child.stdout!, event => {
    if (event.type === "extension_ui_request") {
      if (["select", "confirm", "input", "editor"].includes(event.method)) {
        send({ type: "extension_ui_response", id: event.id, cancelled: true });
        report({ type: "warning", message: `Cancelled child extension UI dialog (${event.method}).`, requestId: event.id });
      }
    } else if (event.type === "response") {
      const p = pending.get(event.id);
      if (p) {
        if (p.command === "prompt" && event.success === true) promptAccepted = true;
        clearTimeout(p.timer); p.timer = undefined;
        if (p.command === "steer" && event.success === true) {
          p.childAccepted = true; correlate(p);
          p.finish({ ...deliveryAck(p), requestId: event.id });
          deliveryEvent(event.id, p);
          if (p.observed) pending.delete(event.id);
        } else {
          pending.delete(event.id);
          const error = event.error ?? "Child rejected the command.";
          p.finish(p.command === "steer" ? p.observed ? { ...deliveryAck(p), requestId: event.id } : refused(p.message!, error, event.id) : { accepted: event.success === true, ...(event.success === true ? {} : { error }) });
        }
        if (p.command === "steer") releaseSteer(event.id);
      }
    } else if (event.type === "agent_start") {
      settled = false;
    } else if (event.type === "agent_settled") {
      settled = true;
      if (steering.length || followUp.length || [...pending.values()].some(p => p.command === "steer")) {
        discardAfterSettle = true; send({ type: "clear_queue" });
        finalizeSettledSteers();
      }
    } else if (event.type === "queue_update") {
      const next: string[] = Array.isArray(event.steering) ? event.steering : [];
      // RPC events have no request IDs. Serialize steer acceptance windows and
      // collect all additions in that window, including rewrites.
      const remaining = [...steering], added: string[] = [];
      for (const text of next) {
        const i = remaining.indexOf(text);
        if (i < 0) added.push(text); else remaining.splice(i, 1);
      }
      const p = activeSteer ? pending.get(activeSteer) : undefined;
      if (p && !p.childAccepted) { p.additions = [...(p.additions ?? []), ...added]; correlate(p); }
      steering = next;
      followUp = Array.isArray(event.followUp) ? event.followUp : [];
      // Queue removal alone is not delivery: clear_queue also removes entries.
      if (settled && (steering.length > 0 || followUp.length > 0)) {
        discardAfterSettle = true; send({ type: "clear_queue" }); finalizeSettledSteers();
      }
    } else if (event.type === "message_start" && event.message?.role === "user" && !stopping) {
      const content = event.message.content;
      const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter(c => c.type === "text").map(c => c.text).join("") : undefined;
      // One conversation event confirms at most one steer, even for duplicate text.
      for (const [id, p] of pending) if (p.command === "steer" && !p.observed && p.queuedText !== undefined && p.queuedText === text) {
        (p.entries ??= []).push(text); correlate(p);
        if (p.observed) { deliveryEvent(id, p); if (p.childAccepted) pending.delete(id); }
        break;
      }
    }
    // Update boundaries before notifying observers, preventing late steering.
    report(event);
    maybeComplete();
  }, error => {
    report({ type: "warning", message: `Invalid child RPC record: ${error.message}` });
  });
  // Exactly one prompt per child. No lifecycle command triggers a turn.
  void request({ type: "prompt", message: prompt }, undefined).then(ack => {
    if (!ack.accepted && !stopping && !failureReason) {
      failureReason = ack.error;
      report({ type: "warning", message: failureReason }); close();
    }
  });
  const startSteer = (message: string): Promise<SteerAck> => {
    if (closed || stopping || settled || discardAfterSettle) {
      const error = "Child has completed or is shutting down; start a fresh run.";
      for (const next of waitingSteers.splice(0)) { clearTimeout(next.timer); next.finish(refused(next.message, error)); }
      return Promise.resolve(refused(message, error));
    }
    steerBusy = true;
    const ack = request({ type: "steer", message }, 10_000);
    return ack;
  };
  return {
    failureReason: (): string | undefined => failureReason,
    /** Routes an event through the same gate as the child's own events (for the spawner's warnings). */
    report: (event: Record<string, any>): void => gate.report(event),
    unbindEvents: (): void => gate.unbind(),
    bindEvents: (next: (event: Record<string, any>) => void): void => gate.bind(next),
    steer(message: string): Promise<SteerAck> {
      if (message.trimStart().startsWith("/")) return Promise.resolve(refused(message, "Steer text starting with '/' can be expanded by the child as a skill or prompt template, or rejected as an extension command; RPC steer has no literal-text option. Rephrase so it does not start with '/'."));
      if (steerBusy) return new Promise(finish => {
        const waiter = { message, finish, timer: setTimeout(() => {
          const index = waitingSteers.indexOf(waiter);
          if (index < 0) return;
          waitingSteers.splice(index, 1);
          finish(refused(message, "Not sent: timed out waiting for an earlier steer's reply."));
        }, 10_000) };
        waiter.timer.unref(); waitingSteers.push(waiter);
      });
      return startSteer(message);
    },
    async abort(graceMs = 250): Promise<void> {
      if (closed || stopping) return;
      stopping = true;
      // Abort alone permits queued continuations. Clear them before aborting.
      send({ type: "clear_queue" });
      await request({ type: "abort" }, Math.max(1, graceMs));
      close();
      failPending("Child was stopped.");
    },
  };
}
