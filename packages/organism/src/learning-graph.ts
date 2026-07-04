import type { Db } from "@spider/db-core";
import { listActive } from "@spider/memory";
import { SkillStore } from "./skill-usage.js";

/** A node in the learning graph — a learned skill or an active memory chunk. */
export interface GraphNode {
  id: string;
  label: string;
  kind: "skill" | "memory";
  category?: string;
}

/** A directed link between two node ids (skill↔skill or memory→skill). */
export interface GraphEdge {
  source: string;
  target: string;
}

/** The assembled learning graph plus edge-density stats. */
export interface LearningGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: { nodes: number; edges: number; linkedPct: number };
}

/**
 * Port of `learning_graph._tokenize`: lowercase, split on non-alphanumeric
 * runs, and keep tokens of length ≥ 3.
 */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 3) out.add(t);
  }
  return out;
}

/** Short single-line label for a memory chunk (port of card `title`). */
function memoryLabel(content: string): string {
  const first = (content.split("\n")[0] ?? "").replace(/^#+\s*/, "").trim();
  return first.length > 80 ? `${first.slice(0, 80)}…` : first;
}

interface ScoredSkill {
  score: number;
  name: string;
}

/**
 * Port of `learning_graph._memory_skill_edges`: for a memory's content, score
 * each skill by lexical token overlap plus a substring bonus when the skill
 * name appears verbatim, then keep the top-4 skills with a positive score.
 */
function memorySkillEdges(
  memoryId: string,
  content: string,
  skills: { name: string; category?: string }[]
): GraphEdge[] {
  const text = content.toLowerCase();
  const textTokens = tokenize(content);
  const scored: ScoredSkill[] = [];
  for (const skill of skills) {
    const nameLower = skill.name.toLowerCase();
    const skillTokens = tokenize(`${skill.name} ${skill.category ?? ""}`);
    let score = 0;
    if (text.includes(nameLower)) score += 6;
    for (const tok of skillTokens) if (textTokens.has(tok)) score += 1;
    if (score > 0) scored.push({ score, name: skill.name });
  }
  scored.sort((x, y) => (y.score !== x.score ? y.score - x.score : x.name.localeCompare(y.name)));
  return scored.slice(0, 4).map((s) => ({ source: memoryId, target: s.name }));
}

const INSIGHTS_DDL = `CREATE TABLE IF NOT EXISTS insights (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL,
  a TEXT, b TEXT, weight REAL, payload TEXT, created_at INTEGER NOT NULL
)`;

/**
 * Assemble the "learning made visible" graph from the project's skills and
 * active memories, then optionally persist it as `insights` rows on `globalDb`.
 *
 * Ports `hermes-agent/agent/learning_graph.py` (`build_edges`,
 * `_memory_skill_edges`, `_tokenize`) retargeted to DB rows.
 */
export function buildLearningGraph(
  projectDb: Db,
  globalDb: Db,
  opts?: { persist?: boolean }
): LearningGraph {
  const skills = new SkillStore(projectDb).list().filter((s) => s.state !== "archived");
  const skillNames = new Set(skills.map((s) => s.name));

  const nodes: GraphNode[] = [];
  for (const s of skills) {
    const node: GraphNode = { id: s.name, label: s.name, kind: "skill" };
    if (s.category !== undefined) node.category = s.category;
    nodes.push(node);
  }

  const edges: GraphEdge[] = [];
  const edgeWeights: number[] = [];

  // Skill↔skill edges from each skill's declared `related` list.
  for (const s of skills) {
    for (const target of s.related ?? []) {
      if (target !== s.name && skillNames.has(target)) {
        edges.push({ source: s.name, target });
        edgeWeights.push(1);
      }
    }
  }

  // Memory nodes + memory→skill lexical-overlap edges.
  const skillMeta = skills.map((s) => ({ name: s.name, category: s.category }));
  for (const mem of listActive(projectDb, "project")) {
    const node: GraphNode = {
      id: mem.uuid,
      label: memoryLabel(mem.content),
      kind: "memory",
      category: mem.category,
    };
    nodes.push(node);
    for (const e of memorySkillEdges(mem.uuid, mem.content, skillMeta)) {
      edges.push(e);
      edgeWeights.push(1);
    }
  }

  const linked = new Set<string>();
  for (const e of edges) {
    linked.add(e.source);
    linked.add(e.target);
  }
  const linkedPct = nodes.length === 0 ? 0 : (100 * linked.size) / nodes.length;
  const stats = { nodes: nodes.length, edges: edges.length, linkedPct };

  if (opts?.persist === true) {
    globalDb.exec(INSIGHTS_DDL);
    const insertNode = globalDb.prepare(
      "INSERT INTO insights (kind, a, b, weight, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const insertEdge = globalDb.prepare(
      "INSERT INTO insights (kind, a, b, weight, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const run = globalDb.transaction(() => {
      const now = Date.now();
      for (const n of nodes) {
        const payload = JSON.stringify({ label: n.label, kind: n.kind, category: n.category });
        insertNode.run("node", n.id, null, null, payload, now);
      }
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i]!;
        insertEdge.run("edge", e.source, e.target, edgeWeights[i] ?? 1, null, now);
      }
    });
    run();
  }

  return { nodes, edges, stats };
}
