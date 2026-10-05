// The ingest parser consumes metadata/usage, not message bodies. Project before
// JSON.parse, rather than after: one tool-result line can exceed the worker heap.
const ROOT = new Set(["type", "id", "parentId", "timestamp", "cwd", "parentSession", "modelId", "thinkingLevel", "kind", "note", "usage", "provider", "model", "responseModel", "latencyMs", "api", "message"]);
const MESSAGE = new Set(["role", "timestamp", "provider", "model", "responseModel", "providerThinkingLevel", "responseId", "usage", "latencyMs", "api", "toolName"]);
const MAX_METADATA = 1024 * 1024;
const MAX_DEPTH = 512;
type Frame = { kind: "object" | "array"; state: "key-or-end" | "key" | "colon" | "value" | "value-or-end" | "comma-or-end"; emit: boolean; scope: "root" | "message" | "all"; key?: string };
const whitespace = (b: number) => b === 32 || b === 9 || b === 10 || b === 13;
const delimiter = (b: number) => whitespace(b) || b === 44 || b === 125 || b === 93;

/** Bounded metadata, bounded stack, no storage for ignored strings/containers.
 * All JSON syntax is validated, even in discarded values. An incomplete or bad
 * line follows ingest's ordinary parse-error path, never a partial cursor commit.
 */
export class UsageJsonLine {
  private frames: Frame[] = [];
  private output = Buffer.allocUnsafe(4096);
  private length = 0;
  private failed = false;
  private started = false;
  private done = false;
  private token: "string" | "primitive" | undefined;
  private emit = false;
  private key = false;
  private keyBytes: number[] | undefined;
  private escape = false;
  private unicode = 0;
  private primitive = "";

  private append(b: number): void {
    if (this.length >= MAX_METADATA) { this.failed = true; return; }
    if (this.length === this.output.length) {
      const next = Buffer.allocUnsafe(Math.min(MAX_METADATA, this.output.length * 2));
      this.output.copy(next); this.output = next;
    }
    this.output[this.length++] = b;
  }
  private complete(): void {
    const parent = this.frames.at(-1);
    if (parent) parent.state = "comma-or-end";
    else this.done = true;
  }
  private begin(b: number): void {
    const parent = this.frames.at(-1);
    let emit = parent?.emit ?? b === 123;
    let scope: Frame["scope"] = parent ? "all" : "root";
    if (parent?.kind === "object" && parent.scope !== "all") {
      emit = parent.emit && (parent.scope === "root" ? ROOT : MESSAGE).has(parent.key ?? "");
      if (parent.scope === "root" && parent.key === "message") scope = "message";
    }
    // Output a placeholder once, not the discarded container's descendants.
    if (!emit && (parent?.emit || !parent)) for (const byte of [110, 117, 108, 108]) this.append(byte);
    this.started = true;
    this.emit = emit;
    if (b === 123 || b === 91) {
      if (emit) this.append(b);
      if (this.frames.length >= MAX_DEPTH) { this.failed = true; return; }
      this.frames.push({ kind: b === 123 ? "object" : "array", state: b === 123 ? "key-or-end" : "value-or-end", emit, scope });
    } else if (b === 34) {
      this.token = "string"; this.key = false; this.escape = false; this.unicode = 0;
      if (emit) this.append(b);
    } else {
      this.token = "primitive"; this.primitive = String.fromCharCode(b);
      if (emit) this.append(b);
    }
  }
  private finishPrimitive(): void {
    if (!/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)$/.test(this.primitive)) this.failed = true;
    this.token = undefined; this.complete();
  }
  write(bytes: Buffer): void {
    for (const b of bytes) {
      if (this.failed) return;
      if (this.token === "string") {
        if (this.emit) this.append(b);
        if (this.keyBytes) {
          if (this.keyBytes.length >= 4096) { this.failed = true; return; }
          this.keyBytes.push(b);
        }
        if (this.unicode) {
          if (!(b >= 48 && b <= 57 || b >= 65 && b <= 70 || b >= 97 && b <= 102)) this.failed = true;
          this.unicode--; continue;
        }
        if (this.escape) {
          this.escape = false;
          if (b === 117) this.unicode = 4;
          else if (![34, 92, 47, 98, 102, 110, 114, 116].includes(b)) this.failed = true;
          continue;
        }
        if (b === 92) { this.escape = true; continue; }
        if (b < 32) { this.failed = true; continue; }
        if (b !== 34) continue;
        this.token = undefined;
        if (this.key) {
          const frame = this.frames.at(-1)!;
          if (this.keyBytes) {
            try { frame.key = JSON.parse(Buffer.from(this.keyBytes).toString("utf8")); }
            catch { this.failed = true; }
          }
          this.keyBytes = undefined; frame.state = "colon";
        } else this.complete();
        continue;
      }
      if (this.token === "primitive") {
        if (!delimiter(b)) {
          if (this.primitive.length >= 4096) { this.failed = true; return; }
          this.primitive += String.fromCharCode(b);
          if (this.emit) this.append(b);
          continue;
        }
        this.finishPrimitive();
        if (this.failed) return;
      }
      if (whitespace(b)) continue;
      if (this.done) { this.failed = true; return; }
      const frame = this.frames.at(-1);
      if (!frame) { this.begin(b); continue; }
      const close = frame.kind === "object" ? 125 : 93;
      if (b === close && ["key-or-end", "value-or-end", "comma-or-end"].includes(frame.state)) {
        if (frame.emit) this.append(b);
        this.frames.pop(); this.complete(); continue;
      }
      if (frame.state === "key-or-end" || frame.state === "key") {
        if (b !== 34) { this.failed = true; return; }
        this.token = "string"; this.key = true; this.emit = frame.emit; this.escape = false; this.unicode = 0;
        this.keyBytes = frame.emit && frame.scope !== "all" ? [34] : undefined;
        if (frame.emit) this.append(b);
      } else if (frame.state === "colon") {
        if (b !== 58) { this.failed = true; return; }
        if (frame.emit) this.append(b);
        frame.state = "value";
      } else if (frame.state === "comma-or-end") {
        if (b !== 44) { this.failed = true; return; }
        if (frame.emit) this.append(b);
        frame.state = frame.kind === "object" ? "key" : "value";
      } else this.begin(b);
    }
  }
  finish(): unknown {
    if (this.token === "primitive") this.finishPrimitive();
    if (this.failed || !this.started || !this.done || this.frames.length || this.token) return undefined;
    try { return JSON.parse(this.output.subarray(0, this.length).toString("utf8")); }
    catch { return undefined; }
  }
}
