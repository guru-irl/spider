import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, fsyncSync, fstatSync, linkSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Home, Probe, Segment } from "@spider/db-core/roam/types";
import type { Journal, Limits, SessionManifest } from "./contracts";
import { DEFAULT_LIMITS } from "./contracts";
import { stageArtifact } from "./artifacts";
import type { OutgoingStore } from "./staging";
import { artifactId, hash, openOutgoingStaging, privateDirectory, readPrivate, sourceChunk, syncStagingDirectory, writeImmutable } from "./staging";

interface Header {
  type: "session";
  version: 3;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
  [key: string]: unknown;
}
interface PropertyRange { keyStart: number; valueStart: number; valueEnd: number; precedingComma: number | null; followingComma: number | null }
interface HeaderLayout { cwd: PropertyRange; parent: PropertyRange | null; close: number }
interface SessionScan {
  manifest: SessionManifest;
  header: Header;
  headerBytes: number;
  headerLayout: HeaderLayout;
  parents: Map<string, string | null>;
  firstHistoryMachine: string | null;
  lastSegment: Segment | null;
  lastSegmentLineStart: number | null;
  lastEntry: Record<string, unknown>;
  lastLineStart: number;
}

type JsonScope = "root" | "segment" | "reference" | "ignored";
type JsonState = "key-or-end" | "key" | "colon" | "value" | "value-or-end" | "comma-or-end";
type JsonFrame = {
  kind: "object" | "array"; state: JsonState; scope: JsonScope; target: Record<string, unknown> | null;
  key: string | null; keyStart: number; valueStart: number; precedingComma: number | null; completedKey: string | null;
};
const ROOT_KEYS = new Set(["type", "version", "id", "timestamp", "cwd", "parentSession", "parentId", "firstKeptEntryId", "customType", "data"]);
const SEGMENT_KEYS = new Set(["version", "moveId", "epoch", "previousMachine", "nextMachine", "historyMachine", "parentRef"]);
const REFERENCE_KEYS = new Set(["machineId", "reference"]);
const jsonSpace = (b: number) => b === 32 || b === 9 || b === 13;
const jsonDelimiter = (b: number) => jsonSpace(b) || b === 44 || b === 125 || b === 93;
const digit = (b: number) => b >= 48 && b <= 57;
const hex = (b: number) => digit(b) || b >= 65 && b <= 70 || b >= 97 && b <= 102;

/** Validate every byte, retaining only bounded graph and segment metadata. */
class SessionJsonLine {
  private frames: JsonFrame[] = [];
  private root: Record<string, unknown> | null = null;
  private done = false;
  private token: "string" | "primitive" | null = null;
  private isKey = false;
  private capture: number[] | null = null;
  private captureLimit = 0;
  private escape = false;
  private unicode = 0;
  private primitive = "";
  private numberState = "";
  private literal = "";
  private literalPosition = 0;
  private cwdRange: PropertyRange | null = null;
  private parentRange: PropertyRange | null = null;
  private duplicateHeaderField = false;
  private close = -1;

