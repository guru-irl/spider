import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
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

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir, { recursive: true } as any) as unknown as string[];
  } catch {
    return out;
  }
  for (const rel of entries) {
    if (typeof rel === "string" && rel.endsWith(".jsonl")) {
      out.push(join(dir, rel));
    }
  }
  return out;
}

export function selectSessionFiles(opts: {
  project?: string;
  all?: boolean;
  since?: number;
  glob?: string;
  cwd: string;
}): string[] {
  const base = join(homedir(), ".pi", "agent", "sessions");

  let dirs: string[] = [];
  if (opts.all) {
    try {
      dirs = readdirSync(base).map((d) => join(base, d));
    } catch {
      dirs = [];
    }
  } else {
    const cwd = opts.project ?? opts.cwd;
    const encoded = "--" + cwd.replace(/\//g, "-") + "--";
    dirs = [join(base, encoded)];
  }

  let files: string[] = [];
  for (const dir of dirs) {
    try {
      files = files.concat(walk(dir));
    } catch {
      // ignore unreadable dir
    }
  }

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
