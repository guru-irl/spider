import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { NormalizedTranscript } from "./digest.js";

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

/**
 * Reads a pi session transcript (.jsonl) and normalizes it into a flat
 * { role, text } message list. Tolerant of malformed lines and unreadable
 * files: never throws.
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
  const messages: Array<{ role: string; text: string }> = [];

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

    const isMessage = typeof entry.role === "string" || entry.type === "message";
    if (!isMessage) continue;
    if (typeof entry.role !== "string") continue;

    messages.push({ role: String(entry.role), text: extractText(entry.content) });
  }

  return { sessionId, sourcePath, messages };
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