  private selected(frame: JsonFrame | undefined): boolean {
    if (!frame?.target || frame.kind !== "object" || frame.key === null) return false;
    return (frame.scope === "root" ? ROOT_KEYS : frame.scope === "segment" ? SEGMENT_KEYS : REFERENCE_KEYS).has(frame.key);
  }
  private assign(frame: JsonFrame | undefined, value: unknown): void {
    if (this.selected(frame)) frame!.target![frame!.key!] = value;
  }
  private complete(end: number): void {
    const parent = this.frames.at(-1);
    if (!parent) { this.done = true; return; }
    if (parent.kind === "object" && parent.scope === "root" && (parent.key === "cwd" || parent.key === "parentSession")) {
      const range: PropertyRange = { keyStart: parent.keyStart, valueStart: parent.valueStart, valueEnd: end,
        precedingComma: parent.precedingComma, followingComma: null };
      if (parent.key === "cwd") {
        if (this.cwdRange) this.duplicateHeaderField = true;
        this.cwdRange = range;
      } else {
        if (this.parentRange) this.duplicateHeaderField = true;
        this.parentRange = range;
      }
    }
    parent.completedKey = parent.key;
    parent.state = "comma-or-end";
  }
  private begin(b: number, position: number): void {
    const parent = this.frames.at(-1);
    if (!parent && (this.root !== null || b !== 123)) invalid("entry is not an object");
    if (parent) parent.valueStart = position;
    if (b === 123 || b === 91) {
      let scope: JsonScope = "ignored", target: Record<string, unknown> | null = null;
      if (!parent) { scope = "root"; target = Object.create(null) as Record<string, unknown>; this.root = target; }
      else if (b === 123 && parent.scope === "root" && parent.key === "data") {
        scope = "segment"; target = Object.create(null) as Record<string, unknown>; this.assign(parent, target);
      } else if (b === 123 && parent.scope === "segment" && parent.key === "parentRef") {
        scope = "reference"; target = Object.create(null) as Record<string, unknown>; this.assign(parent, target);
      } else this.assign(parent, null);
      this.frames.push({ kind: b === 123 ? "object" : "array", state: b === 123 ? "key-or-end" : "value-or-end",
        scope, target, key: null, keyStart: 0, valueStart: 0, precedingComma: null, completedKey: null });
      return;
    }
    if (b === 34) {
      this.token = "string"; this.isKey = false; this.escape = false; this.unicode = 0;
      this.capture = this.selected(parent) ? [34] : null; this.captureLimit = 64 * 1024;
      return;
    }
    this.token = "primitive";
    this.primitive = this.selected(parent) ? String.fromCharCode(b) : "";
    this.captureLimit = this.selected(parent) ? 64 * 1024 : 0;
    this.literal = b === 116 ? "true" : b === 102 ? "false" : b === 110 ? "null" : "";
    this.literalPosition = this.literal ? 1 : 0;
    this.numberState = b === 45 ? "minus" : b === 48 ? "zero" : b >= 49 && b <= 57 ? "integer" : "";
    if (!this.literal && !this.numberState) invalid("malformed JSON or UTF-8");
  }
  private primitiveByte(b: number): void {
    if (this.captureLimit) {
      if (this.primitive.length < this.captureLimit) this.primitive += String.fromCharCode(b);
      else { this.primitive = ""; this.captureLimit = 0; }
    }
    if (this.literal) {
      if (b !== this.literal.charCodeAt(this.literalPosition++)) invalid("malformed JSON or UTF-8");
      return;
    }
    switch (this.numberState) {
      case "minus": this.numberState = b === 48 ? "zero" : b >= 49 && b <= 57 ? "integer" : ""; break;
      case "zero": this.numberState = b === 46 ? "dot" : b === 69 || b === 101 ? "exponent" : ""; break;
      case "integer": this.numberState = digit(b) ? "integer" : b === 46 ? "dot" : b === 69 || b === 101 ? "exponent" : ""; break;
      case "dot": this.numberState = digit(b) ? "fraction" : ""; break;
      case "fraction": this.numberState = digit(b) ? "fraction" : b === 69 || b === 101 ? "exponent" : ""; break;
      case "exponent": this.numberState = b === 43 || b === 45 ? "exponent-sign" : digit(b) ? "exponent-digits" : ""; break;
      case "exponent-sign": this.numberState = digit(b) ? "exponent-digits" : ""; break;
      case "exponent-digits": this.numberState = digit(b) ? "exponent-digits" : ""; break;
      default: this.numberState = "";
    }
    if (!this.numberState) invalid("malformed JSON or UTF-8");
  }
  private finishPrimitive(end: number): void {
    if (this.literal ? this.literalPosition !== this.literal.length : !["zero", "integer", "fraction", "exponent-digits"].includes(this.numberState)) {
      invalid("malformed JSON or UTF-8");
    }
    let value: unknown = null;
    if (this.captureLimit) {
      try { value = JSON.parse(this.primitive); }
      catch { invalid("malformed JSON or UTF-8"); }
    }
    this.assign(this.frames.at(-1), value);
    this.token = null; this.complete(end);
  }
  write(bytes: Buffer, offset: number): void {
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i], position = offset + i;
      if (this.token === "string") {
        if (this.capture) {
          if (this.capture.length < this.captureLimit) this.capture.push(b);
          else this.capture = null;
        }
        if (this.unicode) { if (!hex(b)) invalid("malformed JSON or UTF-8"); this.unicode--; continue; }
        if (this.escape) {
          this.escape = false;
          if (b === 117) this.unicode = 4;
          else if (![34, 92, 47, 98, 102, 110, 114, 116].includes(b)) invalid("malformed JSON or UTF-8");
          continue;
        }
        if (b === 92) { this.escape = true; continue; }
        if (b < 32) invalid("malformed JSON or UTF-8");
        if (b !== 34) continue;
        this.token = null;
        let value: unknown = null;
        if (this.capture) {
          try { value = JSON.parse(Buffer.from(this.capture).toString("utf8")); }
          catch { invalid("malformed JSON or UTF-8"); }
        }
        const parent = this.frames.at(-1)!;
        if (this.isKey) { parent.key = typeof value === "string" ? value : null; parent.state = "colon"; }
        else { this.assign(parent, value); this.complete(position + 1); }
        this.capture = null;
        continue;
      }
      if (this.token === "primitive") {
        if (!jsonDelimiter(b)) { this.primitiveByte(b); continue; }
        this.finishPrimitive(position);
      }
      if (jsonSpace(b)) continue;
      if (this.done) invalid("malformed JSON or UTF-8");
      const frame = this.frames.at(-1);
      if (!frame) { this.begin(b, position); continue; }
      const close = frame.kind === "object" ? 125 : 93;
      if (b === close && (frame.state === "key-or-end" || frame.state === "value-or-end" || frame.state === "comma-or-end")) {
        this.frames.pop();
        if (frame.scope === "root") this.close = position;
        this.complete(position + 1); continue;
      }
      if (frame.state === "key-or-end" || frame.state === "key") {
        if (b !== 34 || frame.kind !== "object") invalid("malformed JSON or UTF-8");
        frame.keyStart = position; this.token = "string"; this.isKey = true; this.escape = false; this.unicode = 0;
        this.capture = frame.scope === "ignored" ? null : [34]; this.captureLimit = 256;
      } else if (frame.state === "colon") {
        if (b !== 58) invalid("malformed JSON or UTF-8");
        frame.state = "value";
      } else if (frame.state === "comma-or-end") {
        if (b !== 44) invalid("malformed JSON or UTF-8");
        if (frame.scope === "root" && frame.completedKey === "parentSession" && this.parentRange?.precedingComma === null) {
          this.parentRange.followingComma = position;
        }
        frame.precedingComma = position;
        frame.state = frame.kind === "object" ? "key" : "value";
      } else this.begin(b, position);
    }
  }
  finish(end: number): { item: Record<string, unknown>; layout: HeaderLayout | null } {
    if (this.token === "primitive") this.finishPrimitive(end);
    if (this.token || !this.done || this.frames.length || !this.root) invalid("malformed JSON or UTF-8");
    const layout = this.cwdRange && !this.duplicateHeaderField && this.close >= 0
      ? { cwd: this.cwdRange, parent: this.parentRange, close: this.close } : null;
    return { item: this.root, layout };
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function timestamp(value: unknown): value is string { return text(value) && Number.isFinite(Date.parse(value)); }
function invalid(reason: string): never { throw new Error(`Invalid session file: ${reason}`); }
function segmentData(value: unknown): Segment {
  const data = object(value), parent = data?.parentRef === null ? null : object(data?.parentRef);
  if (!data || data.version !== 1 || !text(data.moveId) || !Number.isSafeInteger(data.epoch) ||
      (data.epoch as number) < 1 || !text(data.previousMachine) || !text(data.nextMachine) || !text(data.historyMachine) ||
      data.parentRef !== null && (!parent || !text(parent.machineId) || !text(parent.reference))) invalid("invalid segment");
  return data as unknown as Segment;
}

/** Read complete physical entries, retaining the original bytes for transfer. */
function scanSession(file: string, expectedId: string, liveLeaf?: string, limits: Readonly<Limits> = DEFAULT_LIMITS): SessionScan {
  if (!Number.isSafeInteger(limits.sessionBytes) || limits.sessionBytes <= 0) invalid("invalid session size limit");
  if (!isAbsolute(file) || !text(expectedId) || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(expectedId)) {
    invalid("invalid path or identity");
  }
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size <= 0 || before.size > limits.sessionBytes) {
      invalid("empty, oversized, or non-regular file");
    }
    const whole = createHash("sha256"), history = createHash("sha256");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const parents = new Map<string, string | null>();
    let header: Header | undefined, headerBytes = 0, headerLayout: HeaderLayout | undefined, lastLeaf: string | undefined;
    let lastEntry: Record<string, unknown> | undefined, lastLineStart = 0;
    let firstHistoryMachine: string | null = null, lastSegment: Segment | null = null, lastSegmentLineStart: number | null = null;
    let line = new SessionJsonLine(), lineStart = 0, position = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const parseLine = (parsed: ReturnType<SessionJsonLine["finish"]>, end: number): void => {
      const { item } = parsed;
      if (!header) {
        if (item.type !== "session" || item.version !== 3 || item.id !== expectedId || !timestamp(item.timestamp) ||
            !text(item.cwd) || !isAbsolute(item.cwd) || item.parentSession !== undefined && !text(item.parentSession) || !parsed.layout) {
          invalid("invalid header or identity");
        }
        header = item as Header;
        headerBytes = end; headerLayout = parsed.layout;
        return;
      }
      if (!text(item.type) || item.type === "session" || !text(item.id) || !timestamp(item.timestamp) ||
          !(item.parentId === null || text(item.parentId))) invalid("invalid entry");
      const id = item.id, parent = item.parentId;
      if (parents.has(id) || parent !== null && !parents.has(parent)) invalid("duplicate ID or invalid parent");
      if (item.type === "compaction") {
        if (!text(item.firstKeptEntryId)) invalid("invalid compaction boundary");
        let current: string | null = parent;
        while (current !== null && current !== item.firstKeptEntryId) current = parents.get(current) ?? null;
        if (item.firstKeptEntryId !== id && current === null) invalid("invalid compaction boundary");
      }
      if (item.type === "custom" && item.customType === "spider-roam-segment") {
        const segment = segmentData(item.data);
        if (lastSegment === null) {
          if (segment.historyMachine !== segment.previousMachine) invalid("invalid initial segment history");
          firstHistoryMachine = segment.historyMachine;
        } else if (segment.historyMachine !== firstHistoryMachine || segment.previousMachine !== lastSegment.nextMachine ||
            segment.epoch <= lastSegment.epoch) invalid("invalid segment sequence");
        lastSegment = segment;
        lastSegmentLineStart = lineStart;
      }
      parents.set(id, parent);
      lastLeaf = id;
      lastEntry = item;
      lastLineStart = lineStart;
    };
    while (position < before.size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (count === 0) invalid("source changed while reading");
      const chunk = buffer.subarray(0, count);
      try { decoder.decode(chunk, { stream: true }); }
      catch { invalid("malformed JSON or UTF-8"); }
      whole.update(chunk);
      if (headerBytes) history.update(chunk);
      else {
        const firstNewline = chunk.indexOf(10);
        if (firstNewline !== -1) history.update(chunk.subarray(firstNewline + 1));
      }
      let start = 0;
      for (let end = chunk.indexOf(10, start); end !== -1; end = chunk.indexOf(10, start)) {
        line.write(chunk.subarray(start, end), position + start);
        parseLine(line.finish(position + end), position + end + 1);
        line = new SessionJsonLine(); lineStart = position + end + 1; start = end + 1;
      }
      if (start < count) line.write(chunk.subarray(start), position + start);
      position += count;
    }
    try { decoder.decode(); }
    catch { invalid("malformed JSON or UTF-8"); }
    if (lineStart !== before.size || !header || !headerLayout || !lastLeaf || !lastEntry) invalid("incomplete or empty history");
    const leaf = liveLeaf === undefined ? lastLeaf : liveLeaf;
    if (!text(leaf) || !parents.has(leaf)) invalid("selected leaf is missing");
    const after = fstatSync(fd), named = lstatSync(file);
    if (!named.isFile() || named.dev !== before.dev || named.ino !== before.ino || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) invalid("source changed while reading");
    return {
      header, headerBytes, headerLayout, parents, firstHistoryMachine, lastSegment, lastSegmentLineStart, lastEntry, lastLineStart,
      manifest: { file, sessionId: expectedId, cwd: header.cwd, leaf, size: before.size,
        sha256: whole.digest("hex"), historySha256: history.digest("hex"), artifactId: randomUUID() },
    };
  } finally { closeSync(fd); }
}

