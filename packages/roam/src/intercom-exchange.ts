import type { Clock, Peer, Transport } from "./contracts";
import { decodeExchange, encodeExchange } from "./intercom-codec";
import { INTERCOM_EXCHANGE_BYTES, type IntercomExchange, type IntercomStore } from "./intercom-contracts";
import { isMachineId } from "./machine-id";

export interface EnrolledIntercomEdge { peer: Peer; edgeEpoch: string; initiator: boolean }
export interface ExchangeRequest { exchange: IntercomExchange; holdMs: number }
export interface ExchangeReply { version: 1; exchange: IntercomExchange }
export interface ExchangePorts {
  machineId: string;
  enrollment: Pick<EnrolledIntercomEdge, "peer" | "edgeEpoch">;
  transport: Pick<Transport, "exec">;
  store: Pick<IntercomStore, "edgeState">;
  clock: Pick<Clock, "now">;
  signal?: AbortSignal;
  onConnected?: (connected: boolean) => void;
  probe?: boolean;
  maxTotalMs?: number;
}

const errors = new Set(["core-changed", "core-unavailable", "machine-not-found", "machine-not-enrolled", "machine-mismatch", "peer-invalidated",
  "needs_login", "unavailable", "spawn_failed", "spawn-error", "missing-hc", "cli-exit", "cli-timeout", "cli-aborted", "reply-too-large",
  "unsupported-broker", "helper-unauthorized", "helper-timeout", "bridge-unavailable", "broker-unavailable", "bridge-exchange-failed", "exchange-too-large",
  "invalid-request", "invalid-presence", "invalid-refusal", "invalid-receipt", "invalid-reply", "stale-generation", "endpoint-exited"]);
export class ExchangeError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly exitCode?: number;
  constructor(code: string, exitCode?: number) {
    super(code); this.name = "ExchangeError"; this.code = code;
    this.retryable = !["machine-mismatch", "machine-not-enrolled", "unsupported-broker", "helper-unauthorized", "invalid-request", "invalid-presence",
      "invalid-refusal", "invalid-receipt", "invalid-reply", "endpoint-exited"].includes(code);
    if (exitCode !== undefined) this.exitCode = exitCode;
  }
}
const bad = (code: string): never => { throw new ExchangeError(code); };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, fields: readonly string[]): boolean => Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
function samePeer(a: Peer, b: Peer): boolean {
  return a.machineId === b.machineId && a.alias === b.alias && a.node === b.node && a.pi === b.pi && a.cli === b.cli && a.core === b.core && a.globalRoot === b.globalRoot;
}
function safeError(error: unknown): ExchangeError {
  if (error instanceof ExchangeError) return error;
  const value = record(error) ? error : {};
  const code = typeof value.code === "string" && errors.has(value.code) ? value.code : "exchange-failed";
  const details = record(value.details) ? value.details : {};
  const exitCode = Number.isSafeInteger(details.exitCode) ? Number(details.exitCode) : undefined;
  return new ExchangeError(code, exitCode);
}
function sameGeneration(a: IntercomExchange["generation"], b: IntercomExchange["generation"]): boolean {
  return a.edgeEpoch === b.edgeEpoch && a.channel === b.channel && a.generation === b.generation;
}

/** A successful return is a complete, validated exit-zero outcome from the enrolled peer. */
export async function exchange(peer: Peer, input: ExchangeRequest, ports: ExchangePorts): Promise<ExchangeReply> {
  if (!isMachineId(ports.machineId) || !ports.enrollment || !samePeer(peer, ports.enrollment.peer) ||
      typeof ports.enrollment.edgeEpoch !== "string" || !ports.enrollment.edgeEpoch) return bad("machine-not-enrolled");
  if (!Number.isSafeInteger(ports.clock.now()) || !Number.isSafeInteger(input.holdMs) || input.holdMs < 0 || input.holdMs > 25_000) return bad("invalid-request");
  let outgoing: IntercomExchange;
  try { outgoing = decodeExchange(encodeExchange(input.exchange)); } catch { return bad("invalid-request"); }
  if (outgoing.senderMachine !== ports.machineId || outgoing.recipientMachine !== peer.machineId || outgoing.generation.edgeEpoch !== ports.enrollment.edgeEpoch) return bad("machine-mismatch");
  const currentGeneration = () => ports.store.edgeState(peer.machineId, ports.enrollment.edgeEpoch).outbound[outgoing.generation.channel] === outgoing.generation.generation;
  if (!currentGeneration()) return bad("stale-generation");
  if (outgoing.generation.channel === "push" && input.holdMs !== 0 || ports.probe && input.holdMs !== 0) return bad("invalid-request");
  const poll = outgoing.generation.channel === "poll" && !ports.probe;
  const total = ports.probe ? 10_000 : poll ? 45_000 : 20_000;
  const reserve = ports.probe ? 2000 : 5000;
  const remoteTimeoutMs = ports.probe ? 5000 : poll ? 30_000 : 10_000;
  if (ports.maxTotalMs !== undefined && (!Number.isSafeInteger(ports.maxTotalMs) || ports.maxTotalMs <= 0)) return bad("invalid-request");
  const timeoutMs = Math.min(total, ports.maxTotalMs ?? total);
  if (timeoutMs < reserve + 1000) return bad("cli-timeout");
  const stdinForTimeout = (remoteMs: number): Buffer => {
    const request = { version: 1, exchange: outgoing, holdMs: poll ? Math.min(input.holdMs, Math.max(0, remoteMs - 5000)) : 0, deadlineMs: remoteMs };
    const bytes = Buffer.from(JSON.stringify(request));
    // Leave room for broker framing, request IDs, and the helper's outer envelope.
    if (bytes.length > INTERCOM_EXCHANGE_BYTES - 1024) return bad("exchange-too-large");
    return bytes;
  };
  let bytes: Buffer;
  try {
    bytes = await ports.transport.exec(peer, ["roam", "intercom", "exchange"], { timeoutMs, maxBytes: INTERCOM_EXCHANGE_BYTES,
      remoteTimeoutMs, postReserveMs: reserve, stdinForTimeout, signal: ports.signal, onConnected: ports.onConnected });
  } catch (error) { throw safeError(error); }
  if (!currentGeneration()) return bad("stale-generation");
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > INTERCOM_EXCHANGE_BYTES) return bad("invalid-reply");
  let envelope: unknown;
  try { envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; } catch { return bad("invalid-reply"); }
  if (!record(envelope) || envelope.version !== 1 || envelope.kind !== "intercom-exchange") return bad("invalid-reply");
  if (envelope.ok === false && exact(envelope, ["version", "kind", "ok", "reason"]) && typeof envelope.reason === "string") {
    return bad(errors.has(envelope.reason) ? envelope.reason : "exchange-failed");
  }
  if (envelope.ok !== true || !exact(envelope, ["version", "kind", "ok", "value"]) || !record(envelope.value) ||
      !exact(envelope.value, ["version", "exchange"]) || envelope.value.version !== 1) return bad("invalid-reply");
  let received: IntercomExchange;
  try { received = decodeExchange(Buffer.from(JSON.stringify(envelope.value.exchange))); } catch { return bad("invalid-reply"); }
  if (received.senderMachine !== peer.machineId || received.recipientMachine !== ports.machineId) return bad("machine-mismatch");
  if (!sameGeneration(received.generation, outgoing.generation)) return bad("invalid-reply");
  return { version: 1, exchange: received };
}
