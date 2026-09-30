import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";

export interface SteerAck {
  /** Pi accepted delivery at the next turn boundary, not proof of model consumption. */
  accepted: boolean;
  /** Pi acknowledged queue insertion, but the parent refused future delivery after settlement. */
  childAccepted?: boolean;
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

export function ownRpcChild(child: ChildProcess, prompt: string, onEvent?: (event: Record<string, any>) => void) {
  let closed = false, settled = false, stopping = false, discardAfterSettle = false;
  let steering: string[] = [], followUp: string[] = [];
  let promptAccepted = false, failureReason: string | undefined, stderrTail = "";
  const pending = new Map<string, { command: string; message?: string; childAccepted?: boolean; queued?: boolean; consumed?: boolean; finish: (ack: SteerAck) => void; timer?: ReturnType<typeof setTimeout> }>();
  const report = (event: Record<string, any>) => { try { onEvent?.(event); } catch { /* reporting cannot block pipe drainage */ } };
  const undelivered = (id: string, message: string, reason: string) => report({
    type: "steer_delivery", requestId: id, steer: message, delivered: false,
    message: `Accepted steer was not delivered: ${reason}`,
  });
  const failPending = (error: string) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer); pending.delete(id);
      if (p.childAccepted) undelivered(id, p.message!, error);
      else p.finish({ accepted: false, error });
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
      pending.delete(id);
      if (command.type === "steer" && settled) { discardAfterSettle = true; send({ type: "clear_queue" }); }
      resolve({ accepted: false, error: "No RPC acceptance response; delivery is unconfirmed." }); maybeComplete();
    }, timeoutMs);
    timer?.unref();
    pending.set(id, { command: command.type, message: command.message, finish: resolve, timer });
    if (!send({ ...command, id })) {
      clearTimeout(timer); pending.delete(id); resolve({ accepted: false, error: "Child RPC pipe is closed." });
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
  // A child's diagnostics must not fill stderr while the parent is busy.
  child.stdout?.on("error", error => report({ type: "warning", message: `Child stdout failed: ${error.message}` }));
  child.stderr?.on("error", error => report({ type: "warning", message: `Child stderr failed: ${error.message}` }));
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
          p.childAccepted = true;
          if (settled || discardAfterSettle) {
            p.finish({ accepted: false, childAccepted: true, error: "Run finished; accepted steer was not delivered because the remaining queue was discarded." });
            pending.delete(event.id); discardAfterSettle = true; send({ type: "clear_queue" });
            undelivered(event.id, p.message!, "Run settled before delivery could be confirmed; remaining queue was discarded.");
          } else {
            p.finish({ accepted: true });
            if (p.consumed) {
              pending.delete(event.id);
              report({ type: "steer_delivery", requestId: event.id, steer: p.message, delivered: true, message: "Accepted steer queue consumed at a turn boundary; model consumption is unconfirmed." });
            }
          }
        } else {
          pending.delete(event.id);
          p.finish({ accepted: event.success === true, ...(event.success === true ? {} : { error: event.error ?? "Child rejected the command." }) });
        }
      }
    } else if (event.type === "agent_start") {
      settled = false;
    } else if (event.type === "agent_settled") {
      settled = true;
      if (steering.length || followUp.length || [...pending.values()].some(p => p.command === "steer")) {
        discardAfterSettle = true; send({ type: "clear_queue" });
        for (const [id, p] of pending) if (p.command === "steer" && p.childAccepted) {
          clearTimeout(p.timer); pending.delete(id);
          undelivered(id, p.message!, "Run settled before delivery; remaining queue was discarded.");
        }
      }
    } else if (event.type === "queue_update") {
      steering = Array.isArray(event.steering) ? event.steering : [];
      followUp = Array.isArray(event.followUp) ? event.followUp : [];
      for (const [id, p] of pending) if (p.command === "steer") {
        if (steering.includes(p.message!)) p.queued = true;
        else if (p.queued && !settled && !stopping) {
          p.consumed = true;
          if (p.childAccepted) {
            pending.delete(id);
            report({ type: "steer_delivery", requestId: id, steer: p.message, delivered: true, message: "Accepted steer queue consumed at a turn boundary; model consumption is unconfirmed." });
          }
        }
      }
      if (settled && (steering.length > 0 || followUp.length > 0)) {
        discardAfterSettle = true; send({ type: "clear_queue" });
      }
    }
    // Observers see the updated boundary, so a callback cannot sneak a steer in
    // after receiving agent_settled but before this controller notices it.
    report(event);
    maybeComplete();
  }, error => {
    report({ type: "warning", message: `Invalid child RPC record: ${error.message}` });
  });
  // Exactly one prompt per child. No heartbeat or lifecycle command triggers a turn.
  void request({ type: "prompt", message: prompt }, undefined).then(ack => {
    if (!ack.accepted && !stopping && !failureReason) {
      failureReason = ack.error;
      report({ type: "warning", message: failureReason }); close();
    }
  });
  return {
    failureReason: (): string | undefined => failureReason,
    async steer(message: string): Promise<SteerAck> {
      if (closed || stopping || settled || discardAfterSettle) return { accepted: false, error: "Child has completed or is shutting down; start a fresh run." };
      return request({ type: "steer", message }, 10_000);
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