export async function inspectSession(file: string, expectedId: string, liveLeaf?: string, limits?: Readonly<Limits>): Promise<SessionManifest> {
  return scanSession(file, expectedId, liveLeaf, limits).manifest;
}

function frozenScan(manifest: SessionManifest, limits?: Readonly<Limits>): SessionScan {
  const scan = scanSession(manifest.file, manifest.sessionId, manifest.leaf, limits);
  const actual = scan.manifest;
  if (actual.size !== manifest.size || actual.sha256 !== manifest.sha256 || actual.historySha256 !== manifest.historySha256 ||
      actual.cwd !== manifest.cwd) invalid("frozen source changed");
  return scan;
}

/** Recheck the freeze acknowledgement immediately before the home transaction. */
export async function verifyFrozenSession(manifest: SessionManifest, limits?: Readonly<Limits>): Promise<void> {
  frozenScan(manifest, limits);
}

function digestRange(file: string, start: number, end: number): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd), digest = createHash("sha256"), bytes = Buffer.allocUnsafe(64 * 1024);
    if (!before.isFile() || start < 0 || end < start || end > before.size) invalid("invalid digest range");
    for (let at = start; at < end;) {
      const count = readSync(fd, bytes, 0, Math.min(bytes.length, end - at), at);
      if (!count) invalid("source changed while hashing");
      digest.update(bytes.subarray(0, count)); at += count;
    }
    const after = fstatSync(fd), named = lstatSync(file);
    if (!named.isFile() || named.dev !== before.dev || named.ino !== before.ino || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) invalid("source changed while hashing");
    return digest.digest("hex");
  } finally { closeSync(fd); }
}

