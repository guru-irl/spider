import { readFileSync, statSync, readdirSync, openSync, readSync, closeSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { NormalizedTranscript } from "./digest";

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } => !!b && typeof b === "object" && (b as any).type === "text" && typeof (b as any).text === "string")
      .map((b) => b.text)
      .join(" ");
  }
  return "";
}

/** Normalize an already-selected branch. Thinking and non-message metadata are not prose. */
export function normalizeTranscriptEntries(entries: readonly unknown[]): NormalizedTranscript["messages"] {
  const messages: NormalizedTranscript["messages"] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    // Native pi JSONL wraps role/content in `message`; old imports used flat rows.
    const message = entry.type === "message" && entry.message && typeof entry.message === "object"
      ? entry.message as Record<string, unknown>
      : entry;
    if (typeof message.role !== "string") continue;
    const text = extractText(message.content);
    if (text.trim()) messages.push({ role: message.role, text });
  }
  return messages;
}

function activeBranch(entries: Record<string, unknown>[]): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  let leaf: string | undefined;
  for (const entry of entries) {
    if (typeof entry.id === "string" && (entry.parentId === null || typeof entry.parentId === "string")) {
      byId.set(entry.id, entry);
      leaf = entry.id;
    }
  }
  if (!leaf) return entries; // Legacy flat transcripts have no tree metadata.
  const branch: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  while (leaf && !seen.has(leaf)) {
    seen.add(leaf);
    const entry = byId.get(leaf);
    if (!entry) break; // Tolerate an incomplete tail without replaying unrelated branches.
    branch.push(entry);
    leaf = typeof entry.parentId === "string" ? entry.parentId : undefined;
  }
  return branch.reverse();
}

/**
 * Read a native pi session's active branch (or a legacy flat transcript).
 * Non-message entries remain in the parent chain but are not conversation text.
 * Tolerant of malformed lines and unreadable files: never throws.
 */
export function readTranscript(sourcePath: string): NormalizedTranscript {
  const fallbackId = basename(sourcePath).replace(/\.jsonl$/, "");
  let raw: string;
  try {
    raw = readFileSync(sourcePath, "utf8");
  } catch {
    return { sessionId: fallbackId, sourcePath, messages: [] };
  }

  let sessionId = fallbackId;
  const entries: Record<string, unknown>[] = [];

  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;

    if (entry.type === "session" && typeof entry.id === "string") {
      sessionId = entry.id;
      continue;
    }

    entries.push(entry);
  }

  return { sessionId, sourcePath, messages: normalizeTranscriptEntries(activeBranch(entries)) };
}

function walk(dir: string, recursive = true): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir, { recursive } as any) as unknown as string[];
  } catch {
    return out;
  }
  for (const rel of entries) {
    if (typeof rel === "string" && rel.endsWith(".jsonl")) {
      const file = join(dir, rel);
      try { if (recursive || statSync(file).isFile()) out.push(file); } catch { /* unreadable entry */ }
    }
  }
  return out;
}

// Pi normalizes session-dir and cwd paths before it uses them.
function piPath(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || (process.platform === "win32" && input.startsWith("~\\"))) return join(homedir(), input.slice(2));
  if (input.startsWith("file://")) return fileURLToPath(input);
  return input;
}

function sessionMatchesCwd(file: string, cwd: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(1024 * 1024);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, bytes).toString("utf8").split("\n", 1)[0];
    const header = JSON.parse(line) as { type?: unknown; cwd?: unknown };
    return header.type === "session" && typeof header.cwd === "string" && header.cwd !== ""
      && resolve(piPath(header.cwd)) === resolve(piPath(cwd));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function defaultProjectDir(base: string, cwd: string): string {
  const encoded = "--" + resolve(piPath(cwd)).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
  return join(resolve(base), encoded);
}

export function selectSessionFiles(opts: {
  project?: string;
  all?: boolean;
  since?: number;
  glob?: string;
  cwd: string;
  sessionDirectory?: string;
  sessionDirectoryCwd?: string;
}): string[] {
  const base = join(getAgentDir(), "sessions");
  const selected = opts.sessionDirectory;
  const customDir = selected
    ? resolve(piPath(selected)) === defaultProjectDir(base, opts.sessionDirectoryCwd ?? opts.cwd) ? undefined : selected
    : process.env.PI_CODING_AGENT_SESSION_DIR;
  const cwd = opts.project ?? opts.cwd;

  let dirs: string[] = [];
  if (customDir) {
    dirs = [piPath(customDir)];
  } else if (opts.all) {
    try {
      dirs = readdirSync(base).map((d) => join(base, d));
    } catch {
      dirs = [];
    }
  } else {
    dirs = [defaultProjectDir(base, cwd)];
  }

  let files: string[] = [];
  for (const dir of dirs) {
    try {
      files = files.concat(walk(dir, !customDir));
    } catch {
      // ignore unreadable dir
    }
  }

  if (customDir && !opts.all) files = files.filter((f) => sessionMatchesCwd(f, cwd));

  if (opts.since !== undefined) {
    files = files.filter((f) => {
      try {
        return statSync(f).mtimeMs >= opts.since!;
      } catch {
        return false;
      }
    });
  }

  if (opts.glob) {
    files = files.filter((f) => f.includes(opts.glob!));
  }

  return files;
}
