import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { RELAY_PROTOCOL_VERSION, type RelayLinkView, type RelayPeer } from "../relay-protocol.js";

const MAX_SNAPSHOT_BYTES = 4096;
const MAX_LOG_BYTES = 64 * 1024;
const errors = new Set(["core-unavailable", "invalid-config", "link-replaced", "poll-closed", "poll-expired",
  "poll-timeout", "protocol-error", "relay-busy", "relay-stopping", "route-missing", "unauthorized", "unreachable"]);
const versionMismatch = /^version-mismatch \(local \d{1,16}, peer \d{1,16}\)$/;
export const relayVersionMismatch = (peer: number) => `version-mismatch (local ${RELAY_PROTOCOL_VERSION}, peer ${peer})`;

type RelayDirection = "in" | "out";
type RelayState = Pick<RelayLinkView, "state" | "sinceMs" | "lastCallMs" | "lastError" | "messagesCarried">;
export type RelayObservation = RelayState & {
  alias: string;
  observedAtMs: number;
  expiresAtMs: number | null;
};

// Machine IDs become filenames. The wire allows general identifiers.
function machineId(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
}
function owned(uid: number): boolean { return process.getuid === undefined || uid === process.getuid(); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException | null)?.code === "ENOENT"; }
function directory(file: string, privateMode: boolean, create = false): void {
  if (create) try { mkdirSync(file, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = lstatSync(file);
  if (!stat.isDirectory() || !owned(stat.uid) || (stat.mode & (privateMode ? 0o7777 : 0o022)) !== (privateMode ? 0o700 : 0))
    throw new Error("Unsafe relay observation directory");
}
function roamDirectory(root: string): string {
  if (!isAbsolute(root) || resolve(root) !== root || realpathSync(root) !== root) throw new Error("Unsafe relay observation root");
  directory(root, false);
  const roam = join(root, "roam");
  directory(roam, true);
  return roam;
}
function linkDirectory(root: string, direction: RelayDirection, create = false): string {
  const base = join(roamDirectory(root), "relay"), out = join(base, direction);
  directory(base, true, create);
  directory(out, true, create);
  return out;
}
function privateFile(fd: number, max: number): number {
  const stat = fstatSync(fd);
  if (!stat.isFile() || !owned(stat.uid) || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || stat.size > max)
    throw new Error("Unsafe relay observation file");
  return stat.size;
}
function readJson(file: string, max: number): unknown {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { privateFile(fd, max); return JSON.parse(readFileSync(fd, "utf8")); }
  finally { closeSync(fd); }
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function alias(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255 && value === value.trim() &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}
function safeError(value: unknown): value is string {
  return typeof value === "string" && (errors.has(value) || versionMismatch.test(value));
}
function readSnapshot(file: string): RelayObservation | null {
  try {
    const raw = readJson(file, MAX_SNAPSHOT_BYTES);
    if (!object(raw) || raw.version !== 1) return null;
    const { alias: label, observedAtMs, expiresAtMs, state, sinceMs, lastCallMs, lastError, messagesCarried } = raw;
    if (state !== "down" && state !== "up" && state !== "connecting") return null;
    if (!alias(label) || !timestamp(observedAtMs) || !timestamp(sinceMs) || !timestamp(messagesCarried) ||
        (lastCallMs !== null && !timestamp(lastCallMs)) || (lastError !== null && !safeError(lastError)) ||
        (expiresAtMs !== null && !timestamp(expiresAtMs)) || (state === "down") !== (expiresAtMs === null)) return null;
    return { alias: label, observedAtMs, expiresAtMs, state, sinceMs, lastCallMs, lastError, messagesCarried };
  } catch { return null; }
}

/** A fallback mismatch cannot overwrite a broker snapshot, even during startup. */
export function readRelayObservation(root: string, direction: RelayDirection, id: string): RelayObservation | null {
  if (!machineId(id)) return null;
  try {
    const base = join(linkDirectory(root, direction), id);
    const primary = readSnapshot(`${base}.json`);
    if (direction === "out") return primary;
    const mismatch = readSnapshot(`${base}.mismatch.json`);
    return mismatch && (!primary || mismatch.observedAtMs > primary.observedAtMs) ? mismatch : primary;
  } catch { return null; }
}

function writeSnapshot(file: string, value: RelayObservation): void {
  const temporary = `${file}.${randomUUID()}.new`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try { writeFileSync(fd, `${JSON.stringify({ version: 1, ...value })}\n`); }
    finally { closeSync(fd); }
    renameSync(temporary, file);
  } finally { try { unlinkSync(temporary); } catch (error) { if (!missing(error)) throw error; } }
}
function appendEvent(file: string, line: string): void {
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const fd = openSync(file, flags, 0o600);
  try {
    if (privateFile(fd, MAX_LOG_BYTES) + Buffer.byteLength(line) <= MAX_LOG_BYTES) {
      writeFileSync(fd, line);
      return;
    }
  } finally { closeSync(fd); }
  renameSync(file, `${file}.1`);
  writeFileSync(file, line, { flag: "wx", mode: 0o600 });
}

export function writeRelayObservation(root: string, direction: RelayDirection, peer: RelayPeer, view: RelayState,
  expiresAtMs: number | null, observedAtMs: number, fallbackMismatch = false): void {
  if (!machineId(peer.machineId) || !alias(peer.alias)) return;
  try {
    const base = join(linkDirectory(root, direction, true), peer.machineId);
    const file = `${base}${fallbackMismatch ? ".mismatch" : ""}.json`;
    const previous = fallbackMismatch ? null : readSnapshot(file);
    const { state, sinceMs, lastCallMs, lastError, messagesCarried } = view;
    const error = lastError === null || safeError(lastError) ? lastError : "protocol-error";
    writeSnapshot(file, { alias: peer.alias, observedAtMs, expiresAtMs, state, sinceMs, lastCallMs, lastError: error, messagesCarried });
    // The fallback writer has no ownership of the broker's link log.
    if (!fallbackMismatch && (!previous || previous.state !== state || previous.lastError !== error))
      appendEvent(`${base}.log`, `${observedAtMs} ${state}${error ? ` ${error}` : ""}\n`);
  } catch { /* An observation failure must not change a delivery outcome. */ }
}

export function recordRelayMismatch(root: string, peer: RelayPeer, peerVersion: number, now: number, last?: RelayState,
  fallback = false): void {
  writeRelayObservation(root, "in", peer, { state: "down", sinceMs: now, lastCallMs: last?.lastCallMs ?? null,
    lastError: relayVersionMismatch(peerVersion), messagesCarried: last?.messagesCarried ?? 0 }, null, now, fallback);
}

/** Capture the broker's launch root once. A poll supplies identities, never a path. */
export function brokerRelayObserver() {
  const root = process.env.SPIDER_GLOBAL_ROOT || join(homedir(), ".pi", "agent", "spider");
  function authorized(to: string, relay: RelayPeer): boolean {
    if (!machineId(to) || !machineId(relay.machineId)) return false;
    try {
      const directory = roamDirectory(root);
      const identity = readJson(join(directory, "machine.json"), MAX_SNAPSHOT_BYTES);
      const config = readJson(join(directory, "intercom-v0.json"), 64 * 1024);
      return object(identity) && identity.machineId === to && object(config) && config.version === 2 &&
        Array.isArray(config.relays) && config.relays.includes(relay.machineId);
    } catch { return false; }
  }
  return {
    link(to: string, view: RelayLinkView, expiresAtMs: number | null, now: number): void {
      if (authorized(to, view.relay)) writeRelayObservation(root, "in", view.relay, view, expiresAtMs, now);
    },
    mismatch(to: string, relay: RelayPeer, version: number, now: number, last?: RelayState): void {
      if (authorized(to, relay)) recordRelayMismatch(root, relay, version, now, last);
    },
  };
}