function stagedScan(manifest: SessionManifest, limits?: Readonly<Limits>, preserveBody = false): { scan: SessionScan; moveId: string } {
  artifactId(manifest.artifactId);
  if (preserveBody) return { scan: frozenScan(manifest, limits ?? DEFAULT_LIMITS), moveId: manifest.artifactId };
  const scan = scanSession(manifest.file, manifest.sessionId, undefined, limits);
  const actual = scan.manifest, marker = scan.lastEntry;
  if (actual.leaf !== manifest.leaf || actual.size !== manifest.size || actual.sha256 !== manifest.sha256 || actual.cwd !== manifest.cwd ||
      marker.type !== "custom" || marker.customType !== "spider-roam-segment") invalid("staged destination does not match manifest");
  const segment = segmentData(marker.data);
  if (segment.moveId !== manifest.artifactId || digestRange(manifest.file, scan.headerBytes, scan.lastLineStart) !== manifest.historySha256) {
    invalid("staged destination history or marker changed");
  }
  return { scan, moveId: segment.moveId };
}

/** Validate installed recovery bytes and the next-epoch marker, not a digest that includes the new marker. */
export async function inspectRestoredSession(file: string, source: SessionManifest, previous: Home, home: Home, limits?: Readonly<Limits>): Promise<SessionManifest> {
  if (!home.moveId || home.sessionId !== source.sessionId || previous.sessionId !== source.sessionId || home.epoch !== previous.epoch + 1)
    invalid("invalid restored home");
  const scan = scanSession(file, source.sessionId, undefined, limits), segment = scan.lastSegment;
  if (!segment || scan.lastSegmentLineStart === null || segment.moveId !== home.moveId || segment.epoch !== home.epoch ||
      segment.nextMachine !== home.machineId || segment.previousMachine !== previous.machineId ||
      digestRange(file, scan.headerBytes, scan.lastSegmentLineStart) !== source.historySha256)
    invalid("restored segment or history does not match home");
  return { ...scan.manifest, artifactId: home.moveId, historySha256: source.historySha256 };
}
function writeAll(fd: number, bytes: Buffer): void {
  for (let at = 0; at < bytes.length;) {
    const count = writeSync(fd, bytes, at, bytes.length - at);
    if (count <= 0) throw new Error("Short session write");
    at += count;
  }
}

