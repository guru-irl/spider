import type { Db } from "@spider/db-core";

export type MemoryCategory = "preference" | "convention" | "tool-quirk" | "failure" | "correction" | "insight";
export type MemoryStatus = "active" | "staged" | "rejected" | "archived";
export type MemorySource = "user" | "auto" | "import";
export type MemoryScope = "global" | "repo" | "worktree" | "project";

export interface MemoryRecord {
  id: number;
  uuid: string;
  category: MemoryCategory;
  content: string;
  link: string | null;
  status: MemoryStatus;
  source: MemorySource;
  confidence: number | null;
  sessionId: string | null;
  createdAt: number;
  updatedAt: number | null;
}

export interface AddMemoryInput {
  category: MemoryCategory;
  content: string;
  link?: string | null;
  status?: MemoryStatus;
  source?: MemorySource;
  confidence?: number | null;
  sessionId?: string | null;
}
