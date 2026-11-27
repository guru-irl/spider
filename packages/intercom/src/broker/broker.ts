import { createFederation } from "./federation.js";
import { parseV0BrokerReply, parseV0BrokerRequest, v0ExplicitName, v0TextFits, V0_ASK_MAX_MS, V0_INTERCOM_FEATURE, type V0Delivery, type V0Endpoint } from "../roam-v0.js";
import { parseRelayBrokerRequest, relayRefused, RELAY_BROKER_FEATURE, type RelayBrokerRequest } from "../relay-protocol.js";
import { createRelayLinks } from "./relay-links.js";
import { MOVE_FENCE_FEATURE, type IntercomIntakeAction, type IntercomIntakeFence } from "../protocol.js";
import { isIntercomIntakeAction, isIntercomIntakeFence } from "./protocol.js";
import { RECEIPT_ACK_FEATURE, RECEIPT_EVIDENCE_FEATURE, compatibleReceipt, FEDERATION_FEATURE, FREEZE_BLOCKERS_FEATURE, FEDERATION_NOTICE_ACK_FEATURE, HELPER_EXCHANGE_FEATURE, isHelperExchangeError, addressKey, sessionAddress, type SessionAddress, type RemoteSessionInfo, type FederationDispatchResult, type FederationBrokerMessage, type SessionEndpoint, type LocalSessionInfo } from "../protocol.js";
import { isRemoteSessionInfo, isSessionAddress, isSessionEndpoint, isFederationDispatchResult, isMessageControl, isConsumptionReceipt } from "./protocol.js";
import net from "net";
import { performance } from "node:perf_hooks";
import { constants, closeSync, fstatSync, lstatSync, openSync, realpathSync, chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { createHash, randomUUID, timingSafeEqual } from "crypto";
import { writeMessage, createMessageReader } from "./framing.js";
import { isMessage, isMessageReceipt, isSessionId, isSessionRegistration } from "./protocol.js";
import {
  ensureIntercomRuntimeDir,
  getBrokerListenTarget,
  getAgentDirPath,
  getBrokerPortFilePath,
  getIntercomDirPath,
  INTERCOM_DIR_MODE,
  INTERCOM_PROTOCOL_NAME,
  INTERCOM_PROTOCOL_VERSION,
  INTERCOM_RUNTIME_FILE_MODE,
  restrictIntercomRuntimeFile,
  type BrokerConnectTarget,
} from "./paths.js";
import { getAskTimeoutMs } from "../config.js";
import { sameCwd } from "../cwd.js";
import { EXACT_SEND_FEATURE, EXTENSION_BUS_FEATURE } from "../types.js";
import type { DeliveryState, SessionInfo, Message, MessageReceipt, BrokerMessage, ExtensionCapability, MessageControl } from "../types.js";
import { ExtensionStateManager } from "./extension-state.js";
import { assertNoLiveBroker } from "./runtime-claim.js";

const INTERCOM_DIR = getIntercomDirPath();
const LISTEN_TARGET = getBrokerListenTarget();
const PID_PATH = join(INTERCOM_DIR, "broker.pid");
const PORT_PATH = getBrokerPortFilePath(INTERCOM_DIR);
const PENDING_ASKS_DIR = join(INTERCOM_DIR, "pending-asks");
const BROKER_STATE_ID = randomUUID();
const MAX_SESSIONS = 128;
const MAX_UNREGISTERED_CONNECTIONS = 32;
const REGISTRATION_TIMEOUT_MS = 1000;
const RATE_LIMIT_CAPACITY = 240;
const RATE_LIMIT_REFILL_PER_SECOND = 120;
const PRESENCE_HEARTBEAT_MS = 1000;
const MAX_EXTENSIONS_PER_SESSION = 32;
const MAX_EXTENSION_MESSAGE_BYTES = 16 * 1024;
const MAX_EXTENSION_STATE_BYTES = 64 * 1024;
const MAX_HELPER_EXCHANGE_BYTES = 512 * 1024;
const MAX_HELPER_DEADLINE_MS = 30_000;
const MESSAGE_RECEIPT_ROUTE_RETENTION_MS = 60 * 60 * 1000;
const DISCONNECTED_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAILBOX_MESSAGE_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_MAILBOX_MESSAGES = 256;
const DELIVERY_RECORD_RETENTION_MS = 60 * 60 * 1000;
const MAX_DELIVERY_RECORDS = 4096;

function serializedPayloadSize(payload: unknown): number | null {
  try {
    const json = JSON.stringify(payload);
    return json === undefined ? null : Buffer.byteLength(json, "utf8");
  } catch {
    return null;
  }
}

function writeRelayFrames(socket: net.Socket, signal: AbortSignal, frames: readonly unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const closed = new Error("Private relay socket closed before reply");
    if (signal.aborted || socket.destroyed || !socket.writable) { reject(closed); return; }
    const abort = () => reject(closed);
    signal.addEventListener("abort", abort, { once: true });
    try {
      for (const frame of frames) writeMessage(socket, frame);
      socket.end(() => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted || socket.errored) reject(closed);
        else resolve();
      });
    } catch (error) {
      signal.removeEventListener("abort", abort);
      reject(error);
    }
  });
}

interface ConnectedSession {
  socket: net.Socket;
  info: LocalSessionInfo;
  key: string;
  scopeId?: string;
  lastPresenceBroadcastAt: number;
  ownerOrder: number;
  extensions?: ExtensionCapability[];
  federation: boolean;
  receiptEvidence: boolean;
  receiptAck: boolean;
}

interface DeliveryRecord {
  fingerprint: string;
  state: DeliveryState;
  reason?: string;
  code?: string;
  retryable: boolean;
  outcomeKnown: boolean;
  createdAt: number;
}

interface NamespaceOwner {
  namespace: string;
  sessionKey: string;
  sessionId: string;
  socket: net.Socket;
  epoch: string;
  scopeId?: string;
}

interface ConnectionState {
  socket: net.Socket;
  tokens: number;
  lastRefillAt: number;
}

interface AskEdge {
  from: string;
  to: string;
  scopeId?: string;
  createdAt: number;
}

type V0AskRoute = {
  targetKey: string;
  targetAddress: SessionAddress;
  endpointEpoch: string;
  askerId: string;
} & (
  | { state: "waiting"; socket: net.Socket; targetSocket: net.Socket; requestId: string; timer: NodeJS.Timeout }
  | { state: "closed"; closedAt: number }
);

interface PendingAskRecord {
  askId: string;
  messageId: string;
  asker: { sessionId: string; name: string | null };
  target: { sessionId: string; name: string | null };
  question: string;
  createdAt: number;
  expiresAt: number;
}

interface MessageReceiptRoute {
  from: string;
  to: string;
  createdAt: number;
}

interface DisconnectedSession {
  info: LocalSessionInfo;
  key: string;
  scopeId?: string;
  disconnectedAt: number;
}

interface MailboxMessage {
  from: SessionInfo;
  fromKey: string;
  fromScopeId?: string;
  target: LocalSessionInfo;
  targetKey: string;
  targetScopeId?: string;
  message: Message;
  queuedAt: number;
}