interface HeaderEdit { start: number; end: number; bytes: Buffer }
function rewriteHeader(layout: HeaderLayout, cwd: string, parent: string | null | undefined, headerBytes: number): HeaderEdit[] {
  const edits: HeaderEdit[] = [{ start: layout.cwd.valueStart, end: layout.cwd.valueEnd, bytes: Buffer.from(JSON.stringify(cwd)) }];
  if (typeof parent === "string") {
    if (layout.parent) edits.push({ start: layout.parent.valueStart, end: layout.parent.valueEnd, bytes: Buffer.from(JSON.stringify(parent)) });
    else edits.push({ start: layout.close, end: layout.close, bytes: Buffer.from(`,\"parentSession\":${JSON.stringify(parent)}`) });
  } else if (parent === null && layout.parent) {
    const { precedingComma, followingComma, keyStart, valueEnd } = layout.parent;
    if (precedingComma !== null) edits.push({ start: precedingComma, end: valueEnd, bytes: Buffer.alloc(0) });
    else if (followingComma !== null) edits.push({ start: keyStart, end: followingComma + 1, bytes: Buffer.alloc(0) });
    else invalid("invalid parent locator position");
  }
  edits.sort((a, b) => a.start - b.start);
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (edit.start < 0 || edit.end < edit.start || edit.end >= headerBytes || i > 0 && edits[i - 1].end > edit.start) {
      invalid("invalid header rewrite ranges");
    }
  }
  return edits;
}

