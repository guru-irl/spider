import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SPIDER_BLOCK_START, SPIDER_BLOCK_END, buildSpiderBlock } from "./agentsmd-content.js";

export function isLegacyFiveToolGuide(existing: string): boolean {
  return /^#\s*Agent operating guide \(global\)/m.test(existing)
    && /##\s*Task tracking\s*—?\s*`?todo`?/.test(existing);
}

export function upsertManagedBlock(existing: string | null, block: string): string {
  if (existing == null || existing.trim() === "") return `${block}\n`;
  const start = existing.indexOf(SPIDER_BLOCK_START);
  const end = existing.indexOf(SPIDER_BLOCK_END);
  if (start !== -1 && end !== -1 && end > start) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + SPIDER_BLOCK_END.length);
    return `${before}${block}${after}`;
  }
  if (isLegacyFiveToolGuide(existing)) return `${block}\n`;
  return `${block}\n\n${existing}`;
}

export function defaultAgentsMdPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "AGENTS.md");
}

export function writeAgentsMd(agentsMdPath: string): { path: string; action: "created" | "updated" | "unchanged" } {
  const block = buildSpiderBlock();
  let existing: string | null = null;
  let existed = false;
  try {
    existing = fs.readFileSync(agentsMdPath, "utf8");
    existed = true;
  } catch {
    existing = null;
  }
  const next = upsertManagedBlock(existing, block);
  if (existed && next === existing) return { path: agentsMdPath, action: "unchanged" };
  fs.mkdirSync(path.dirname(agentsMdPath), { recursive: true });
  fs.writeFileSync(agentsMdPath, next, "utf8");
  return { path: agentsMdPath, action: existed ? "updated" : "created" };
}