function normalizeScopeId(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("Invalid register scopeId");
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function sameScope(a: string | undefined, b: string | undefined): boolean {
  return a === b;
}

function scopedSessionKey(scopeId: string | undefined, sessionId: string): string {
  return JSON.stringify([scopeId ?? null, sessionId]);
}

function scopedExtensionKey(scopeId: string | undefined, namespace: string): string {
  return JSON.stringify([scopeId ?? null, namespace]);
}

function scopedExtensionStateNamespace(scopeId: string | undefined, namespace: string): string {
  if (!scopeId) {
    return namespace;
  }
  return JSON.stringify(["scope", createHash("sha256").update(scopeId).digest("hex"), namespace]);
}

function scopedPendingAskRecordPath(scopeId: string | undefined, messageId: string): string {
  if (!scopeId) {
    return pendingAskRecordPath(messageId);
  }
  const scopeHash = createHash("sha256").update(scopeId).digest("hex");
  return join(PENDING_ASKS_DIR, `${scopeHash}-${encodeURIComponent(messageId)}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPendingAskRecord(value: unknown): value is PendingAskRecord {
  if (!isRecord(value) || !isRecord(value.asker) || !isRecord(value.target)) {
    return false;
  }
  return typeof value.askId === "string"
    && typeof value.messageId === "string"
    && typeof value.asker.sessionId === "string"
    && (typeof value.asker.name === "string" || value.asker.name === null)
    && typeof value.target.sessionId === "string"
    && (typeof value.target.name === "string" || value.target.name === null)
    && typeof value.question === "string"
    && Number.isSafeInteger(value.createdAt)
    && Number.isSafeInteger(value.expiresAt)
    && (value.expiresAt as number) >= (value.createdAt as number);
}

function pendingAskRecordPath(messageId: string): string {
  return join(PENDING_ASKS_DIR, `${encodeURIComponent(messageId)}.json`);
}

function ensurePendingAskRecordDir(): void {
  mkdirSync(PENDING_ASKS_DIR, { recursive: true, mode: INTERCOM_DIR_MODE });
  if (process.platform !== "win32") {
    chmodSync(PENDING_ASKS_DIR, INTERCOM_DIR_MODE);
  }
}

class IntercomBroker {
  private authorizeBridge(claim: Record<string, unknown>): void {
    const privateDirectory = (directory: string) => {
      const info = lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== directory ||
          typeof process.getuid === "function" && info.uid !== process.getuid() || (info.mode & 0o7777) !== 0o700) throw new Error("bridge-unauthorized");
    };
    const privateJson = (file: string): Record<string, unknown> => {
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024 || (info.mode & 0o7777) !== 0o600 ||
            typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("bridge-unauthorized");
        const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
        if (!isRecord(value)) throw new Error("bridge-unauthorized");
        return value;
      } finally { closeSync(fd); }
    };
    try {
      privateDirectory(INTERCOM_DIR);
      const authority = privateJson(join(INTERCOM_DIR, "bridge-authority.json"));
      if (authority.version !== 1 || authority.machineId !== claim.machineId || typeof authority.root !== "string" ||
          !isAbsolute(authority.root) || resolve(authority.root) !== realpathSync(authority.root)) throw new Error("bridge-unauthorized");
      privateDirectory(join(authority.root, "roam"));
      const config = privateJson(join(authority.root, "roam", "config.json"));
      if (config.machineId !== claim.machineId || !isRecord(config.intercom) || config.intercom.enabled !== true) throw new Error("federation-disabled");
      if (typeof claim.credential !== "string" || !/^[0-9a-f]{64}$/.test(claim.credential) ||
          typeof authority.credential !== "string" || !/^[0-9a-f]{64}$/.test(authority.credential) ||
          !timingSafeEqual(Buffer.from(claim.credential), Buffer.from(authority.credential))) throw new Error("bridge-unauthorized");
    } catch { throw new Error("bridge-unauthorized"); }
  }
  private sessions = new Map<string, ConnectedSession>();
  private bridgeSocket: net.Socket | null = null;
  private bridgeMachineId: string | null = null;
  private bridgeMachineAlias: string | null = null;
  private intakeState?: {
    fences: Map<string, { fence: IntercomIntakeFence; closed: boolean }>;
    pending: Map<string, { socket: net.Socket; requestId: string; action: IntercomIntakeAction; fence: IntercomIntakeFence; timer: ReturnType<typeof setTimeout> }>;
  };
  private detachBridge: (() => void) | null = null;
  private bridgePending = new Map<string, { resolve(value: FederationDispatchResult): void; timer: NodeJS.Timeout }>();
  private noticePending = new Map<string, { bridge: net.Socket; receiver: net.Socket; timer: NodeJS.Timeout }>();
  private helperToken: string | null = null;
  private helperNegotiated = new Set<net.Socket>();
  private v0Requests = new Set<net.Socket>();
  private relayLinks = createRelayLinks({ now: () => performance.now(), wallNow: Date.now, later(ms, fn) {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return () => clearTimeout(timer);
  } });
  private v0Asks = new Map<string, V0AskRoute>();
  private helpers = new Set<net.Socket>();
  private helperPending = new Map<string, { socket: net.Socket; requestId: string; timer: NodeJS.Timeout }>();
  private remoteRoutes = new Map<string, { createdAt: number; from: SessionAddress; to: RemoteSessionInfo }>();
  private inboundRemoteRoutes = new Map<string, { createdAt: number; from: RemoteSessionInfo; to: SessionAddress }>();
  private restoredReceipts = new Map<string, { from: SessionAddress; receipt: MessageReceipt; at: number }>();
  private unobservedLocalReceipts = new Map<string, { from: SessionAddress; to: SessionAddress; activationEpoch: string; unknown: boolean; createdAt: number }>();
  private federation = createFederation({ agentDir: getAgentDirPath(), locals: () => [...this.sessions.values()].map(session => sessionAddress(session.info, session.scopeId ?? null)),
    canSupersedeLocal: entry => {
      const local = [...this.sessions.values()].find(session => addressKey(sessionAddress(session.info, session.scopeId ?? null)) === addressKey(entry.address));
      return !!local && entry.machineId !== this.bridgeMachineId && entry.homeEpoch !== null && entry.homeEpoch > (local.info.homeEpoch ?? 0);
    }, now: () => Date.now() });
  private askEdges = new Map<string, AskEdge>();
  private messageReceiptRoutes = new Map<string, MessageReceiptRoute>();
  private disconnectedSessions = new Map<string, DisconnectedSession>();
  private mailboxMessages: MailboxMessage[] = [];
  private deliveryRecords = new Map<string, DeliveryRecord>();
  private connections = new Set<net.Socket>();
  private unregisteredConnections = new Set<net.Socket>();
  private server: net.Server;
  private shutdownTimer: NodeJS.Timeout | null = null;
  private readonly askTimeoutMs = getAskTimeoutMs();
  private namespaceOwners = new Map<string, NamespaceOwner>();
  private nextOwnerOrder = 1;
  private extensionStateManager: ExtensionStateManager;

  constructor() {
    ensureIntercomRuntimeDir(INTERCOM_DIR);
    assertNoLiveBroker(PID_PATH);
    ensurePendingAskRecordDir();
    this.prunePendingAskRecords();
    this.extensionStateManager = new ExtensionStateManager(INTERCOM_DIR);
    if (typeof LISTEN_TARGET === "string" && process.platform !== "win32") {
      try {
        unlinkSync(LISTEN_TARGET);
      } catch {
        // A clean startup has no stale socket to remove.
      }
    }
    this.server = net.createServer(this.handleConnection.bind(this));
  }

  start(): void {
    const onListening = () => {
      if (typeof LISTEN_TARGET === "string") {
        restrictIntercomRuntimeFile(LISTEN_TARGET);
      } else {
        const address = this.server.address();
        if (!address || typeof address === "string") {
          throw new Error("Intercom TCP broker started without a TCP address");
        }
        const endpoint: BrokerConnectTarget = {
          transport: "tcp",
          host: LISTEN_TARGET.host,
          port: address.port,
          stateId: BROKER_STATE_ID,
        };
        writeFileSync(PORT_PATH, `${JSON.stringify(endpoint)}\n`, { mode: INTERCOM_RUNTIME_FILE_MODE });
        restrictIntercomRuntimeFile(PORT_PATH);
      }
      writeFileSync(PID_PATH, String(process.pid), { mode: INTERCOM_RUNTIME_FILE_MODE });
      restrictIntercomRuntimeFile(PID_PATH);
      console.log(`Intercom broker started (pid: ${process.pid})`);
      this.scheduleShutdownCheck();
    };

    if (typeof LISTEN_TARGET === "string") {
      this.server.listen(LISTEN_TARGET, onListening);
    } else {
      this.server.listen({ host: LISTEN_TARGET.host, port: LISTEN_TARGET.port }, onListening);
    }
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
  }

  private handleConnection(socket: net.Socket): void {
    this.connections.add(socket);
    let sessionKey: string | null = null;
    let registrationTimeout: NodeJS.Timeout | null = null;
    const armRegistrationTimeout = () => {
      if (registrationTimeout) {
        clearTimeout(registrationTimeout);
      }
      this.unregisteredConnections.delete(socket);
      this.unregisteredConnections.add(socket);
      this.evictOldestUnregisteredConnections(socket);
      registrationTimeout = setTimeout(() => {
        if (!sessionKey) {
          socket.destroy();
        }
      }, REGISTRATION_TIMEOUT_MS);
      registrationTimeout.unref?.();
    };
    const clearRegistrationTimeout = () => {
      if (registrationTimeout) {
        clearTimeout(registrationTimeout);
        registrationTimeout = null;
      }
      this.unregisteredConnections.delete(socket);
    };
    armRegistrationTimeout();
    const holdV0Connection = () => clearRegistrationTimeout();
    let relayAbort: AbortController | undefined;
    const holdRelayConnection = () => {
      clearRegistrationTimeout();
      relayAbort = new AbortController();
      return relayAbort.signal;
    };
    const connection: ConnectionState = {
      socket,
      tokens: RATE_LIMIT_CAPACITY,
      lastRefillAt: Date.now(),
    };

    const reader = createMessageReader((msg) => {
      if (!this.consumeToken(connection)) {
        writeMessage(socket, { type: "error", error: "Intercom broker rate limit exceeded" });
        socket.destroy(new Error("Intercom broker rate limit exceeded"));
        return;
      }
      this.handleMessage(socket, msg, sessionKey, (id) => {
        sessionKey = id;
        if (id) {
          clearRegistrationTimeout();
        } else {
          armRegistrationTimeout();
        }
      }, holdV0Connection, holdRelayConnection);
    }, (error) => {
      socket.destroy(error);
    });

    socket.on("data", reader);

    socket.on("close", () => {
      relayAbort?.abort();
      clearRegistrationTimeout();
      this.connections.delete(socket);
      this.helperNegotiated.delete(socket);
      this.v0Requests.delete(socket);
      for (const [id, ask] of this.v0Asks) {
        if (ask.state !== "waiting") continue;
        if (ask.socket === socket) this.finishV0Ask(id);
        else if (ask.targetSocket === socket) this.finishV0Ask(id, { kind: "no_reply", id });
      }
      this.helpers.delete(socket);
      for (const [id, pending] of this.noticePending) {
        if (pending.bridge !== socket && pending.receiver !== socket) continue;
        clearTimeout(pending.timer); this.noticePending.delete(id);
        if (pending.bridge !== socket && !pending.bridge.destroyed) writeMessage(pending.bridge, { type: "federation_notice_result", requestId: id, confirmed: false });
      }
      for (const [id, pending] of this.helperPending) {
        if (pending.socket === socket) { clearTimeout(pending.timer); this.helperPending.delete(id); this.writeBridge({ type: "federation_helper_cancel", requestId: id }); }
      }
      if (this.bridgeSocket === socket) {
        this.detachBridge?.(); this.detachBridge = null; this.bridgeSocket = null; this.bridgeMachineId = null; this.helperToken = null;
        for (const { socket: helper, requestId, timer } of this.helperPending.values()) {
          clearTimeout(timer); if (!helper.destroyed) writeMessage(helper, { type: "helper_error", requestId, reason: "bridge-unavailable" });
        }
        this.helperPending.clear(); this.helpers.clear();
        for (const { resolve, timer } of this.bridgePending.values()) { clearTimeout(timer); resolve(this.unknownBridgeResult()); }
        this.bridgePending.clear(); this.scheduleShutdownCheck();
      }
      if (sessionKey) {
        const existing = this.sessions.get(sessionKey);
        if (existing?.socket === socket) {
          this.rememberDisconnectedSession(existing);
          this.sessions.delete(sessionKey);
          this.clearMessageReceiptRoutesForSession(sessionKey);
          this.broadcast({ type: "session_left", sessionId: existing.info.id }, sessionKey, existing.scopeId);
          this.recomputeNamespaceOwners();
          this.publishLocalPresence();
          this.scheduleShutdownCheck();
        }
      }
    });

    socket.on("error", (error) => {
      console.error("Socket error:", error);
    });
  }

  private pruneV0Asks(): void {
    const now = Date.now();
    for (const [id, ask] of this.v0Asks) {
      if (ask.state === "closed" && (now - ask.closedAt > MESSAGE_RECEIPT_ROUTE_RETENTION_MS || this.v0Asks.size > MAX_DELIVERY_RECORDS)) this.v0Asks.delete(id);
    }
  }

  private finishV0Ask(id: string, result?: V0Delivery): void {
    const ask = this.v0Asks.get(id);
    if (!ask || ask.state !== "waiting") return;
    clearTimeout(ask.timer);
    this.v0Asks.set(id, { state: "closed", targetKey: ask.targetKey, targetAddress: ask.targetAddress,
      endpointEpoch: ask.endpointEpoch, askerId: ask.askerId, closedAt: Date.now() });
    if (result && !ask.socket.destroyed && ask.socket.writable) {
      try { writeMessage(ask.socket, { type: "roam_v0_result", requestId: ask.requestId, ...result }); } catch { /* The requester is gone. */ }
    }
    if (!ask.socket.destroyed) ask.socket.destroySoon();
  }

  private handleV0Reply(socket: net.Socket, from: ConnectedSession, to: string, message: Message): boolean {
    if (!message.replyTo) return false;
    const localAsk = this.askEdges.get(message.replyTo);
    if (localAsk?.to === from.key && this.findSessions(to, from.scopeId).some(target => target.key === localAsk.from)) return false;
    this.pruneV0Asks();
    const ask = this.v0Asks.get(message.replyTo);
    if (!ask) {
      if (from.info.v0HomeEpoch !== undefined && !this.askEdges.has(message.replyTo) && !this.inboundRemoteRoutes.has(message.replyTo)) {
        this.writeDeliveryFailure(socket, message.id, "The asker is no longer waiting.", "E_REPLY_TARGET");
        return true;
      }
      return false;
    }
    const fail = (reason: string, code = "E_REPLY_TARGET") => this.writeDeliveryFailure(socket, message.id, reason, code);
    if (ask.targetKey !== from.key || addressKey(ask.targetAddress) !== addressKey(sessionAddress(from.info, from.scopeId ?? null)) || to !== ask.askerId) {
      fail("Reply target does not match the pending ask"); return true;
    }
    if (ask.state === "closed" || ask.socket.destroyed || !ask.socket.writable) {
      if (ask.state === "waiting") this.finishV0Ask(message.replyTo);
      fail("The asker is no longer waiting."); return true;
    }
    if (from.socket !== ask.targetSocket || from.info.endpointEpoch !== ask.endpointEpoch) {
      fail("Reply target does not match the pending ask"); return true;
    }
    const response = { type: "roam_v0_result", requestId: ask.requestId, kind: "replied", id: message.replyTo,
      replyId: message.id, text: message.content.text };
    if (message.content.attachments !== undefined || message.expectsReply || message.supersedes || message.retryOf || message.provenance ||
        !parseV0BrokerReply(response)) {
      fail(v0TextFits(response.text) ? "Invalid remote reply" : "Remote reply text is too large.", "E_INVALID_MESSAGE"); return true;
    }
    try {
      writeMessage(ask.socket, response);
      this.finishV0Ask(message.replyTo);
      this.writeDeliverySuccess(socket, message.id, "socket_delivered");
    } catch {
      this.finishV0Ask(message.replyTo);
      fail("The asker is no longer waiting.");
    }
    return true;
  }

  private unknownBridgeResult(): FederationDispatchResult {
    return { delivery: "unknown", retryable: false, outcomeKnown: false, acceptance: { accepted: false, durable: false }, reason: "bridge-dispatch-unknown" };
  }
  private writeBridge(message: FederationBrokerMessage): void {
    if (this.bridgeSocket && !this.bridgeSocket.destroyed) writeMessage(this.bridgeSocket, message);
  }
  private forwardLocalReceipt(from: SessionAddress, receipt: MessageReceipt): void {
    if (isConsumptionReceipt(receipt) && receipt.evidence?.sessionId === from.sessionId) {
      const safe: MessageReceipt = { messageId: receipt.messageId, status: receipt.status, timestamp: receipt.timestamp, evidence: receipt.evidence };
      const key = JSON.stringify([addressKey(from), safe.messageId, safe.status, safe.evidence?.activationEpoch]);
      this.restoredReceipts.set(key, { from: { ...from }, receipt: safe, at: Date.now() });
      while (this.restoredReceipts.size > MAX_DELIVERY_RECORDS) this.restoredReceipts.delete(this.restoredReceipts.keys().next().value!);
    }
    if (this.bridgeSocket) this.federation.receipt(from, receipt);
  }
  private publishLocalPresence(): void {
    this.writeBridge({ type: "federation_local_presence", sessions: [...this.sessions.values()].filter(session => session.federation).map(session => ({ address: sessionAddress(session.info, session.scopeId ?? null), startedAt: session.info.startedAt, lastActivity: session.info.lastActivity, homeEpoch: session.info.homeEpoch ?? null, activationEpoch: session.info.activationEpoch ?? session.info.endpointEpoch!, cwd: session.info.cwd, model: session.info.model, ...(session.info.name ? { name: session.info.name } : {}), ...(session.info.status ? { status: session.info.status } : {}) })) });
  }
  private inspectBlockers(address: SessionAddress, includeExpired = false) {
    const now = Date.now(), result = this.federation.inspectBlockers(address, { includeExpired });
    const key = this.localForAddress(address)?.key ?? addressKey(address);
    const receipts = [...this.unobservedLocalReceipts.entries()].filter(([, route]) => includeExpired || now - route.createdAt <= MESSAGE_RECEIPT_ROUTE_RETENTION_MS);
    const visibleReceipts = includeExpired ? receipts : receipts.slice(-MAX_DELIVERY_RECORDS);
    return { ...result,
      asks: [...result.asks, ...[...this.askEdges.entries()].filter(([, edge]) => (includeExpired || now - edge.createdAt <= this.askTimeoutMs) && (edge.from === key || edge.to === key)).map(([id, edge]) => ({ id, from: this.addressFromKey(edge.from), to: this.addressFromKey(edge.to) }))],
      pendingDispatch: [...result.pendingDispatch, ...this.mailboxMessages.filter(entry => entry.fromKey === key || entry.targetKey === key).map(entry => entry.message.id)],
      unobservedReceipts: [...result.unobservedReceipts, ...visibleReceipts.filter(([, route]) => addressKey(route.from) === addressKey(address) || addressKey(route.to) === addressKey(address)).map(([id]) => id)],
      unknownOutcomes: [...result.unknownOutcomes, ...visibleReceipts.filter(([, route]) => route.unknown && (addressKey(route.from) === addressKey(address) || addressKey(route.to) === addressKey(address))).map(([id]) => id)],
    };
  }
  private localForAddress(address: SessionAddress): ConnectedSession | undefined {
    return [...this.sessions.values()].find(session => addressKey(sessionAddress(session.info, session.scopeId ?? null)) === addressKey(address));
  }
  private addressFromKey(key: string): SessionAddress {
    const local = this.sessions.get(key);
    if (local) return sessionAddress(local.info, local.scopeId ?? null);
    const [scopeId, sessionId] = JSON.parse(key) as [string | null, string];
    return { sessionId, scopeId };
  }
  private intakeClosed(address: SessionAddress): boolean {
    return this.intakeState?.fences.get(addressKey(address))?.closed === true;
  }
  private sameIntake(a: IntercomIntakeFence, b: IntercomIntakeFence): boolean {
    return addressKey(a.address) === addressKey(b.address) && a.moveId === b.moveId && a.expectedEpoch === b.expectedEpoch && a.generation === b.generation;
  }
  private handleIntake(socket: net.Socket, message: Record<string, unknown>): boolean {
    if (message.type !== "federation_intake" && message.type !== "federation_intake_applied") return false;
    if (!this.intakeState || typeof message.requestId !== "string" || !message.requestId) throw new Error("intercom-fence-unsupported");
    const state = this.intakeState;
    if (message.type === "federation_intake_applied") {
      if (!(message.generation === null || typeof message.generation === "string" && message.generation)) throw new Error("invalid-intake-result");
      const pending = state.pending.get(message.requestId);
      if (!pending) return true;
      clearTimeout(pending.timer); state.pending.delete(message.requestId);
      const current = state.fences.get(addressKey(pending.fence.address));
      const matched = message.generation === pending.fence.generation && current && this.sameIntake(current.fence, pending.fence);
      if (matched && pending.action === "open") current.closed = false;
      if (!pending.socket.destroyed) writeMessage(pending.socket, { type: "intake_result", requestId: pending.requestId, generation: matched ? pending.fence.generation : null });
      return true;
    }
    if (!isIntercomIntakeAction(message.action) || !isIntercomIntakeFence(message.fence)) throw new Error("invalid-intake-request");
    const fence = message.fence, key = addressKey(fence.address), current = state.fences.get(key);
    const replacing = message.action === "close" && current && !current.closed && fence.expectedEpoch >= current.fence.expectedEpoch && fence.moveId !== current.fence.moveId;
    if (current && !this.sameIntake(current.fence, fence) && !replacing || message.action !== "close" && !current ||
        message.action === "check" && current?.closed !== true) {
      writeMessage(socket, { type: "intake_result", requestId: message.requestId, generation: null }); return true;
    }
    // This synchronous transition is the socket-dispatch linearization point.
    if (message.action === "close") state.fences.set(key, { fence, closed: true });
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      state.pending.delete(requestId);
      if (!socket.destroyed) writeMessage(socket, { type: "intake_result", requestId: message.requestId, generation: null });
    }, 4000);
    timer.unref(); state.pending.set(requestId, { socket, requestId: message.requestId, action: message.action, fence, timer });
    this.writeBridge({ type: "federation_intake_apply", requestId, action: message.action, fence });
    return true;
  }
  private handleBridgeMessage(socket: net.Socket, message: Record<string, unknown>): void {
    if (this.handleIntake(socket, message)) return;
    if (message.type !== "inspect_blockers") this.pruneMessageReceiptRoutes();
    switch (message.type) {
      case "helper_authorize": {
        if (typeof message.requestId !== "string" || !message.requestId || typeof message.token !== "string" || !/^[0-9a-f]{64}$/.test(message.token)) throw new Error("invalid-helper-authorization");
        this.helperToken = message.token;
        for (const helper of this.helpers) helper.destroy();
        this.helpers.clear();
        writeMessage(socket, { type: "helper_authorized", requestId: message.requestId });
        return;
      }
      case "federation_helper_result": {
        if (typeof message.requestId !== "string") throw new Error("invalid-helper-result");
        const pending = this.helperPending.get(message.requestId);
        if (!pending) return;
        clearTimeout(pending.timer); this.helperPending.delete(message.requestId);
        if (pending.socket.destroyed) return;
        const result = message.error === undefined ? { type: "helper_result", requestId: pending.requestId, output: message.output }
          : { type: "helper_error", requestId: pending.requestId, reason: isHelperExchangeError(message.error) ? message.error : "bridge-exchange-failed" };
        const size = serializedPayloadSize(result);
        if (size === null || size > MAX_HELPER_EXCHANGE_BYTES) writeMessage(pending.socket, { type: "helper_error", requestId: pending.requestId, reason: "exchange-too-large" });
        else writeMessage(pending.socket, result);
        return;
      }
      case "federation_presence": {
        if (!Array.isArray(message.sessions) || !message.sessions.every(isRemoteSessionInfo)) throw new Error("invalid-remote-presence");
        this.federation.publishPresence(message.sessions);
        return;
      }
      case "federation_result": {
        if (typeof message.requestId !== "string" || !isFederationDispatchResult(message.result)) throw new Error("invalid-federation-result");
        const pending = this.bridgePending.get(message.requestId);
        if (pending) { clearTimeout(pending.timer); this.bridgePending.delete(message.requestId); pending.resolve(message.result); }
        return;
      }
      case "inspect_blockers": {
        if (typeof message.requestId !== "string" || !isSessionAddress(message.address) || message.includeExpired !== undefined && typeof message.includeExpired !== "boolean") throw new Error("invalid-blocker-query");
        writeMessage(socket, { type: "blockers", requestId: message.requestId, blockers: this.inspectBlockers(message.address, message.includeExpired === true) });
        return;
      }
      case "federation_deliver": {
        if (typeof message.requestId !== "string" || !isRemoteSessionInfo(message.from) || !isMessage(message.message) || !isSessionEndpoint(message.to)) throw new Error("invalid-federation-delivery");
        const to = message.to;
        const target = this.localForAddress(to.address);
        let result: FederationDispatchResult;
        if (this.intakeClosed(to.address)) {
          result = { delivery: "failed", code: "E_INTERCOM_FROZEN", retryable: true, outcomeKnown: true, acceptance: { accepted: false, durable: false }, reason: "intercom-frozen" };
        } else if (!target?.federation || to.machineId !== this.bridgeMachineId || to.homeEpoch !== (target.info.homeEpoch ?? null) || to.activationEpoch !== (target.info.activationEpoch ?? target.info.endpointEpoch) || message.from.address.scopeId !== to.address.scopeId) {
          result = { delivery: "failed", code: "E_TARGET_REBOUND", retryable: true, outcomeKnown: true, acceptance: { accepted: false, durable: false }, reason: "Target endpoint changed before delivery" };
        } else {
          try {
            this.federation.observeInbound(message.from.address, to.address, to.activationEpoch, message.message);
            this.inboundRemoteRoutes.set(message.message.id, { createdAt: Date.now(), from: message.from, to: to.address });
            writeMessage(target.socket, { type: "message", from: message.from, message: message.message });
            result = { delivery: "socket_delivered", retryable: false, outcomeKnown: true, acceptance: { accepted: true, durable: false } };
          } catch (error) {
            result = { delivery: "failed", code: "E_FEDERATION_REFUSED", retryable: false, outcomeKnown: true, acceptance: { accepted: false, durable: false }, reason: error instanceof Error ? error.message : "Remote delivery refused" };
          }
        }
        writeMessage(socket, { type: "federation_delivery_result", requestId: message.requestId, result });
        return;
      }
      case "federation_deliver_notice": {
        if (typeof message.requestId !== "string" || !/^[0-9a-f-]{36}$/.test(message.requestId) || !isRemoteSessionInfo(message.from) ||
            !isSessionAddress(message.to) || !isMessageReceipt(message.receipt) || message.receipt.status !== "cancelled" ||
            message.receipt.detail !== "peer-revoked" || message.from.address.scopeId !== message.to.scopeId || this.noticePending.has(message.requestId)) {
          throw new Error("invalid-federation-notice");
        }
        const id = message.requestId, target = this.localForAddress(message.to), route = this.remoteRoutes.get(message.receipt.messageId);
        if (route && (addressKey(route.from) !== addressKey(message.to) || addressKey(route.to.address) !== addressKey(message.from.address))) throw new Error("invalid-federation-receipt-route");
        if (!target?.federation || target.socket.destroyed || this.noticePending.size >= 256) {
          writeMessage(socket, { type: "federation_notice_result", requestId: id, confirmed: false }); return;
        }
        const timer = setTimeout(() => {
          this.noticePending.delete(id);
          if (!socket.destroyed) writeMessage(socket, { type: "federation_notice_result", requestId: id, confirmed: false });
        }, 3500); timer.unref();
        this.noticePending.set(id, { bridge: socket, receiver: target.socket, timer });
        try {
          this.federation.observeReceipt(message.from.address, message.receipt);
          writeMessage(target.socket, { type: "message_receipt", from: message.from, receipt: message.receipt, noticeId: id });
        } catch {
          clearTimeout(timer); this.noticePending.delete(id);
          writeMessage(socket, { type: "federation_notice_result", requestId: id, confirmed: false });
        }
        return;
      }
      case "federation_deliver_receipt":
      case "federation_deliver_control": {
        if (!isRemoteSessionInfo(message.from) || !isSessionAddress(message.to)) throw new Error("invalid-federation-recipient");
        const target = this.localForAddress(message.to);
        if (message.from.address.scopeId !== message.to.scopeId) throw new Error("federation-scope-mismatch");
        if (message.type === "federation_deliver_receipt") {
          if (!isMessageReceipt(message.receipt)) throw new Error("invalid-federation-receipt");
          const route = this.remoteRoutes.get(message.receipt.messageId);
          // The durable bridge can outlive this broker's transient route cache.
          if (route && (addressKey(route.from) !== addressKey(message.to) || addressKey(route.to.address) !== addressKey(message.from.address))) throw new Error("invalid-federation-receipt-route");
          // Apply evidence without reflecting the same receipt back to the bridge.
          this.federation.observeReceipt(message.from.address, message.receipt);
          if (message.receipt.status === "expired" || isConsumptionReceipt(message.receipt)) this.remoteRoutes.delete(message.receipt.messageId);
          if (target?.federation) writeMessage(target.socket, { type: "message_receipt", from: message.from, receipt: message.receipt });
        } else {
          if (!isMessageControl(message.control)) throw new Error("invalid-federation-control");
          const route = this.inboundRemoteRoutes.get(message.control.messageId);
          if (route && (addressKey(route.from.address) !== addressKey(message.from.address) || addressKey(route.to) !== addressKey(message.to))) throw new Error("invalid-federation-control-route");
          this.federation.observeControl(message.from.address, message.to, message.control);
          if (target?.federation) writeMessage(target.socket, { type: "message_control", from: message.from, control: message.control });
        }
        return;
      }
      default: throw new Error("invalid-bridge-operation");
    }
  }

  private evictOldestUnregisteredConnections(currentSocket: net.Socket): void {
    while (this.unregisteredConnections.size > MAX_UNREGISTERED_CONNECTIONS) {
      const [oldest] = this.unregisteredConnections;
      if (!oldest) {
        return;
      }
      if (oldest === currentSocket && this.unregisteredConnections.size === 1) {
        return;
      }
      this.unregisteredConnections.delete(oldest);
      oldest.destroy();
    }
  }

  private consumeToken(connection: ConnectionState, now = Date.now()): boolean {
    const elapsedMs = now - connection.lastRefillAt;
    if (elapsedMs > 0) {
      connection.tokens = Math.min(
        RATE_LIMIT_CAPACITY,
        connection.tokens + elapsedMs * RATE_LIMIT_REFILL_PER_SECOND / 1000,
      );
      connection.lastRefillAt = now;
    }
    if (connection.tokens < 1) {
      return false;
    }
    connection.tokens -= 1;
    return true;
  }

  private scheduleShutdownCheck(): void {
    if (this.shutdownTimer) return;

    this.shutdownTimer = setTimeout(() => {
      this.shutdownTimer = null;
      if (this.sessions.size === 0 && !this.bridgeSocket) {
        console.log("No sessions connected, shutting down");
        this.shutdown();
      }
    }, 5000);
  }

  private async handleRelay(socket: net.Socket, request: RelayBrokerRequest, signal: AbortSignal): Promise<void> {
    const { requestId } = request;
    switch (request.kind) {
      case "poll":
        await this.relayLinks.poll(request.poll, signal, ({ ready, submissions }) => writeRelayFrames(socket, signal, [
          { type: "roam_v0_relay_ready", requestId, ready, count: submissions.length },
          ...submissions.map(submit => ({ type: "roam_v0_relay_submission", requestId, submit })),
        ]));
        // A fenced call did not get as far as writing its reply.
        if (!socket.writableEnded) socket.destroy();
        return;
      case "list": {
        const links = this.relayLinks.list();
        await writeRelayFrames(socket, signal, [
          { type: "roam_v0_relay_links", requestId, count: links.length },
          ...links.map(link => ({ type: "roam_v0_relay_link", requestId, link })),
        ]);
        return;
      }
      case "submit": {
        const { from, message } = request.submit;
        const live = [...this.sessions.values()].some(session => session.info.address &&
          addressKey(session.info.address) === addressKey(from.address) && session.info.endpointEpoch === from.endpointEpoch &&
          session.info.v0HomeEpoch === from.homeEpoch && v0ExplicitName(session.info) === from.name &&
          !session.socket.destroyed && !session.socket.writableEnded && session.socket.writable);
        const result = live ? await this.relayLinks.submit(request.relayId, request.submit, signal, request.remainingMs)
          : relayRefused(message.id, "unauthorized");
        await writeRelayFrames(socket, signal, [{ type: "roam_v0_relay_result", requestId, result }]);
        return;
      }
    }
  }

  private handleMessage(
    socket: net.Socket,
    msg: unknown,
    currentKey: string | null,
    setKey: (key: string | null) => void,
    holdV0Connection: () => void,
    holdRelayConnection: () => AbortSignal,
  ): void {
    if (typeof msg !== "object" || msg === null || !("type" in msg) || typeof msg.type !== "string") {
      throw new Error("Invalid client message");
    }

    const clientMessage = msg as { type: string } & Record<string, unknown>;
    const requiresEndpointAuth = typeof LISTEN_TARGET !== "string";
    const hasEndpointAuth = clientMessage.stateId === BROKER_STATE_ID;

    if (this.v0Requests.has(socket)) throw new Error("roam-v0-one-request-only");
    if (clientMessage.type === "roam_v0_relay") {
      if (typeof LISTEN_TARGET !== "string" || currentKey !== null || !this.helperNegotiated.has(socket)) throw new Error("roam-v0-relay-private-socket-required");
      this.v0Requests.add(socket);
      const request = parseRelayBrokerRequest(msg);
      if (!request) throw new Error("invalid-roam-v0-relay-request");
      void this.handleRelay(socket, request, holdRelayConnection()).catch(() => socket.destroy());
      return;
    }
    if (clientMessage.type === "roam_v0") {
      if (typeof LISTEN_TARGET !== "string" || currentKey !== null || !this.helperNegotiated.has(socket)) throw new Error("roam-v0-private-socket-required");
      this.v0Requests.add(socket);
      const request = parseV0BrokerRequest(msg);
      if (!request) {
        const refusal = { type: "roam_v0_result", requestId: clientMessage.requestId, kind: "refused", code: "invalid" };
        if (!parseV0BrokerReply(refusal)) throw new Error("invalid-roam-v0-request");
        writeMessage(socket, refusal);
        return;
      }
      if (request.kind === "lookup") {
        const targets: V0Endpoint[] = [];
        for (const session of this.sessions.values()) {
          if (session.info.v0HomeEpoch === undefined || !session.info.address || session.socket.destroyed || !session.socket.writable ||
              (session.scopeId ?? null) !== request.scopeId) continue;
          const name = v0ExplicitName(session.info);
          if (request.selector.by === "id" ? session.info.address.sessionId !== request.selector.value
            : !name || name.toLowerCase() !== request.selector.value.toLowerCase()) continue;
          targets.push({ address: session.info.address, name, homeEpoch: session.info.v0HomeEpoch, endpointEpoch: session.info.endpointEpoch! });
        }
        const result = { type: "roam_v0_result", requestId: request.requestId, kind: "matches", targets };
        writeMessage(socket, parseV0BrokerReply(result) ? result : { type: "roam_v0_result", requestId: request.requestId, kind: "refused", code: "incomplete" });
        return;
      }
      const respond = (result: Record<string, unknown>) => writeMessage(socket, { type: "roam_v0_result", requestId: request.requestId, ...result });
      if (request.from.address.scopeId !== request.target.address.scopeId) {
        respond({ kind: "refused", code: "unauthorized" }); return;
      }
      const candidates = [...this.sessions.values()].filter(session => session.info.address &&
        addressKey(session.info.address) === addressKey(request.target.address));
      if (!candidates.length || candidates.every(session => session.socket.destroyed || session.socket.writableEnded || !session.socket.writable)) {
        respond({ kind: "refused", code: "offline" }); return;
      }
      const target = candidates.find(session => session.info.endpointEpoch === request.target.endpointEpoch &&
        session.info.v0HomeEpoch === request.target.homeEpoch &&
        v0ExplicitName(session.info) === request.target.name);
      if (!target) { respond({ kind: "refused", code: "changed" }); return; }
      if (target.socket.destroyed || target.socket.writableEnded || !target.socket.writable) {
        respond({ kind: "refused", code: "offline" }); return;
      }
      if (request.kind === "ask") {
        this.pruneV0Asks();
        if (this.v0Asks.has(request.message.id) || this.askEdges.has(request.message.id)) {
          respond({ kind: "refused", code: "invalid" }); return;
        }
        if ([...this.v0Asks.values()].filter(ask => ask.state === "waiting").length >= MAX_UNREGISTERED_CONNECTIONS) {
          respond({ kind: "refused", code: "unreachable" }); return;
        }
        const timeoutMs = Math.min(request.timeoutMs, V0_ASK_MAX_MS);
        const timer = setTimeout(() => this.finishV0Ask(request.message.id, { kind: "no_reply", id: request.message.id }), timeoutMs);
        timer.unref();
        this.v0Asks.set(request.message.id, { state: "waiting", socket, targetSocket: target.socket, requestId: request.requestId, timer,
          targetKey: target.key, targetAddress: request.target.address, endpointEpoch: request.target.endpointEpoch, askerId: request.from.id });
        holdV0Connection();
      }
      try {
        writeMessage(target.socket, { type: "message", from: request.from, message: {
          id: request.message.id, timestamp: request.message.timestamp, content: { text: request.message.text },
          ...(request.kind === "ask" ? { expectsReply: true, remainingMs: Math.min(request.timeoutMs, V0_ASK_MAX_MS) } : {}),
          brokerReceivedAt: Date.now(), brokerDeliveredAt: Date.now(),
        } });
        if (request.kind === "deliver") respond({ kind: "socket_delivered", id: request.message.id });
      } catch {
        if (request.kind === "ask") this.finishV0Ask(request.message.id, { kind: "unknown", id: request.message.id });
        else respond({ kind: "unknown", id: request.message.id });
      }
      return;
    }

    if (clientMessage.type === "health") {
      if (typeof clientMessage.requestId !== "string") {
        throw new Error("Invalid health message");
      }
      if (requiresEndpointAuth && !hasEndpointAuth) {
        throw new Error("Invalid intercom TCP endpoint credentials");
      }
      if (typeof LISTEN_TARGET === "string") this.helperNegotiated.add(socket);
      writeMessage(socket, {
        type: "health_ok",
        requestId: clientMessage.requestId,
        protocol: INTERCOM_PROTOCOL_NAME,
        version: INTERCOM_PROTOCOL_VERSION,
        ...(typeof LISTEN_TARGET === "string" ? { implementation: "spider", features: [HELPER_EXCHANGE_FEATURE, FEDERATION_NOTICE_ACK_FEATURE, FEDERATION_FEATURE, V0_INTERCOM_FEATURE, RELAY_BROKER_FEATURE] } : {}),
      });
      return;
    }

    if (requiresEndpointAuth && clientMessage.type === "register" && !hasEndpointAuth) {
      throw new Error("Invalid intercom TCP endpoint credentials");
    }

    if (clientMessage.type === "federation_register") {
      if (currentKey || this.bridgeSocket === socket || typeof LISTEN_TARGET !== "string") throw new Error("federation-private-socket-required");
      this.authorizeBridge(clientMessage);
      if (typeof clientMessage.agentDir !== "string" || typeof clientMessage.machineId !== "string" || !clientMessage.machineId || typeof clientMessage.machineAlias !== "string" || !clientMessage.machineAlias) throw new Error("invalid-bridge-registration");
      this.detachBridge = this.federation.registerBridge({ feature: String(clientMessage.feature), agentDir: clientMessage.agentDir, machineId: clientMessage.machineId, machineAlias: clientMessage.machineAlias }, {
        dispatch: frame => new Promise(resolve => {
          const requestId = randomUUID();
          const timer = setTimeout(() => { this.bridgePending.delete(requestId); resolve(this.unknownBridgeResult()); }, 10000);
          timer.unref(); this.bridgePending.set(requestId, { resolve, timer });
          this.writeBridge({ type: "federation_dispatch", requestId, dispatch: frame });
        }),
        receipt: (from, receipt) => this.writeBridge({ type: "federation_receipt", from, receipt }),
        control: (from, to, control) => this.writeBridge({ type: "federation_control", from, to, control }),
      });
      this.bridgeSocket = socket; this.bridgeMachineId = clientMessage.machineId; this.bridgeMachineAlias = clientMessage.machineAlias;
      setKey("federation-bridge");
      if (this.shutdownTimer) { clearTimeout(this.shutdownTimer); this.shutdownTimer = null; }
      if (clientMessage.moveFences !== undefined && clientMessage.moveFences !== true) throw new Error("invalid-intake-feature");
      if (clientMessage.moveFences === true) this.intakeState ??= { fences: new Map(), pending: new Map() };
      this.writeBridge({ type: "federation_registered", features: [FEDERATION_FEATURE, FREEZE_BLOCKERS_FEATURE, HELPER_EXCHANGE_FEATURE, FEDERATION_NOTICE_ACK_FEATURE,
        ...(clientMessage.moveFences === true ? [MOVE_FENCE_FEATURE] : [])] });
      this.publishLocalPresence();
      // A socket write does not prove that the bridge handled the evidence.
      for (const [key, item] of this.restoredReceipts) {
        if (Date.now() - item.at > DISCONNECTED_SESSION_RETENTION_MS) this.restoredReceipts.delete(key);
        else this.federation.receipt(item.from, item.receipt);
      }
      return;
    }
    if (this.bridgeSocket === socket) { this.handleBridgeMessage(socket, clientMessage); return; }
    if (clientMessage.type === "helper_register" || clientMessage.type === "helper_exchange" || clientMessage.type === "helper_authorize") {
      const requestId = typeof clientMessage.requestId === "string" && clientMessage.requestId.length <= 128 ? clientMessage.requestId : "";
      const refuse = (reason: string) => writeMessage(socket, { type: "helper_error", requestId, reason });
      if (clientMessage.type === "helper_register") {
        const token = clientMessage.token;
        if (currentKey || !this.helperNegotiated.has(socket) || !this.bridgeSocket || !this.helperToken || typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token) ||
            !timingSafeEqual(Buffer.from(token), Buffer.from(this.helperToken))) { refuse("helper-unauthorized"); return; }
        this.helpers.add(socket); setKey("federation-helper");
        writeMessage(socket, { type: "helper_registered", requestId });
        return;
      }
      if (clientMessage.type !== "helper_exchange" || !this.helpers.has(socket) || !this.bridgeSocket) { refuse("helper-unauthorized"); return; }
      const size = serializedPayloadSize(clientMessage);
      if (!requestId || !Number.isSafeInteger(clientMessage.deadlineMs) || Number(clientMessage.deadlineMs) <= 0 || Number(clientMessage.deadlineMs) > MAX_HELPER_DEADLINE_MS) { refuse("invalid-exchange"); return; }
      if (size === null || size > MAX_HELPER_EXCHANGE_BYTES) { refuse("exchange-too-large"); return; }
      if ([...this.helperPending.values()].some(pending => pending.socket === socket)) { refuse("helper-busy"); return; }
      const id = randomUUID(), deadlineMs = Number(clientMessage.deadlineMs);
      const timer = setTimeout(() => {
        this.helperPending.delete(id); this.writeBridge({ type: "federation_helper_cancel", requestId: id });
        if (!socket.destroyed) refuse("helper-timeout");
      }, deadlineMs);
      timer.unref(); this.helperPending.set(id, { socket, requestId, timer });
      this.writeBridge({ type: "federation_helper_exchange", requestId: id, input: clientMessage.input, deadlineMs });
      return;
    }
    if (clientMessage.type.startsWith("federation_")) throw new Error("privileged-bridge-required");

    if (currentKey === null && clientMessage.type !== "register") {
      throw new Error(`Received ${clientMessage.type} before register`);
    }

    switch (clientMessage.type) {
      case "register": {
        if (!isSessionRegistration(clientMessage.session)) {
          throw new Error("Invalid register message");
        }

        if (currentKey) {
          throw new Error("Received duplicate register message");
        }

        let id: string = randomUUID();
        if (clientMessage.sessionId !== undefined) {
          if (!isSessionId(clientMessage.sessionId)) {
            throw new Error("Invalid register sessionId");
          }
          id = clientMessage.sessionId;
        }
        const scopeId = normalizeScopeId(clientMessage.scopeId);
        const key = scopedSessionKey(scopeId, id);
        const session = clientMessage.session;
        if (session.address && session.address.scopeId !== (scopeId ?? null)) throw new Error("registration-address-scope-mismatch");
        const extensions = session.extensions;
        if (extensions !== undefined) {
          if (!Array.isArray(extensions) || extensions.length > MAX_EXTENSIONS_PER_SESSION) {
            throw new Error(`Invalid extensions field (maximum ${MAX_EXTENSIONS_PER_SESSION})`);
          }
          for (const extension of extensions) {
            if (!this.validateExtensionCapability(extension)) {
              throw new Error(`Invalid extension capability: ${JSON.stringify(extension)}`);
            }
          }
        }

        this.pruneDisconnectedSessions();
        this.pruneMailboxMessages();
        const previous = this.sessions.get(key);
        if (!previous && this.sessions.size >= MAX_SESSIONS) {
          writeMessage(socket, { type: "error", error: "Too many registered intercom sessions" });
          socket.destroy();
          break;
        }
        if (previous) {
          this.clearMessageReceiptRoutesForSession(key);
          previous.socket.end();
        }
        setKey(key);
        const info: SessionInfo = {
          id,
          endpointEpoch: randomUUID(),
          ...(session.activationEpoch ? { activationEpoch: session.activationEpoch } : {}),
          ...(session.homeEpoch !== undefined ? { homeEpoch: session.homeEpoch } : {}),
          ...(session.v0HomeEpoch !== undefined ? { v0HomeEpoch: session.v0HomeEpoch } : {}),
          ...(session.address ? { address: session.address } : {}),
          ...(session.name !== undefined ? { name: session.name } : {}),
          ...(session.runtimeFallbackAlias !== undefined ? { runtimeFallbackAlias: session.runtimeFallbackAlias } : {}),
          cwd: session.cwd,
          model: session.model,
          pid: session.pid,
          startedAt: session.startedAt,
          lastActivity: session.lastActivity,
          ...(session.status !== undefined ? { status: session.status } : {}),
          ...(session.tmuxPane !== undefined ? { tmuxPane: session.tmuxPane } : {}),
          trustedLocal: typeof LISTEN_TARGET === "string" && process.platform !== "win32",
        };

        const connectedSession: ConnectedSession = {
          socket,
          info,
          key,
          ...(scopeId ? { scopeId } : {}),
          lastPresenceBroadcastAt: Date.now(),
          ownerOrder: previous?.ownerOrder ?? this.nextOwnerOrder++,
          extensions,
          receiptAck: Array.isArray(clientMessage.features) && clientMessage.features.includes(RECEIPT_ACK_FEATURE),
          receiptEvidence: Array.isArray(clientMessage.features) && clientMessage.features.includes(RECEIPT_EVIDENCE_FEATURE),
          federation: session.v0HomeEpoch === undefined && Array.isArray(clientMessage.features) && clientMessage.features.includes(FEDERATION_FEATURE),
        };
        this.sessions.set(key, connectedSession);
        this.disconnectedSessions.delete(key);

        if (this.shutdownTimer) {
          clearTimeout(this.shutdownTimer);
          this.shutdownTimer = null;
        }

        // This must be the first broker message. Older clients ignore the
        // additive features field; newer clients use it to avoid sending
        // extension operations to an older broker.
        writeMessage(socket, {
          type: "registered",
          sessionId: id,
          features: [EXTENSION_BUS_FEATURE, EXACT_SEND_FEATURE, ...(connectedSession.receiptEvidence ? [RECEIPT_EVIDENCE_FEATURE] : []), ...(connectedSession.receiptAck ? [RECEIPT_ACK_FEATURE] : []), ...(typeof LISTEN_TARGET === "string" ? [FEDERATION_FEATURE] : [])],
        });
        this.broadcast({ type: "session_joined", session: info }, key, scopeId);

        this.recomputeNamespaceOwners();
        this.publishLocalPresence();
        this.flushMailboxForSession(connectedSession);

        if (extensions) {
          for (const ext of extensions) {
            const owner = this.namespaceOwners.get(scopedExtensionKey(scopeId, ext.namespace));
            writeMessage(socket, {
              type: "extension_owner",
              namespace: ext.namespace,
              ...(owner ? { ownerId: owner.sessionId, ownerEpoch: owner.epoch } : {}),
            });
            const state = this.extensionStateManager.loadState(scopedExtensionStateNamespace(scopeId, ext.namespace));
            if (state) {
              writeMessage(socket, {
                type: "extension_state",
                namespace: ext.namespace,
                revision: state.revision,
                payload: state.payload,
              });
            }
          }
        }
        break;
      }

      case "unregister": {
        if (!currentKey) {
          throw new Error("Received unregister before register");
        }
        const existing = this.sessions.get(currentKey);
        if (existing?.socket === socket) {
          this.rememberDisconnectedSession(existing);
          this.sessions.delete(currentKey);
          this.clearMessageReceiptRoutesForSession(currentKey);
          this.broadcast({ type: "session_left", sessionId: existing.info.id }, currentKey, existing.scopeId);
          this.recomputeNamespaceOwners();
          this.publishLocalPresence();
          this.scheduleShutdownCheck();
        }
        setKey(null);
        break;
      }

      case "extension_capabilities_update": {
        if (!currentKey) {
          throw new Error("Received extension_capabilities_update before register");
        }
        const session = this.sessions.get(currentKey);
        if (!session || session.socket !== socket) {
          throw new Error("Extension capability session not found");
        }
        const extensions = clientMessage.extensions;
        if (!Array.isArray(extensions) || extensions.length > MAX_EXTENSIONS_PER_SESSION) {
          throw new Error(`Invalid extensions field (maximum ${MAX_EXTENSIONS_PER_SESSION})`);
        }
        for (const extension of extensions) {
          if (!this.validateExtensionCapability(extension)) {
            throw new Error(`Invalid extension capability: ${JSON.stringify(extension)}`);
          }
        }
        session.extensions = extensions;
        this.recomputeNamespaceOwners();
        for (const extension of extensions) {
          const owner = this.namespaceOwners.get(scopedExtensionKey(session.scopeId, extension.namespace));
          writeMessage(socket, {
            type: "extension_owner",
            namespace: extension.namespace,
            ...(owner ? { ownerId: owner.sessionId, ownerEpoch: owner.epoch } : {}),
          });
          const state = this.extensionStateManager.loadState(scopedExtensionStateNamespace(session.scopeId, extension.namespace));
          if (state) {
            writeMessage(socket, {
              type: "extension_state",
              namespace: extension.namespace,
              revision: state.revision,
              payload: state.payload,
            });
          }
        }
        break;
      }

      case "list": {
        if (typeof clientMessage.requestId !== "string") {
          throw new Error("Invalid list message");
        }

        const requester = currentKey ? this.sessions.get(currentKey) : undefined;
        if (!requester || requester.socket !== socket) {
          throw new Error("List session not found");
        }
        const remote = requester.federation ? this.federation.roster(requester.scopeId ?? null) : [];
        const sessions = Array.from(this.sessions.values())
          .filter(session => sameScope(session.scopeId, requester.scopeId) && !remote.some(entry => addressKey(entry.address) === addressKey(sessionAddress(session.info, session.scopeId ?? null))))
          .map(s => s.info) as SessionInfo[];
        sessions.push(...remote);
        writeMessage(socket, { type: "sessions", requestId: clientMessage.requestId, sessions });
        break;
      }

      case "inspect_blockers": {
        const requester = currentKey ? this.sessions.get(currentKey) : undefined;
        if (!requester?.federation || !isSessionAddress(clientMessage.address) || clientMessage.address.scopeId !== (requester.scopeId ?? null) || typeof clientMessage.requestId !== "string" ||
            clientMessage.includeExpired !== undefined && typeof clientMessage.includeExpired !== "boolean") throw new Error("invalid-blocker-query");
        writeMessage(socket, { type: "blockers", requestId: clientMessage.requestId, blockers: this.inspectBlockers(clientMessage.address, clientMessage.includeExpired === true) });
        break;
      }
      case "send": {
        if (!currentKey) {
          throw new Error("Received send before register");
        }
        const message = clientMessage.message;
        const messageId = isMessage(message) ? message.id : "unknown";

        if (typeof clientMessage.to !== "string" || !isMessage(message)) {
          this.writeDeliveryFailure(socket, messageId, "Invalid message format", "E_INVALID_MESSAGE");
          break;
        }
        const fromSession = this.sessions.get(currentKey);
        if (!fromSession || fromSession.socket !== socket) {
          this.writeDeliveryFailure(socket, message.id, "Sender session not found", "E_SENDER_NOT_FOUND");
          break;
        }

        if (message.expectsReply && this.v0Asks.get(message.id)?.state === "waiting") {
          this.writeDeliveryFailure(socket, message.id, "Message ID is already in use by a remote ask", "E_INVALID_MESSAGE"); break;
        }
        if (message.replyTo && this.handleV0Reply(socket, fromSession, clientMessage.to, message)) break;
        const brokerReceivedAt = Date.now();
        this.pruneAskEdges();
        this.pruneMessageReceiptRoutes(brokerReceivedAt);
        const replyEdge = message.replyTo ? this.askEdges.get(message.replyTo) : undefined;

        const hasTargetId = clientMessage.targetId !== undefined;
        const hasTargetEpoch = clientMessage.targetEpoch !== undefined;
        if (
          hasTargetId !== hasTargetEpoch
          || (hasTargetId && (typeof clientMessage.targetId !== "string" || clientMessage.targetId.length === 0))
          || (hasTargetEpoch && (typeof clientMessage.targetEpoch !== "string" || clientMessage.targetEpoch.length === 0))
        ) {
          this.writeDeliveryFailure(socket, message.id, "Exact target requires an id and endpoint epoch", "E_INVALID_TARGET");
          break;
        }
        let resolved: SessionInfo | null = null;
        if (fromSession.federation) {
          try { resolved = this.federation.resolve(clientMessage.to as string, fromSession.scopeId ?? null, [...this.sessions.values()].filter(session => sameScope(session.scopeId, fromSession.scopeId)).map(session => session.info)); }
          catch { this.writeDeliveryFailure(socket, message.id, "Multiple sessions match the target. Use the session ID.", "E_AMBIGUOUS_TARGET"); break; }
        }
        if (message.expectsReply && (this.intakeClosed(sessionAddress(fromSession.info, fromSession.scopeId ?? null)) ||
            resolved && !resolved.remote && this.intakeClosed(sessionAddress(resolved, fromSession.scopeId ?? null)))) {
          this.writeDeliveryFailure(socket, message.id, "intercom-frozen", "E_INTERCOM_FROZEN", true); break;
        }
        const localHome = resolved && !resolved.remote && (this.intakeState !== undefined || resolved.homeEpoch != null || this.intakeClosed(sessionAddress(resolved, fromSession.scopeId ?? null))) ? resolved : null;
        if (localHome && !this.bridgeMachineId) { this.writeDeliveryFailure(socket, message.id, "bridge-unavailable", "E_FEDERATION_REFUSED"); break; }
        if (localHome) resolved = { remote: true, id: sessionAddress(localHome, fromSession.scopeId ?? null).sessionId, address: sessionAddress(localHome, fromSession.scopeId ?? null),
          machineId: this.bridgeMachineId!, machineAlias: this.bridgeMachineAlias!, homeEpoch: localHome.homeEpoch ?? null,
          activationEpoch: localHome.activationEpoch ?? localHome.endpointEpoch!, endpointEpoch: localHome.activationEpoch ?? localHome.endpointEpoch!,
          cwd: localHome.cwd, model: localHome.model, startedAt: localHome.startedAt, lastActivity: localHome.lastActivity,
          ...(localHome.name ? { name: localHome.name } : {}) };
        if (resolved?.remote) {
          if (hasTargetId && (clientMessage.targetId !== (localHome?.id ?? resolved.id) || clientMessage.targetEpoch !== (localHome?.endpointEpoch ?? resolved.endpointEpoch))) { this.writeDeliveryFailure(socket, message.id, "Target endpoint changed before delivery", "E_TARGET_REBOUND", true); break; }
          const target = resolved;
          const from = sessionAddress(fromSession.info, fromSession.scopeId ?? null);
          const inboundAsk = message.replyTo ? this.inboundRemoteRoutes.get(message.replyTo) : undefined;
          if (message.replyTo && inboundAsk && (inboundAsk.from.id !== target.id || addressKey(inboundAsk.to) !== addressKey(from))) { this.writeDeliveryFailure(socket, message.id, "Reply target does not match the pending ask", "E_REPLY_TARGET"); break; }
          this.remoteRoutes.set(message.id, { createdAt: Date.now(), from, to: target });
          void (localHome ? this.federation.dispatchLocal(from, target, message) : this.federation.dispatch(from, target, message)).then(result => {
            if (fromSession.socket.destroyed) return;
            const success = result.delivery === "queued" || result.delivery === "socket_delivered";
            writeMessage(socket, { type: success ? "delivered" : "delivery_failed", messageId: message.id, ...result, ...(!success ? { reason: result.reason ?? "Remote delivery was not confirmed" } : {}) });
          }, error => this.writeDeliveryFailure(socket, message.id, error instanceof Error ? error.message : "Remote delivery refused", "E_FEDERATION_REFUSED"));
          break;
        }
        if (hasTargetId && hasTargetEpoch) {
          const targetId = clientMessage.targetId as string;
          const targetEpoch = clientMessage.targetEpoch as string;
          const fingerprint = this.deliveryFingerprint(message, targetId);
          if (this.replayOrReject(socket, currentKey, message.id, fingerprint)) {
            break;
          }
          const exactTarget = this.sessions.get(scopedSessionKey(fromSession.scopeId, targetId));
          if (!exactTarget) {
            this.recordDelivery(currentKey, message.id, fingerprint, "failed", "Session not found", "E_TARGET_NOT_FOUND");
            this.writeDeliveryFailure(socket, message.id, "Session not found", "E_TARGET_NOT_FOUND");
            break;
          }
          if (exactTarget.info.endpointEpoch !== targetEpoch) {
            this.recordDelivery(currentKey, message.id, fingerprint, "failed", "Target endpoint changed before delivery", "E_TARGET_REBOUND", true);
            this.writeDeliveryFailure(socket, message.id, "Target endpoint changed before delivery", "E_TARGET_REBOUND", true);
            break;
          }
          clientMessage.to = targetId;
        }

        const targets = this.findSessions(clientMessage.to as string, fromSession.scopeId);
        if (targets.length === 1) {
          if (message.replyTo && !replyEdge) {
            this.writeDeliveryFailure(socket, message.id, "Reply target does not match a pending ask", "E_REPLY_TARGET");
            break;
          }
          const target = targets[0];
          if (this.intakeClosed(sessionAddress(target.info, target.scopeId ?? null)) || this.intakeClosed(sessionAddress(fromSession.info, fromSession.scopeId ?? null))) {
            this.writeDeliveryFailure(socket, message.id, "intercom-frozen", "E_INTERCOM_FROZEN", true); break;
          }
          const fingerprint = this.deliveryFingerprint(message, target.info.id);
          if (this.replayOrReject(socket, currentKey, message.id, fingerprint)) {
            break;
          }
          if (message.supersedes) {
            const supersededRoute = this.messageReceiptRoutes.get(message.supersedes);
            if (!supersededRoute || supersededRoute.from !== currentKey || supersededRoute.to !== target.key) {
              this.writeDeliveryFailure(socket, message.id, "Supersede target does not match a previous message from this sender to this receiver", "E_SUPERSEDE_TARGET");
              break;
            }
          }
          if (replyEdge && (replyEdge.to !== currentKey || replyEdge.from !== target.key)) {
            this.writeDeliveryFailure(socket, message.id, "Reply target does not match the pending ask", "E_REPLY_TARGET");
            break;
          }
          if (message.expectsReply) {
            const reverseEdge = Array.from(this.askEdges.entries()).find(([edgeMessageId, edge]) => edgeMessageId !== message.replyTo && edge.from === target.key && edge.to === currentKey);
            if (reverseEdge) {
              this.writeDeliveryFailure(socket, message.id, "Mutual ask refused: target session is already waiting for a reply from this session.", "E_MUTUAL_ASK");
              break;
            }
            this.writePendingAskRecord(message, fromSession, target.info, brokerReceivedAt);
            this.askEdges.set(message.id, {
              from: currentKey,
              to: target.key,
              ...(fromSession.scopeId ? { scopeId: fromSession.scopeId } : {}),
              createdAt: brokerReceivedAt,
            });
          }
          const deliveredMessage: Message = {
            ...message,
            brokerReceivedAt,
            brokerDeliveredAt: Date.now(),
          };
          if (message.supersedes) {
            const control: MessageControl = {
              action: "supersede",
              messageId: message.supersedes,
              supersededBy: message.id,
              timestamp: Date.now(),
            };
            writeMessage(target.socket, {
              type: "message_control",
              from: fromSession.info,
              control,
            });
            this.updateDeliveryRecord(currentKey, message.supersedes, "failed", `Superseded by ${message.id}`, "E_DELIVERY_SUPERSEDED");
          }
          writeMessage(target.socket, {
            type: "message",
            from: fromSession.info,
            message: deliveredMessage,
          });
          if (message.replyTo) {
            this.askEdges.delete(message.replyTo);
            this.removePendingAskRecord(message.replyTo, fromSession.scopeId);
          }
          this.messageReceiptRoutes.set(message.id, { from: currentKey, to: target.key, createdAt: brokerReceivedAt });
          this.unobservedLocalReceipts.set(message.id, { from: sessionAddress(fromSession.info, fromSession.scopeId ?? null), to: sessionAddress(target.info, target.scopeId ?? null), activationEpoch: target.info.activationEpoch ?? target.info.endpointEpoch!, unknown: false, createdAt: Date.now() });
          this.recordDelivery(currentKey, message.id, fingerprint, "socket_delivered");
          this.writeDeliverySuccess(socket, message.id, "socket_delivered");
          break;
        }

        if (targets.length > 1) {
          this.writeDeliveryFailure(socket, message.id, `Multiple sessions named \"${clientMessage.to}\" are connected. Use the session ID instead.`, "E_AMBIGUOUS_TARGET");
          break;
        }

        const disconnectedTargets = this.findDisconnectedSessions(clientMessage.to as string, fromSession.scopeId);
        if (disconnectedTargets.length === 1) {
          if (message.replyTo && !replyEdge) {
            this.writeDeliveryFailure(socket, message.id, "Reply target does not match a pending ask", "E_REPLY_TARGET");
            break;
          }
          const disconnectedTarget = disconnectedTargets[0]!;
          const target = disconnectedTarget.info;
          const fingerprint = this.deliveryFingerprint(message, target.id);
          if (this.replayOrReject(socket, currentKey, message.id, fingerprint)) {
            break;
          }
          if (message.supersedes) {
            this.writeDeliveryFailure(socket, message.id, "Supersede target is not connected", "E_SUPERSEDE_TARGET");
            break;
          }
          if (replyEdge && (replyEdge.to !== currentKey || replyEdge.from !== disconnectedTarget.key)) {
            this.writeDeliveryFailure(socket, message.id, "Reply target does not match the pending ask", "E_REPLY_TARGET");
            break;
          }
          if (message.expectsReply) {
            this.writeDeliveryFailure(socket, message.id, "Target session is not currently connected; blocking asks are not queued", "E_TARGET_DISCONNECTED");
            break;
          }
          const liveMailboxTarget = this.findUniqueLiveSessionForDisconnectedSession(disconnectedTarget, currentKey);
          if (liveMailboxTarget) {
            const deliveredMessage: Message = {
              ...message,
              brokerReceivedAt,
              brokerDeliveredAt: Date.now(),
            };
            writeMessage(liveMailboxTarget.socket, {
              type: "message",
              from: fromSession.info,
              message: deliveredMessage,
            });
            this.messageReceiptRoutes.set(message.id, { from: currentKey, to: liveMailboxTarget.key, createdAt: brokerReceivedAt });
            this.unobservedLocalReceipts.set(message.id, { from: sessionAddress(fromSession.info, fromSession.scopeId ?? null), to: sessionAddress(liveMailboxTarget.info, liveMailboxTarget.scopeId ?? null), activationEpoch: liveMailboxTarget.info.activationEpoch ?? liveMailboxTarget.info.endpointEpoch!, unknown: false, createdAt: Date.now() });
          } else {
            this.queueMailboxMessage(fromSession, disconnectedTarget, message, brokerReceivedAt);
          }
          if (message.replyTo) {
            this.askEdges.delete(message.replyTo);
            this.removePendingAskRecord(message.replyTo, fromSession.scopeId);
          }
          this.recordDelivery(currentKey, message.id, fingerprint, liveMailboxTarget ? "socket_delivered" : "queued");
          this.writeDeliverySuccess(socket, message.id, liveMailboxTarget ? "socket_delivered" : "queued");
          break;
        }

        if (disconnectedTargets.length > 1) {
          this.writeDeliveryFailure(socket, message.id, `Multiple disconnected sessions named \"${clientMessage.to}\" can receive queued mail. Use the session ID instead.`, "E_AMBIGUOUS_TARGET");
          break;
        }

        this.writeDeliveryFailure(socket, message.id, "Session not found", "E_TARGET_NOT_FOUND");
        break;
      }

      case "notice_ack": {
        const id = clientMessage.noticeId;
        if (!currentKey || typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid notice acknowledgement");
        const pending = this.noticePending.get(id);
        if (pending && pending.receiver === socket && this.sessions.get(currentKey)?.socket === socket && pending.bridge === this.bridgeSocket) {
          clearTimeout(pending.timer); this.noticePending.delete(id);
          writeMessage(pending.bridge, { type: "federation_notice_result", requestId: id, confirmed: true });
        }
        break;
      }
      case "message_receipt": {
        if (!currentKey) {
          throw new Error("Received message_receipt before register");
        }
        if (!isMessageReceipt(clientMessage.receipt)) {
          throw new Error("Invalid message_receipt message");
        }
        this.pruneMessageReceiptRoutes();
        const acknowledgedReceipt = clientMessage.receipt;
        const receiverForAck = this.sessions.get(currentKey);
        const acknowledge = () => {
          if (receiverForAck?.socket === socket && receiverForAck.receiptAck) writeMessage(socket, { type: "receipt_ack", messageId: acknowledgedReceipt.messageId, status: acknowledgedReceipt.status, timestamp: acknowledgedReceipt.timestamp });
        };
        const remoteRoute = this.inboundRemoteRoutes.get(clientMessage.receipt.messageId);
        if (remoteRoute && this.localForAddress(remoteRoute.to)?.key === currentKey && this.sessions.get(currentKey)?.socket === socket) {
          this.forwardLocalReceipt(remoteRoute.to, clientMessage.receipt);
          if (clientMessage.receipt.status === "expired" || isConsumptionReceipt(clientMessage.receipt)) this.inboundRemoteRoutes.delete(clientMessage.receipt.messageId);
          acknowledge();
          break;
        }
        const receiver = this.sessions.get(currentKey);
        const retained = this.unobservedLocalReceipts.get(clientMessage.receipt.messageId);
        const retainedSender = retained ? this.localForAddress(retained.from) : undefined;
        // A reload can drain the previous Pi queue. Its physical proof still belongs
        // to the old activation, whose bounded unknown marker keeps the return address.
        const route = this.messageReceiptRoutes.get(clientMessage.receipt.messageId) ??
          (retained && receiver && retainedSender && addressKey(sessionAddress(receiver.info, receiver.scopeId ?? null)) === addressKey(retained.to)
            ? { from: retainedSender.key, to: currentKey, createdAt: retained.createdAt } : undefined);
        const sender = route ? this.sessions.get(route.from) : undefined;
        if (route?.to === currentKey && receiver?.socket === socket) {
          const pending = this.unobservedLocalReceipts.get(clientMessage.receipt.messageId);
          if (pending) {
            if (clientMessage.receipt.status === "unknown") pending.unknown = true;
            if (clientMessage.receipt.status === "expired" || isConsumptionReceipt(clientMessage.receipt) && clientMessage.receipt.evidence?.activationEpoch === pending.activationEpoch && clientMessage.receipt.evidence.sessionId === pending.to.sessionId) this.unobservedLocalReceipts.delete(clientMessage.receipt.messageId);
          }
          const compatible = sender && compatibleReceipt(clientMessage.receipt, sender.receiptEvidence);
          if (sender && compatible) writeMessage(sender.socket, {
            type: "message_receipt",
            from: receiver.info,
            receipt: compatible,
          });
        } else if (!route && receiver?.socket === socket && receiver.federation && isConsumptionReceipt(clientMessage.receipt)) {
          const from = sessionAddress(receiver.info, receiver.scopeId ?? null);
          if (clientMessage.receipt.evidence?.sessionId === from.sessionId) this.forwardLocalReceipt(from, clientMessage.receipt);
        }
        acknowledge();
        break;
      }

      case "cancel_message": {
        if (!currentKey) {
          throw new Error("Received cancel_message before register");
        }
        if (typeof clientMessage.messageId !== "string") {
          throw new Error("Invalid cancel_message message");
        }
        this.pruneMessageReceiptRoutes();
        this.pruneMailboxMessages();
        const remoteRoute = this.remoteRoutes.get(clientMessage.messageId);
        if (remoteRoute && this.localForAddress(remoteRoute.from)?.key === currentKey && this.sessions.get(currentKey)?.socket === socket) {
          this.federation.control(remoteRoute.from, remoteRoute.to.address, { action: "cancel", messageId: clientMessage.messageId, timestamp: Date.now() });
          this.writeDeliverySuccess(socket, clientMessage.messageId, "socket_delivered");
          break;
        }
        const sender = this.sessions.get(currentKey);
        const queuedIndex = this.mailboxMessages.findIndex(entry => entry.message.id === clientMessage.messageId && entry.fromKey === currentKey);
        if (queuedIndex >= 0 && sender?.socket === socket) {
          this.mailboxMessages.splice(queuedIndex, 1);
          this.updateDeliveryRecord(currentKey, clientMessage.messageId, "failed", "Sender cancelled the queued delivery", "E_DELIVERY_CANCELLED");
          const edge = this.askEdges.get(clientMessage.messageId);
          if (edge?.from === currentKey) {
            this.askEdges.delete(clientMessage.messageId);
            this.removePendingAskRecord(clientMessage.messageId, sender.scopeId);
          }
          writeMessage(socket, { type: "delivered", messageId: clientMessage.messageId });
          break;
        }
        const route = this.messageReceiptRoutes.get(clientMessage.messageId);
        const receiver = route ? this.sessions.get(route.to) : undefined;
        if (route?.from !== currentKey || sender?.socket !== socket || !receiver) {
          writeMessage(socket, {
            type: "delivery_failed",
            messageId: clientMessage.messageId,
            reason: "Message cannot be cancelled by this session",
          });
          break;
        }
        writeMessage(receiver.socket, {
          type: "message_control",
          from: sender.info,
          control: {
            action: "cancel",
            messageId: clientMessage.messageId,
            timestamp: Date.now(),
          },
        });
        const edge = this.askEdges.get(clientMessage.messageId);
        if (edge?.from === currentKey) {
          this.askEdges.delete(clientMessage.messageId);
          this.removePendingAskRecord(clientMessage.messageId, sender.scopeId);
        }
        this.updateDeliveryRecord(currentKey, clientMessage.messageId, "failed", "Sender cancelled the delivery", "E_DELIVERY_CANCELLED");
        writeMessage(socket, { type: "delivered", messageId: clientMessage.messageId });
        break;
      }

      case "cancel_ask": {
        if (!currentKey) {
          throw new Error("Received cancel_ask before register");
        }
        if (typeof clientMessage.messageId !== "string") {
          throw new Error("Invalid cancel_ask message");
        }
        const session = this.sessions.get(currentKey);
        const remoteRoute = this.remoteRoutes.get(clientMessage.messageId);
        if (remoteRoute && this.localForAddress(remoteRoute.from)?.key === currentKey && session?.socket === socket) {
          this.federation.control(remoteRoute.from, remoteRoute.to.address, { action: "cancel", messageId: clientMessage.messageId, timestamp: Date.now() });
          break;
        }
        const edge = this.askEdges.get(clientMessage.messageId);
        if (session?.socket === socket && edge?.from === currentKey) {
          this.askEdges.delete(clientMessage.messageId);
          this.removePendingAskRecord(clientMessage.messageId, session.scopeId);
        }
        break;
      }

      case "presence": {
        if (!currentKey) {
          throw new Error("Received presence before register");
        }
        const session = this.sessions.get(currentKey);
        if (session?.socket === socket) {
          let changed = false;
          if (clientMessage.homeEpoch !== undefined) {
            if (typeof clientMessage.homeEpoch !== "number" || !Number.isSafeInteger(clientMessage.homeEpoch) || clientMessage.homeEpoch < 1 ||
                session.info.homeEpoch != null && session.info.homeEpoch !== clientMessage.homeEpoch) throw new Error("Invalid initial home epoch");
            if (session.info.homeEpoch == null) { session.info.homeEpoch = clientMessage.homeEpoch; changed = true; }
          }
          if (clientMessage.name !== undefined) {
            if (typeof clientMessage.name !== "string") {
              throw new Error("Invalid presence name");
            }
            if (session.info.name !== clientMessage.name) {
              session.info.name = clientMessage.name;
              changed = true;
            }
          }
          if (clientMessage.runtimeFallbackAlias !== undefined) {
            if (typeof clientMessage.runtimeFallbackAlias !== "boolean") {
              throw new Error("Invalid presence runtimeFallbackAlias");
            }
            if (session.info.runtimeFallbackAlias !== clientMessage.runtimeFallbackAlias) {
              session.info.runtimeFallbackAlias = clientMessage.runtimeFallbackAlias;
              changed = true;
            }
          }
          if (clientMessage.status !== undefined) {
            if (typeof clientMessage.status !== "string") {
              throw new Error("Invalid presence status");
            }
            if (session.info.status !== clientMessage.status) {
              session.info.status = clientMessage.status;
              changed = true;
            }
          }
          if (clientMessage.model !== undefined) {
            if (typeof clientMessage.model !== "string") {
              throw new Error("Invalid presence model");
            }
            if (session.info.model !== clientMessage.model) {
              session.info.model = clientMessage.model;
              changed = true;
            }
          }
          // Context-usage fields: a number updates, an explicit null CLEARS (the
          // value is unknown right after a compaction, so delete rather than carry
          // the stale-high value forward), undefined leaves the field untouched.
          if (clientMessage.contextPct !== undefined) {
            if (clientMessage.contextPct === null) {
              if (session.info.contextPct !== undefined) { delete session.info.contextPct; changed = true; }
            } else if (typeof clientMessage.contextPct !== "number") {
              throw new Error("Invalid presence contextPct");
            } else if (session.info.contextPct !== clientMessage.contextPct) {
              session.info.contextPct = clientMessage.contextPct;
              changed = true;
            }
          }
          if (clientMessage.contextTokens !== undefined) {
            if (clientMessage.contextTokens === null) {
              if (session.info.contextTokens !== undefined) { delete session.info.contextTokens; changed = true; }
            } else if (typeof clientMessage.contextTokens !== "number") {
              throw new Error("Invalid presence contextTokens");
            } else if (session.info.contextTokens !== clientMessage.contextTokens) {
              session.info.contextTokens = clientMessage.contextTokens;
              changed = true;
            }
          }
          if (clientMessage.contextWindow !== undefined) {
            if (clientMessage.contextWindow === null) {
              if (session.info.contextWindow !== undefined) { delete session.info.contextWindow; changed = true; }
            } else if (typeof clientMessage.contextWindow !== "number") {
              throw new Error("Invalid presence contextWindow");
            } else if (session.info.contextWindow !== clientMessage.contextWindow) {
              session.info.contextWindow = clientMessage.contextWindow;
              changed = true;
            }
          }
          const now = Date.now();
          session.info.lastActivity = now;
          if (changed || now - session.lastPresenceBroadcastAt >= PRESENCE_HEARTBEAT_MS) {
            session.lastPresenceBroadcastAt = now;
            this.broadcast({ type: "presence_update", session: session.info }, currentKey, session.scopeId);
            this.publishLocalPresence();
          }
        }
        break;
      }

      case "extension_publish": {
        this.handleExtensionPublish(socket, currentKey, clientMessage);
        break;
      }

      case "extension_state_commit": {
        this.handleExtensionStateCommit(socket, currentKey, clientMessage);
        break;
      }

      default:
        throw new Error(`Unknown client message type: ${clientMessage.type}`);
    }
  }

  private rememberDisconnectedSession(session: ConnectedSession, now = Date.now()): void {
    this.disconnectedSessions.set(session.key, {
      info: { ...session.info },
      key: session.key,
      ...(session.scopeId ? { scopeId: session.scopeId } : {}),
      disconnectedAt: now,
    });
    this.pruneDisconnectedSessions(now);
  }

  private pruneDisconnectedSessions(now = Date.now()): void {
    for (const [sessionId, session] of this.disconnectedSessions) {
      if (now - session.disconnectedAt > DISCONNECTED_SESSION_RETENTION_MS) {
        this.disconnectedSessions.delete(sessionId);
      }
    }
  }

  private pruneMailboxMessages(now = Date.now()): void {
    for (let index = this.mailboxMessages.length - 1; index >= 0; index -= 1) {
      const entry = this.mailboxMessages[index]!;
      if (now - entry.queuedAt > MAILBOX_MESSAGE_RETENTION_MS) {
        if (entry.message.expectsReply) {
          this.askEdges.delete(entry.message.id);
          this.removePendingAskRecord(entry.message.id, entry.fromScopeId);
        }
        this.messageReceiptRoutes.delete(entry.message.id);
        this.updateDeliveryRecord(entry.fromKey, entry.message.id, "failed", "Mailbox delivery expired", "E_DELIVERY_EXPIRED");
        this.mailboxMessages.splice(index, 1);
      }
    }
  }

  private queueMailboxMessage(from: ConnectedSession, target: DisconnectedSession, message: Message, brokerReceivedAt: number): void {
    this.pruneMailboxMessages(brokerReceivedAt);
    while (this.mailboxMessages.length >= MAX_MAILBOX_MESSAGES) {
      const evicted = this.mailboxMessages.shift();
      if (!evicted) break;
      if (evicted.message.expectsReply) {
        this.askEdges.delete(evicted.message.id);
        this.removePendingAskRecord(evicted.message.id, evicted.fromScopeId);
      }
      this.messageReceiptRoutes.delete(evicted.message.id);
      this.updateDeliveryRecord(evicted.fromKey, evicted.message.id, "failed", "Mailbox capacity evicted the delivery", "E_DELIVERY_EVICTED");
    }
    this.mailboxMessages.push({
      from: { ...from.info },
      fromKey: from.key,
      ...(from.scopeId ? { fromScopeId: from.scopeId } : {}),
      target: { ...target.info },
      targetKey: target.key,
      ...(target.scopeId ? { targetScopeId: target.scopeId } : {}),
      message: { ...message, brokerReceivedAt },
      queuedAt: brokerReceivedAt,
    });
  }

  private writeDeliverySuccess(socket: net.Socket, messageId: string, delivery: "socket_delivered" | "queued"): void {
    writeMessage(socket, { type: "delivered", messageId, delivery, retryable: false, outcomeKnown: true });
  }

  private writeDeliveryFailure(socket: net.Socket, messageId: string, reason: string, code: string, retryable = false): void {
    writeMessage(socket, { type: "delivery_failed", messageId, reason, delivery: "failed", code, retryable, outcomeKnown: true });
  }

  private deliveryFingerprint(message: Message, targetId: string): string {
    return JSON.stringify({
      targetId,
      text: message.content.text,
      attachments: message.content.attachments,
      replyTo: message.replyTo,
      expectsReply: message.expectsReply,
      supersedes: message.supersedes,
      retryOf: message.retryOf,
      provenance: message.provenance,
    });
  }

  private deliveryRecordKey(fromSessionId: string, messageId: string): string {
    return JSON.stringify([fromSessionId, messageId]);
  }

  private replayOrReject(socket: net.Socket, fromSessionId: string, messageId: string, fingerprint: string): boolean {
    this.pruneDeliveryRecords();
    const record = this.deliveryRecords.get(this.deliveryRecordKey(fromSessionId, messageId));
    if (!record) return false;
    if (record.fingerprint !== fingerprint) {
      this.writeDeliveryFailure(socket, messageId, "Message id was reused with different authored content", "E_MESSAGE_ID_REUSE");
      return true;
    }
    if (record.code === "E_TARGET_REBOUND" && record.retryable) {
      return false;
    }
    if (record.state === "socket_delivered" || record.state === "queued") {
      this.writeDeliverySuccess(socket, messageId, record.state);
    } else {
      this.writeDeliveryFailure(socket, messageId, record.reason ?? "Previous delivery failed", record.code ?? "E_DELIVERY_FAILED", record.retryable);
    }
    return true;
  }

  private recordDelivery(fromSessionId: string, messageId: string, fingerprint: string, state: DeliveryState, reason?: string, code?: string, retryable = false): void {
    this.pruneDeliveryRecords();
    while (this.deliveryRecords.size >= MAX_DELIVERY_RECORDS) {
      const oldest = this.deliveryRecords.keys().next().value;
      if (oldest === undefined) break;
      this.deliveryRecords.delete(oldest);
    }
    this.deliveryRecords.set(this.deliveryRecordKey(fromSessionId, messageId), {
      fingerprint,
      state,
      ...(reason ? { reason } : {}),
      ...(code ? { code } : {}),
      retryable,
      outcomeKnown: true,
      createdAt: Date.now(),
    });
  }

  private pruneDeliveryRecords(now = Date.now()): void {
    for (const [key, record] of this.deliveryRecords) {
      if (now - record.createdAt > DELIVERY_RECORD_RETENTION_MS) this.deliveryRecords.delete(key);
    }
  }

  private updateDeliveryRecord(fromSessionId: string, messageId: string, state: DeliveryState, reason?: string, code?: string): void {
    const record = this.deliveryRecords.get(this.deliveryRecordKey(fromSessionId, messageId));
    if (!record) return;
    record.state = state;
    record.reason = reason;
    record.code = code;
    record.retryable = false;
    record.outcomeKnown = true;
  }

  private flushMailboxForSession(session: ConnectedSession, now = Date.now()): void {
    this.pruneMailboxMessages(now);
    const sessionName = session.info.name?.toLowerCase();
    const uniqueMailboxIdentity = this.findLiveSessionsSharingMailboxIdentity(session).length === 1;

    for (let index = 0; index < this.mailboxMessages.length;) {
      const entry = this.mailboxMessages[index]!;
      if (!sameScope(entry.targetScopeId, session.scopeId)) {
        index += 1;
        continue;
      }
      const matchesId = entry.targetKey === session.key;
      const matchesSenderIdentity = Boolean(
        sessionName
        && sameScope(entry.fromScopeId, session.scopeId)
        && entry.from.name?.toLowerCase() === sessionName
        && sameCwd(entry.from.cwd, session.info.cwd),
      );
      const matchesUniqueName = Boolean(
        uniqueMailboxIdentity
        && sessionName
        && !matchesSenderIdentity
        && entry.target.name?.toLowerCase() === sessionName
        && sameCwd(entry.target.cwd, session.info.cwd),
      );
      if (!matchesId && !matchesUniqueName) {
        index += 1;
        continue;
      }

      this.mailboxMessages.splice(index, 1);
      const edge = this.askEdges.get(entry.message.id);
      if (edge?.to === entry.targetKey) {
        edge.to = session.key;
      }
      const deliveredMessage: Message = {
        ...entry.message,
        brokerDeliveredAt: Date.now(),
      };
      writeMessage(session.socket, {
        type: "message",
        from: entry.from,
        message: deliveredMessage,
      });
      this.messageReceiptRoutes.set(entry.message.id, {
        from: entry.fromKey,
        to: session.key,
        createdAt: entry.message.brokerReceivedAt ?? entry.queuedAt,
      });
      this.unobservedLocalReceipts.set(entry.message.id, { from: sessionAddress(entry.from, entry.fromScopeId ?? null), to: sessionAddress(session.info, session.scopeId ?? null), activationEpoch: session.info.activationEpoch ?? session.info.endpointEpoch!, unknown: false, createdAt: Date.now() });
      this.updateDeliveryRecord(entry.fromKey, entry.message.id, "socket_delivered");
    }
  }

  private pruneAskEdges(now = Date.now()): void {
    this.prunePendingAskRecords(now);
    for (const [messageId, edge] of this.askEdges) {
      if (now - edge.createdAt > this.askTimeoutMs) {
        this.askEdges.delete(messageId);
        this.removePendingAskRecord(messageId, edge.scopeId);
      }
    }
  }

  private clearAskEdgesForSession(sessionKey: string): void {
    for (const [messageId, edge] of this.askEdges) {
      if (edge.from === sessionKey || edge.to === sessionKey) {
        this.askEdges.delete(messageId);
        this.removePendingAskRecord(messageId, edge.scopeId);
      }
    }
  }

  private writePendingAskRecord(message: Message, from: ConnectedSession, target: SessionInfo, createdAt: number): void {
    ensurePendingAskRecordDir();
    const record: PendingAskRecord = {
      askId: message.id,
      messageId: message.id,
      asker: { sessionId: from.info.id, name: from.info.name ?? null },
      target: { sessionId: target.id, name: target.name ?? null },
      question: message.content.text,
      createdAt,
      expiresAt: createdAt + this.askTimeoutMs,
    };
    const filePath = scopedPendingAskRecordPath(from.scopeId, message.id);
    writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, { mode: INTERCOM_RUNTIME_FILE_MODE });
    restrictIntercomRuntimeFile(filePath);
  }

  private removePendingAskRecord(messageId: string, scopeId?: string): void {
    try {
      unlinkSync(scopedPendingAskRecordPath(scopeId, messageId));
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  private prunePendingAskRecords(now = Date.now()): void {
    ensurePendingAskRecordDir();
    for (const entry of readdirSync(PENDING_ASKS_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const filePath = join(PENDING_ASKS_DIR, entry.name);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(filePath, "utf-8"));
      } catch {
        unlinkSync(filePath);
        continue;
      }
      if (!isPendingAskRecord(parsed) || now > parsed.expiresAt) {
        unlinkSync(filePath);
      }
    }
  }

  private pruneMessageReceiptRoutes(now = Date.now()): void {
    for (const map of [this.messageReceiptRoutes, this.unobservedLocalReceipts, this.remoteRoutes, this.inboundRemoteRoutes]) {
      for (const [id, route] of map) if (now - route.createdAt > MESSAGE_RECEIPT_ROUTE_RETENTION_MS) map.delete(id);
      while (map.size > MAX_DELIVERY_RECORDS) map.delete(map.keys().next().value!);
    }
  }

  private clearMessageReceiptRoutesForSession(sessionKey: string): void {
    for (const [messageId, route] of this.messageReceiptRoutes) {
      if (route.from === sessionKey || route.to === sessionKey) {
        this.messageReceiptRoutes.delete(messageId);
        const pending = this.unobservedLocalReceipts.get(messageId);
        if (pending) pending.unknown = true;
      }
    }
  }

  private findSessions(nameOrId: string, scopeId: string | undefined): ConnectedSession[] {
    const byId = this.sessions.get(scopedSessionKey(scopeId, nameOrId));
    if (byId) {
      return [byId];
    }

    const lowerName = nameOrId.toLowerCase();
    const byName = Array.from(this.sessions.values()).filter(session => sameScope(session.scopeId, scopeId) && session.info.name?.toLowerCase() === lowerName);
    if (byName.length > 0) {
      return byName;
    }

    return Array.from(this.sessions.entries())
      .filter(([, session]) => sameScope(session.scopeId, scopeId) && session.info.id.startsWith(nameOrId))
      .map(([, session]) => session);
  }

  private findDisconnectedSessions(nameOrId: string, scopeId: string | undefined): DisconnectedSession[] {
    this.pruneDisconnectedSessions();
    const byId = this.disconnectedSessions.get(scopedSessionKey(scopeId, nameOrId));
    if (byId) {
      return [byId];
    }

    const lowerName = nameOrId.toLowerCase();
    const byName = Array.from(this.disconnectedSessions.values()).filter(session => sameScope(session.scopeId, scopeId) && session.info.name?.toLowerCase() === lowerName);
    if (byName.length > 0) {
      return byName;
    }

    return Array.from(this.disconnectedSessions.entries())
      .filter(([, session]) => sameScope(session.scopeId, scopeId) && session.info.id.startsWith(nameOrId))
      .map(([, session]) => session);
  }

  private findUniqueLiveSessionForDisconnectedSession(disconnected: DisconnectedSession, senderKey?: string): ConnectedSession | null {
    const matches = this.findLiveSessionsSharingMailboxIdentity(disconnected)
      .filter((session) => session.key !== senderKey);
    return matches.length === 1 ? matches[0]! : null;
  }

  /**
   * Mailbox identity is an explicit name plus directory, never name alone. A
   * runtime fallback alias is derived from the session id rather than chosen as
   * a durable identity, so it must not transfer mail to another process. This
   * also prevents two unnamed UUIDv7 sessions started close together from
   * inheriting each other's mailbox through a shared short alias.
   *
   * Directories compare through sameCwd so a relaunch that reports the same
   * directory differently (trailing slash, "."/"..", or a symlink such as macOS
   * /tmp vs /private/tmp) still matches.
   */
  private findLiveSessionsSharingMailboxIdentity(sessionInfo: ConnectedSession | DisconnectedSession): ConnectedSession[] {
    const lowerName = sessionInfo.info.name?.toLowerCase();
    if (!lowerName || sessionInfo.info.runtimeFallbackAlias) {
      return [];
    }
    return Array.from(this.sessions.values()).filter(session =>
      sameScope(session.scopeId, sessionInfo.scopeId)
      && !session.info.runtimeFallbackAlias
      && session.info.name?.toLowerCase() === lowerName
      && sameCwd(session.info.cwd, sessionInfo.info.cwd)
    );
  }

  private broadcast(msg: BrokerMessage, exclude?: string, scopeId?: string): void {
    for (const [id, session] of this.sessions) {
      if (id !== exclude && sameScope(session.scopeId, scopeId)) {
        writeMessage(session.socket, msg);
      }
    }
  }

  private validateExtensionCapability(cap: unknown): cap is ExtensionCapability {
    if (typeof cap !== "object" || cap === null) {
      return false;
    }
    const c = cap as Record<string, unknown>;
    if (typeof c.namespace !== "string" || typeof c.ownerEligible !== "boolean") {
      return false;
    }
    return this.validateNamespace(c.namespace);
  }

  private validateNamespace(ns: string): boolean {
    // ^[a-z0-9][a-z0-9._/-]{0,63}$
    if (ns.length === 0 || ns.length > 64) {
      return false;
    }
    if (!/^[a-z0-9]/.test(ns)) {
      return false;
    }
    if (!/^[a-z0-9][a-z0-9._/-]*$/.test(ns)) {
      return false;
    }
    return true;
  }

  private recomputeNamespaceOwners(): void {
    const namespaces = new Map<string, { namespace: string; scopeId?: string }>();
    for (const [key, owner] of this.namespaceOwners) {
      namespaces.set(key, {
        namespace: owner.namespace,
        ...(owner.scopeId ? { scopeId: owner.scopeId } : {}),
      });
    }
    for (const session of this.sessions.values()) {
      for (const extension of session.extensions ?? []) {
        namespaces.set(scopedExtensionKey(session.scopeId, extension.namespace), {
          namespace: extension.namespace,
          ...(session.scopeId ? { scopeId: session.scopeId } : {}),
        });
      }
    }

    // For each namespace, elect owner by (startedAt, sessionId).
    for (const [namespaceKey, scopedNamespace] of namespaces) {
      const { namespace, scopeId } = scopedNamespace;
      const candidates: Array<{ sessionKey: string; session: ConnectedSession }> = [];
      for (const [sessionKey, session] of this.sessions) {
        if (session.extensions) {
          const hasNamespace = session.extensions.some(
            (ext) => sameScope(session.scopeId, scopeId) && ext.namespace === namespace && ext.ownerEligible
          );
          if (hasNamespace) {
            candidates.push({ sessionKey, session });
          }
        }
      }

      if (candidates.length === 0) {
        if (this.namespaceOwners.delete(namespaceKey)) {
          for (const session of this.sessions.values()) {
            const isCapable = sameScope(session.scopeId, scopeId)
              && session.extensions?.some((extension) => extension.namespace === namespace);
            if (isCapable) {
              writeMessage(session.socket, { type: "extension_owner", namespace });
            }
          }
        }
        continue;
      }

      // Use broker-owned registration order so clients cannot seize authority
      // by backdating their advertised session start time. Stable-ID socket
      // replacements preserve the original order.
      candidates.sort((a, b) => {
        if (a.session.ownerOrder !== b.session.ownerOrder) {
          return a.session.ownerOrder - b.session.ownerOrder;
        }
        return a.session.info.id.localeCompare(b.session.info.id);
      });

      const winner = candidates[0];
      const existing = this.namespaceOwners.get(namespaceKey);

      const ownerChanged = !existing || existing.sessionKey !== winner.sessionKey;
      const socketChanged = existing && existing.socket !== winner.session.socket;

      if (ownerChanged || socketChanged) {
        const epoch = randomUUID();
        this.namespaceOwners.set(namespaceKey, {
          namespace,
          sessionKey: winner.sessionKey,
          sessionId: winner.session.info.id,
          socket: winner.session.socket,
          epoch,
          ...(scopeId ? { scopeId } : {}),
        });

        for (const session of this.sessions.values()) {
          if (session.extensions?.length) {
            const isCapable = sameScope(session.scopeId, scopeId)
              && session.extensions.some((ext) => ext.namespace === namespace);
            if (isCapable) {
              writeMessage(session.socket, {
                type: "extension_owner",
                namespace,
                ownerId: winner.session.info.id,
                ownerEpoch: epoch,
              });
            }
          }
        }
      }
    }
  }

  private handleExtensionPublish(
    socket: net.Socket,
    currentKey: string | null,
    msg: Record<string, unknown>
  ): void {
    if (!currentKey) {
      throw new Error("Received extension_publish before register");
    }

    const session = this.sessions.get(currentKey);
    if (!session || session.socket !== socket) {
      writeMessage(socket, { type: "error", error: "Session not found" });
      return;
    }

    if (!session.extensions?.length) {
      writeMessage(socket, { type: "error", error: "Session has not advertised extension capability" });
      return;
    }

    const namespace = msg.namespace;
    const audience = msg.audience;
    const ownerOnly = msg.ownerOnly === true;
    const ownerEpoch = msg.ownerEpoch;
    const payload = msg.payload;

    if (typeof namespace !== "string" || !this.validateNamespace(namespace)) {
      writeMessage(socket, { type: "error", error: "Invalid namespace" });
      return;
    }

    if (audience !== "owner" && audience !== "capable") {
      writeMessage(socket, { type: "error", error: "Invalid audience" });
      return;
    }

    const payloadSize = serializedPayloadSize(payload);
    if (payloadSize === null || payloadSize > MAX_EXTENSION_MESSAGE_BYTES) {
      writeMessage(socket, { type: "error", error: "Invalid extension payload or payload exceeds 16 KiB limit" });
      return;
    }

    // Verify sender has capability for this namespace
    const hasCapability = session.extensions?.some((ext) => ext.namespace === namespace);
    if (!hasCapability) {
      writeMessage(socket, { type: "error", error: "Sender does not have capability for this namespace" });
      return;
    }

    const owner = this.namespaceOwners.get(scopedExtensionKey(session.scopeId, namespace));
    if ((audience === "owner" || ownerOnly) && !owner) {
      writeMessage(socket, { type: "error", error: "No owner for this namespace" });
      return;
    }

    // For owner-only messages, validate exact socket and epoch
    if (ownerOnly && owner) {
      if (typeof ownerEpoch !== "string") {
        writeMessage(socket, { type: "error", error: "ownerEpoch required for owner-only messages" });
        return;
      }
      if (currentKey !== owner.sessionKey || socket !== owner.socket || ownerEpoch !== owner.epoch) {
        writeMessage(socket, { type: "error", error: "Owner validation failed" });
        return;
      }
    }

    // Route message to appropriate audience
    for (const [recipientId, recipientSession] of this.sessions) {
      if (!sameScope(recipientSession.scopeId, session.scopeId)) {
        continue;
      }
      if (!recipientSession.extensions?.length) {
        continue;
      }

      const isCapable = recipientSession.extensions.some((ext) => ext.namespace === namespace);
      if (!isCapable) {
        continue;
      }

      const shouldReceive =
        audience === "capable" ||
        (audience === "owner" && owner !== undefined &&
          recipientId === owner.sessionKey &&
          recipientSession.socket === owner.socket);

      if (shouldReceive) {
        writeMessage(recipientSession.socket, {
          type: "extension_message",
          namespace,
          fromSessionId: session.info.id,
          ...(owner ? { ownerId: owner.sessionId, ownerEpoch: owner.epoch } : {}),
          payload,
        });
      }
    }
  }

  private handleExtensionStateCommit(
    socket: net.Socket,
    currentKey: string | null,
    msg: Record<string, unknown>
  ): void {
    if (!currentKey) {
      throw new Error("Received extension_state_commit before register");
    }

    const session = this.sessions.get(currentKey);
    if (!session || session.socket !== socket) {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace: String(msg.namespace || ""),
        committed: false,
        revision: 0,
        reason: "Session not found",
      });
      return;
    }

    if (!session.extensions?.length) {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace: String(msg.namespace || ""),
        committed: false,
        revision: 0,
        reason: "Session has not advertised extension capability",
      });
      return;
    }

    const namespace = msg.namespace;
    const ownerEpoch = msg.ownerEpoch;
    const expectedRevision = msg.expectedRevision;
    const payload = msg.payload;

    if (typeof namespace !== "string" || !this.validateNamespace(namespace)) {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace: String(namespace),
        committed: false,
        revision: 0,
        reason: "Invalid namespace",
      });
      return;
    }
    const stateNamespace = scopedExtensionStateNamespace(session.scopeId, namespace);

    if (typeof ownerEpoch !== "string") {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace,
        committed: false,
        revision: this.extensionStateManager.getCurrentRevision(stateNamespace),
        reason: "Invalid ownerEpoch",
      });
      return;
    }

    if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace,
        committed: false,
        revision: this.extensionStateManager.getCurrentRevision(stateNamespace),
        reason: "Invalid expectedRevision",
      });
      return;
    }

    const payloadSize = serializedPayloadSize(payload);
    if (payloadSize === null || payloadSize > MAX_EXTENSION_STATE_BYTES) {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace,
        committed: false,
        revision: this.extensionStateManager.getCurrentRevision(stateNamespace),
        reason: "Invalid extension state or payload exceeds 64 KiB limit",
      });
      return;
    }

    // Verify sender has capability for this namespace
    const hasCapability = session.extensions?.some((ext) => ext.namespace === namespace);
    if (!hasCapability) {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace,
        committed: false,
        revision: this.extensionStateManager.getCurrentRevision(stateNamespace),
        reason: "Sender does not have capability for this namespace",
      });
      return;
    }

    const owner = this.namespaceOwners.get(scopedExtensionKey(session.scopeId, namespace));
    if (!owner) {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace,
        committed: false,
        revision: this.extensionStateManager.getCurrentRevision(stateNamespace),
        reason: "No owner for this namespace",
      });
      return;
    }

    // Validate owner, socket, and epoch
    if (currentKey !== owner.sessionKey || socket !== owner.socket || ownerEpoch !== owner.epoch) {
      writeMessage(socket, {
        type: "extension_state_result",
        namespace,
        committed: false,
        revision: this.extensionStateManager.getCurrentRevision(stateNamespace),
        reason: "Owner validation failed",
      });
      return;
    }

    const result = this.extensionStateManager.commitState(stateNamespace, expectedRevision, payload);

    // Send result to committer
    writeMessage(socket, {
      type: "extension_state_result",
      namespace,
      committed: result.committed,
      revision: result.revision,
      reason: result.reason,
    });

    // If committed, broadcast new state to all capable sessions
    if (result.committed) {
      for (const recipientSession of this.sessions.values()) {
        if (!sameScope(recipientSession.scopeId, session.scopeId)) {
          continue;
        }
        if (!recipientSession.extensions?.length) {
          continue;
        }

        const isCapable = recipientSession.extensions.some((ext) => ext.namespace === namespace);
        if (isCapable) {
          writeMessage(recipientSession.socket, {
            type: "extension_state",
            namespace,
            revision: result.revision,
            payload,
          });
        }
      }
    }
  }

  private shutdown(): void {
    console.log("Broker shutting down");
    this.relayLinks.close();

    for (const session of this.sessions.values()) {
      session.socket.end();
    }
    this.sessions.clear();
    this.askEdges.clear();
    this.messageReceiptRoutes.clear();
    this.disconnectedSessions.clear();
    this.mailboxMessages.length = 0;
    if (typeof LISTEN_TARGET === "string" && process.platform !== "win32") {
      try {
        unlinkSync(LISTEN_TARGET);
      } catch {
        // The socket may already be gone if shutdown started after a disconnect.
      }
    }
    try {
      unlinkSync(PORT_PATH);
    } catch {
      // The TCP endpoint file only exists when opt-in TCP transport is active.
    }
    try {
      unlinkSync(PID_PATH);
    } catch {
      // The PID file may already be gone if startup never completed.
    }
    this.server.close();
    process.exit(0);
  }
}

new IntercomBroker().start();