interface MarkerIdentity { sessionId: string; moveId: string; settings: string; id: string; timestamp: string }
function markerIdentity(store: OutgoingStore, sessionId: string, moveId: string, settings: string): MarkerIdentity {
  const proposed: MarkerIdentity = { sessionId, moveId, settings, id: randomUUID(), timestamp: new Date().toISOString() };
  const bytes = Buffer.from(JSON.stringify(proposed));
  return store.withPreparedFile(moveId, "marker.json", bytes.length, file => {
    const existing = existingRegular(file);
    if (existing) makePrivate(file, existing);
    else {
      const partial = `${file}.part`;
      if (existingRegular(partial)) unlinkSync(partial);
      writeImmutable(file, bytes);
    }
    let value: unknown;
    try { value = JSON.parse(readPrivate(file, bytes.length).toString("utf8")); }
    catch { invalid("invalid staged marker identity"); }
    const identity = object(value);
    if (!identity || identity.sessionId !== sessionId || identity.moveId !== moveId || identity.settings !== settings ||
        !text(identity.id) || !text(identity.timestamp)) invalid("conflicting staged marker identity");
    return identity as unknown as MarkerIdentity;
  });
}

/** Stage the exact source first so later snapshots reuse complete prefix chunks. */
export async function stageSession(
  input: { source: SessionManifest; destinationCwd: string; destinationParent: string | null; segment: Segment; limits?: Limits; preserveBody?: boolean },
  root: string,
): Promise<SessionManifest> {
  const { source, destinationCwd, destinationParent } = input;
  const limits = input.limits ?? DEFAULT_LIMITS;
  if (!isAbsolute(root) || !isAbsolute(destinationCwd) ||
      !(destinationParent === null || text(destinationParent) && isAbsolute(destinationParent))) invalid("invalid destination");
  const segment = segmentData(input.segment);
  const id = artifactId(segment.moveId);
  const scan = frozenScan(source, limits);
  const expectedHistory = input.preserveBody ? segment.historyMachine : scan.firstHistoryMachine ?? segment.previousMachine;
  if (!input.preserveBody && (segment.historyMachine !== expectedHistory || scan.lastSegment &&
      (segment.previousMachine !== scan.lastSegment.nextMachine || segment.epoch <= scan.lastSegment.epoch))) {
    invalid("segment does not continue the source history");
  }
  const parentRef = scan.header.parentSession && destinationParent === null
    ? { machineId: segment.previousMachine, reference: scan.header.parentSession }
    : null;
  const data: Segment = {
    version: 1, moveId: segment.moveId, epoch: segment.epoch, previousMachine: segment.previousMachine,
    nextMachine: segment.nextMachine, historyMachine: expectedHistory, parentRef,
  };
  const artifact = await stageArtifact(source.file, "session", limits, { root, artifactId: id });
  if (artifact.byteLength !== source.size || artifact.sha256 !== source.sha256) invalid("staged source digest changed");
  const store = openOutgoingStaging(root, limits, false);
  try {
    const settings = hash(Buffer.from(JSON.stringify({ destinationCwd, destinationParent, data, ...(input.preserveBody ? { preserveBody: true } : {}) })));
    const identity = markerIdentity(store, source.sessionId, id, settings);
    if (scan.parents.has(identity.id)) invalid("segment marker ID already exists");
    const edits = rewriteHeader(scan.headerLayout, destinationCwd, input.preserveBody ? undefined : destinationParent, scan.headerBytes);
    const leaf = input.preserveBody ? source.leaf : identity.id;
    const markerLine = input.preserveBody ? Buffer.alloc(0) : Buffer.from(`${JSON.stringify({ type: "custom", id: identity.id, parentId: source.leaf,
      timestamp: identity.timestamp, customType: "spider-roam-segment", data })}\n`);
    const size = source.size + edits.reduce((total, edit) => total + edit.bytes.length - (edit.end - edit.start), 0) + markerLine.length;
    if (size > limits.sessionBytes) invalid("staged session exceeds size limit");
    // An older v0 attempt may have already staged the fork without its parent.
    const keepParent = input.preserveBody && (scan.headerLayout.parent || destinationParent !== null);
    const outputKey = hash(Buffer.from(JSON.stringify([source.sha256, source.leaf, ...(keepParent ? ["keep-parent"] : [])])));
    return store.withPreparedFile(id, `${outputKey}.jsonl`, size, output => {
      const directory = dirname(output), temporary = `${output}.part`;
      const existing = existingRegular(output);
      if (existing) makePrivate(output, existing);
      let fd: number | undefined;
      try {
        if (!existing) {
          existingRegular(temporary);
          fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
          if (process.platform !== "win32") fchmodSync(fd, 0o600);
        }
        const assembled = createHash("sha256"), history = createHash("sha256"), outputHash = createHash("sha256");
        const emit = (bytes: Buffer) => { if (fd !== undefined) writeAll(fd, bytes); outputHash.update(bytes); };
        let position = 0, skipTo = 0, editIndex = 0;
        for (const chunk of artifact.chunks) {
          const bytes = readPrivate(sourceChunk(root, id, chunk.index, chunk.sha256), chunk.rawLength);
          if (bytes.length !== chunk.rawLength || hash(bytes) !== chunk.sha256) invalid("corrupt staged source chunk");
          assembled.update(bytes);
          const base = position, end = base + bytes.length;
          while (position < end) {
            if (position < skipTo) { position = Math.min(end, skipTo); continue; }
            const edit = edits[editIndex];
            if (edit && position === edit.start) {
              emit(edit.bytes); skipTo = edit.end; editIndex++;
              continue;
            }
            if (position < scan.headerBytes) {
              const next = Math.min(end, scan.headerBytes, edit?.start ?? end);
              if (next <= position) invalid("invalid header rewrite range");
              emit(bytes.subarray(position - base, next - base)); position = next;
            } else {
              const historyBytes = bytes.subarray(position - base);
              history.update(historyBytes); emit(historyBytes); position = end;
            }
          }
        }
        if (position !== source.size || editIndex !== edits.length || skipTo > position ||
            assembled.digest("hex") !== source.sha256 || history.digest("hex") !== source.historySha256) {
          invalid("assembled source digest changed");
        }
        emit(markerLine);
        const sha256 = outputHash.digest("hex");
        if (fd !== undefined) { fsyncSync(fd); closeSync(fd); fd = undefined; }
        const staged = scanSession(existing ? output : temporary, source.sessionId, leaf, limits);
        if (staged.manifest.size !== size || staged.manifest.sha256 !== sha256 || staged.header.cwd !== destinationCwd) {
          invalid("staged destination verification failed");
        }
        frozenScan(source, limits);
        if (!existing) {
          try { linkSync(temporary, output); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            const published = scanSession(output, source.sessionId, leaf, limits);
            if (published.manifest.size !== size || published.manifest.sha256 !== sha256) invalid("conflicting staged destination");
          }
        }
        if (existingRegular(temporary)) unlinkSync(temporary);
        syncStagingDirectory(directory);
        return { file: output, sessionId: source.sessionId, cwd: destinationCwd, leaf, size, sha256,
          historySha256: source.historySha256, artifactId: id };
      } finally {
        if (fd !== undefined) closeSync(fd);
        if (!existing && existsSync(temporary)) unlinkSync(temporary);
      }
    });
  } finally { store.close(); }
}

