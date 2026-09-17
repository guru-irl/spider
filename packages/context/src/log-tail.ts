import { openSync, closeSync, fstatSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

/**
 * Incremental file tail — restores pre-handoff streaming (I1) for backgrounded execs
 * without a pipe. A backgrounded child's stdout/stderr are files on disk (see
 * executor.ts), never a pipe to this process, so the only way to observe bytes AS
 * THEY ARRIVE is to poll the files and read what's new since the last offset.
 *
 * Deliberately NOT `fs.watch`-based: watch semantics (coalescing, rename vs change,
 * inotify/FSEvents/kqueue differences) are inconsistent enough across platforms and
 * filesystems that a plain poll is the more predictable choice here.
 */
export interface LogTail {
  /** Stop polling. Idempotent — safe to call more than once, and safe to call after
   *  the files have already been fully drained. No callback fires after this returns. */
  stop(): void;
}

export interface LogTailOptions {
  /** Poll interval, ms. Default 120ms — matches the probe in the design review. */
  intervalMs?: number;
  /** Max bytes read in a single poll tick, per file. Bounds the read call itself
   *  (not a total-output cap — a full log file is unbounded by policy). Reusing the
   *  executor's hardCapBytes keeps this within the same budget the old pipe path
   *  enforced, rather than inventing a second unrelated number. */
  maxBytes?: number;
}

const DEFAULT_INTERVAL_MS = 120;
const DEFAULT_MAX_BYTES = 1024 * 1024; // 1MB/tick — generous but bounded

/** Per-file poll state: a lazily-opened fd, the next offset to read from, and a
 *  StringDecoder so a multi-byte UTF-8 sequence split across two reads is held back
 *  and completed on the next read instead of being emitted as U+FFFD or dropped. */
class FileCursor {
  #path: string;
  #fd: number | undefined;
  #offset = 0;
  #decoder = new StringDecoder("utf-8");

  constructor(path: string) {
    this.#path = path;
  }

  /** Read whatever is new since the last call, bounded to `maxBytes`. Returns "" if
   *  the file doesn't exist yet, hasn't grown, or a transient read error occurs —
   *  never throws (a poll loop must not die because a file is mid-rotation/missing). */
  poll(maxBytes: number): string {
    if (this.#fd === undefined) {
      try {
        this.#fd = openSync(this.#path, "r");
      } catch {
        return ""; // not created yet — try again next tick
      }
    }
    let size: number;
    try {
      size = fstatSync(this.#fd).size;
    } catch {
      return "";
    }
    if (size <= this.#offset) return "";
    const toRead = Math.min(maxBytes, size - this.#offset);
    const buf = Buffer.alloc(toRead);
    let bytesRead: number;
    try {
      bytesRead = readSync(this.#fd, buf, 0, toRead, this.#offset);
    } catch {
      return "";
    }
    if (bytesRead <= 0) return "";
    this.#offset += bytesRead;
    // StringDecoder.write buffers an incomplete trailing multi-byte sequence
    // internally and prepends it to the next write() call automatically.
    return this.#decoder.write(buf.subarray(0, bytesRead));
  }

  close(): void {
    if (this.#fd !== undefined) {
      try {
        closeSync(this.#fd);
      } catch {
        /* already closed / gone */
      }
      this.#fd = undefined;
    }
  }
}

/**
 * Poll `paths.stdout`/`paths.stderr` for bytes appended since the last read and
 * forward them to `onData` as they arrive. Each file is opened lazily (a background
 * child's log file may not exist yet the instant this is called) and tracked by a
 * byte offset — never re-reading what was already delivered. Split multi-byte UTF-8
 * sequences at a chunk boundary are held back and completed on the next read (see
 * StringDecoder), never emitted as replacement characters or dropped.
 */
export function tailLogs(
  paths: { stdout: string; stderr: string },
  onData: (chunk: string) => void,
  opts?: LogTailOptions,
): LogTail {
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const stdoutCursor = new FileCursor(paths.stdout);
  const stderrCursor = new FileCursor(paths.stderr);
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    const out = stdoutCursor.poll(maxBytes);
    if (out) onData(out);
    if (stopped) return; // onData may have triggered a synchronous stop()
    const err = stderrCursor.poll(maxBytes);
    if (err) onData(err);
  };

  const timer = setInterval(tick, intervalMs);
  // Never let this poller alone keep the process/event loop alive — it is always
  // stopped explicitly on every settle path; unref() is just defense in depth so a
  // missed stop() cannot hang a process exit.
  timer.unref?.();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      // I1: one last bounded read per cursor BEFORE closing the fds. Anything
      // written between the previous tick and the moment stop() is called
      // (e.g. a final line with no trailing sleep after it) would otherwise
      // never reach onData — the poll loop has already been cancelled above,
      // so nothing else will ever read it. This flush uses the SAME bounded
      // poll() as every tick (still capped at maxBytes), it is just guaranteed
      // to happen exactly once more, synchronously, before the fds close.
      const out = stdoutCursor.poll(maxBytes);
      if (out) onData(out);
      const err = stderrCursor.poll(maxBytes);
      if (err) onData(err);
      stdoutCursor.close();
      stderrCursor.close();
    },
  };
}
