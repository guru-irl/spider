import { bundledSkillCollections, type BundledSkillCollection } from "@spider/superpowers";
import type { SkillRow } from "./skill-usage.js";

/** Read-only display entries have no database identity or lifecycle timestamps. */
export interface BundledSkill {
  name: string;
  source: BundledSkillCollection["source"];
  tier: "baseline";
  path: string;
  candidateBody?: string;
  state: "active";
  status: "active";
  pinned: false;
  protected: true;
  useCount: 0;
}
export type SkillInventoryEntry = BundledSkill | (SkillRow & { sourceLabel?: "project/agent-created" });

export function skillInventory(rows: SkillRow[]): SkillInventoryEntry[] {
  const bundled: BundledSkill[] = bundledSkillCollections().flatMap(collection => collection.skills.map(skill => ({
    ...skill,
    source: collection.source,
    tier: "baseline",
    state: "active",
    status: "active",
    pinned: false,
    protected: true,
    useCount: 0,
  })));
  return [...bundled, ...rows.map(row => ({ ...row, sourceLabel: "project/agent-created" as const }))]
    .sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
}