function existingRegular(file: string): Stats | null {
  let stat: Stats;
  try { stat = lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || process.platform !== "win32" && uid !== undefined && stat.uid !== uid) {
    invalid("unsafe destination or foreign owner");
  }
  return stat;
}

function makePrivate(file: string, expected: Stats): void {
  if (process.platform === "win32" || (expected.mode & 0o7777) === 0o600) return;
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = fstatSync(fd);
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) invalid("prepared file changed");
    fchmodSync(fd, 0o600); fsyncSync(fd);
  } finally { closeSync(fd); }
}

function copyVerified(source: string, target: string, size: number, expected: string): void {
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output: number | undefined;
  try {
    const before = fstatSync(input);
    if (!before.isFile() || before.size !== size) invalid("source changed while copying");
    output = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    if (process.platform !== "win32") fchmodSync(output, 0o600);
    const digest = createHash("sha256"), bytes = Buffer.allocUnsafe(64 * 1024);
    for (let at = 0; at < size;) {
      const count = readSync(input, bytes, 0, Math.min(bytes.length, size - at), at);
      if (!count) invalid("source changed while copying");
      const chunk = bytes.subarray(0, count);
      digest.update(chunk); writeAll(output, chunk); at += count;
    }
    const after = fstatSync(input), named = lstatSync(source);
    if (!named.isFile() || named.dev !== before.dev || named.ino !== before.ino || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || digest.digest("hex") !== expected) {
      invalid("source changed while copying");
    }
    fsyncSync(output);
  } finally {
    if (output !== undefined) closeSync(output);
    closeSync(input);
  }
}

