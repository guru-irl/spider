import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import type { DockedFacts } from "@spider/ui";

const MAX_FILE_BYTES = 192 * 1024;
const MAX_VISIT_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 128;
const MAX_IN_FLIGHT = 16;
const MAX_DIFF_WORK = 2_000_000;

interface PendingChange { path: string; before?: string; overlaps: boolean }
interface TextChange { before: string; after: string }
interface VisitChanges {
  files: Map<string, TextChange | null>;
  pending: Map<string, PendingChange>;
  missing: boolean;
  bytes: number;
}

export function newVisitChanges(): VisitChanges {
  return { files: new Map(), pending: new Map(), missing: false, bytes: 0 };
}

async function editPath(cwd: string, input: string): Promise<string> {
  const name = input.replace(/^@/u, "").replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000]/gu, " ");
  const path = resolve(cwd, name === "~" ? homedir() : name.startsWith("~/") ? join(homedir(), name.slice(2)) : name);
  try { return await realpath(path); }
  catch {
    try { return join(await realpath(dirname(path)), basename(path)); }
    catch { return path; }
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    const fd = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await fd.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
      const buffer = Buffer.allocUnsafe(stat.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await fd.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== stat.size) return undefined;
      const bytes = buffer.subarray(0, offset);
      if (bytes.includes(0)) return undefined;
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } finally { await fd.close(); }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "" : undefined;
  }
}

export async function beginChange(state: VisitChanges, cwd: string, id: string, input: unknown): Promise<void> {
  if (typeof input !== "string" || !input || state.pending.size >= MAX_IN_FLIGHT) { state.missing = true; return; }
  const path = await editPath(cwd, input);
  if (state.pending.size >= MAX_IN_FLIGHT) { state.missing = true; return; }
  const pending: PendingChange = { path, overlaps: false };
  for (const other of state.pending.values()) {
    if (other.path === path) other.overlaps = pending.overlaps = true;
  }
  state.pending.set(id, pending);
  pending.before = await readText(path);
}

function bytes(change: TextChange | null | undefined): number {
  return change ? 2 * (change.before.length + change.after.length) : 0;
}

export async function finishChange(state: VisitChanges, id: string, failed: boolean): Promise<void> {
  const pending = state.pending.get(id);
  if (!pending) { if (!failed) state.missing = true; return; }
  try {
    if (failed) return;
    const { path, before } = pending;
    const after = await readText(path), first = state.files.get(path);
    if (first === null) return;
    if (!first && state.files.size >= MAX_FILES) { state.missing = true; return; }
    state.bytes -= bytes(first);
    const next = !pending.overlaps && before !== undefined && after !== undefined && (!first || before === first.after)
      ? { before: first?.before ?? before, after } : null;
    if (!next || state.bytes + bytes(next) > MAX_VISIT_BYTES) state.files.set(path, null);
    else { state.bytes += bytes(next); state.files.set(path, next); }
  } finally { state.pending.delete(id); }
}

export function summarizeChanges(state: VisitChanges): DockedFacts["changes"] {
  const totals = { added: 0, removed: 0, partial: state.missing || state.pending.size > 0 };
  let workLeft = MAX_DIFF_WORK;
  const lines = (text: string) => text ? text.split(/(?<=\n)/u) : [];
  for (const change of state.files.values()) {
    if (!change) { totals.partial = true; continue; }
    if (change.before === change.after) continue;
    const old = lines(change.before), next = lines(change.after);
    let start = 0, endOld = old.length, endNext = next.length;
    while (start < endOld && start < endNext && old[start] === next[start]) start++;
    while (endOld > start && endNext > start && old[endOld - 1] === next[endNext - 1]) { endOld--; endNext--; }
    const oldCount = endOld - start, nextCount = endNext - start;
    if (!oldCount || !nextCount) { totals.removed += oldCount; totals.added += nextCount; continue; }
    const work = oldCount * nextCount;
    if (work > workLeft || oldCount + nextCount > 3000) { totals.partial = true; continue; }
    workLeft -= work;
    const patch = generateUnifiedPatch("visit", old.slice(start, endOld).join(""), next.slice(start, endNext).join(""), 0);
    let inHunk = false;
    for (const line of patch.split("\n")) {
      if (line.startsWith("@@ ")) inHunk = true;
      else if (inHunk && line.startsWith("+")) totals.added++;
      else if (inHunk && line.startsWith("-")) totals.removed++;
    }
  }
  return totals;
}