function ensureBackup(target: string, backup: string, prior: SessionManifest): void {
  const verify = (): boolean => {
    const stat = existingRegular(backup);
    if (!stat) return false;
    if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600 || stat.size !== prior.size ||
        digestRange(backup, 0, stat.size) !== prior.sha256) invalid("conflicting private backup");
    return true;
  };
  if (verify()) return;
  const temporary = join(dirname(target), `.${randomUUID()}.backup-part`);
  try {
    copyVerified(target, temporary, prior.size, prior.sha256);
    try { linkSync(temporary, backup); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !verify()) throw error;
    }
    syncStagingDirectory(dirname(target));
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export interface SessionInstallPorts {
  journal: Journal;
  preserveBody?: boolean;
  limits?: Readonly<Limits>;
  ownership(): Promise<Probe>;
  withBothLocks<T>(sessionId: string, fn: () => Promise<T>): Promise<T>;
}

/** The caller's lock adapter holds the ID and exact-file leases for the whole callback. */
export async function installSession(manifest: SessionManifest, target: string, ports: SessionInstallPorts): Promise<void> {
  if (!isAbsolute(target) || resolve(target) !== target || target === manifest.file) invalid("invalid destination path");
  await ports.withBothLocks(manifest.sessionId, async () => {
    const { scan, moveId } = stagedScan(manifest, ports.limits, ports.preserveBody);
    if ((await ports.ownership()).kind !== "absent") invalid("destination owner is live or uncertain");
    ports.journal.record(moveId, "session-install-intent", { file: target, artifactId: manifest.artifactId, sha256: manifest.sha256 });
    const directory = dirname(target);
    privateDirectory(directory);
    const targetStat = existingRegular(target);
    let prior: SessionScan | null = null, backup: string | null = null;
    if (targetStat) {
      prior = scanSession(target, manifest.sessionId, undefined, ports.limits);
      if (prior.manifest.size === manifest.size && prior.manifest.sha256 === manifest.sha256) {
        stagedScan({ ...manifest, file: target }, ports.limits, ports.preserveBody);
        ports.journal.record(moveId, "session-install-complete", { file: target, sha256: manifest.sha256 });
        return;
      }
      const length = prior.manifest.size - prior.headerBytes;
      if (length > (ports.preserveBody ? scan.manifest.size : scan.lastLineStart) - scan.headerBytes ||
          digestRange(manifest.file, scan.headerBytes, scan.headerBytes + length) !== prior.manifest.historySha256) {
        invalid("prior session history diverged");
      }
      backup = join(directory, `.${basename(target)}.${manifest.artifactId}.backup`);
      ports.journal.record(moveId, "session-backup-intent", { file: backup, sha256: prior.manifest.sha256 });
      ensureBackup(target, backup, prior.manifest);
      ports.journal.record(moveId, "session-backup-complete", { file: backup, sha256: prior.manifest.sha256 });
    }
    const temporary = join(directory, `.${randomUUID()}.session-part`);
    try {
      copyVerified(manifest.file, temporary, manifest.size, manifest.sha256);
      stagedScan({ ...manifest, file: temporary }, ports.limits, ports.preserveBody);
      syncStagingDirectory(directory);
      if ((await ports.ownership()).kind !== "absent") invalid("destination owner is live or uncertain");
      const current = existingRegular(target);
      if (prior) {
        if (!current) invalid("prior destination disappeared");
        const checked = scanSession(target, manifest.sessionId, undefined, ports.limits);
        if (checked.manifest.size !== prior.manifest.size || checked.manifest.sha256 !== prior.manifest.sha256) {
          invalid("prior destination changed");
        }
      } else if (current) invalid("destination appeared during installation");
      ports.journal.record(moveId, "session-install-publish", { file: target, sha256: manifest.sha256, backup });
      renameSync(temporary, target);
      syncStagingDirectory(directory);
      ports.journal.record(moveId, "session-install-complete", { file: target, sha256: manifest.sha256 });
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  });
}
