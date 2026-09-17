import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { paths } from "@spider/db-core";
import { makeOrgDb } from "./helpers/tmpdb.js";
import { SkillStore } from "../skill-usage.js";
import { skillAction, type OrganismActionDeps } from "../actions.js";

// F5 (dataflow-review.md): SkillStore.approveCandidate/rejectCandidate had no
// production caller, and approval cleared the only stored body without ever
// writing a file, so an "approved" skill could never actually be loaded by
// pi. These tests exercise the real fix: a fallible approveCandidate that
// validates the name, materializes a discoverable SKILL.md with a no-clobber
// write, verifies containment, and only then flips the DB row to active.

let ctx: ReturnType<typeof makeOrgDb>;
let projectRoot: string;
let extraDirs: string[] = [];
afterEach(() => {
  ctx?.cleanup();
  if (projectRoot !== undefined) rmSync(projectRoot, { recursive: true, force: true });
  for (const d of extraDirs) rmSync(d, { recursive: true, force: true });
  extraDirs = [];
});

function makeProjectRoot(): string {
  const root = join(paths.scratch("worktree", process.cwd()), `skill-approval-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function skillFilePath(root: string, name: string): string {
  return join(root, ".spider", "skills", name, "SKILL.md");
}

describe("SkillStore.approveCandidate — safe materialization", () => {
  it("rejects an unsafe name (path traversal attempt) without touching the DB row or filesystem", () => {
    ctx = makeOrgDb();
    projectRoot = makeProjectRoot();
    const s = new SkillStore(ctx.repoDb);
    // Can't even stage this under the real `name` column via the normal API
    // shape, but approveCandidate must independently refuse to trust a
    // caller-supplied name — simulate a hostile op payload.
    const res = s.approveCandidate("../../etc/evil", projectRoot);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toMatch(/invalid skill name/i);
    expect(existsSync(join(projectRoot, ".spider"))).toBe(false);
  });

  it("rejects names with invalid characters (uppercase, underscores, leading hyphen, consecutive hyphens, too long)", () => {
    ctx = makeOrgDb();
    projectRoot = makeProjectRoot();
    const s = new SkillStore(ctx.repoDb);
    for (const bad of ["Answer-Style", "answer_style", "-answer", "answer-", "answer--style", "a".repeat(65)]) {
      const res = s.approveCandidate(bad, projectRoot);
      expect(res.ok, `expected "${bad}" to be rejected`).toBe(false);
    }
  });

  it("requires a staged candidate with content — no candidate, and an already-active skill, both fail", () => {
    ctx = makeOrgDb();
    projectRoot = makeProjectRoot();
    const s = new SkillStore(ctx.repoDb);
    const noCandidate = s.approveCandidate("never-staged", projectRoot);
    expect(noCandidate.ok).toBe(false);

    s.upsert({ name: "already-active" }); // default status is 'active'
    const alreadyActive = s.approveCandidate("already-active", projectRoot);
    expect(alreadyActive.ok).toBe(false);
    if (alreadyActive.ok) throw new Error("unreachable");
    expect(alreadyActive.error).toMatch(/already active/i);
  });

  it("never overwrites a pinned or protected skill, even when a candidate is staged over it", () => {
    ctx = makeOrgDb();
    projectRoot = makeProjectRoot();
    const s = new SkillStore(ctx.repoDb);

    s.upsert({ name: "pinned-one" });
    s.setPinned("pinned-one", true);
    s.stageCandidate({ name: "pinned-one", body: "malicious replacement" });
    // stageCandidate itself must refuse to downgrade a pinned skill to staged.
    expect(s.get("pinned-one")!.status).toBe("active");
    const res = s.approveCandidate("pinned-one", projectRoot);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toMatch(/pinned/i);
    expect(existsSync(skillFilePath(projectRoot, "pinned-one"))).toBe(false);

    ctx.repoDb
      .prepare("UPDATE skills SET protected = 1 WHERE name = ?")
      .run("pinned-one"); // also exercise the protected flag directly
    const res2 = s.approveCandidate("pinned-one", projectRoot);
    expect(res2.ok).toBe(false);
  });

  it("no-clobber: refuses to overwrite an existing SKILL.md file, leaving the row staged with its body intact", () => {
    ctx = makeOrgDb();
    projectRoot = makeProjectRoot();
    const s = new SkillStore(ctx.repoDb);
    const file = skillFilePath(projectRoot, "collide");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "pre-existing content, not ours");

    s.stageCandidate({ name: "collide", body: "# New body" });
    const res = s.approveCandidate("collide", projectRoot);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toMatch(/already exists/i);

    // Row must be left exactly as staged, body preserved, not silently activated.
    const row = s.get("collide")!;
    expect(row.status).toBe("staged");
    expect(row.candidateBody).toBe("# New body");
    expect(readFileSync(file, "utf-8")).toBe("pre-existing content, not ours");
  });

  it("refuses to write outside the project root when .spider/skills is a symlink escape", () => {
    ctx = makeOrgDb();
    projectRoot = makeProjectRoot();
    const outside = join(paths.scratch("worktree", process.cwd()), `outside-${crypto.randomUUID()}`);
    extraDirs.push(outside);
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(projectRoot, ".spider"), { recursive: true });
    symlinkSync(outside, join(projectRoot, ".spider", "skills"), "dir");

    const s = new SkillStore(ctx.repoDb);
    s.stageCandidate({ name: "escape-attempt", body: "# Escape" });
    const res = s.approveCandidate("escape-attempt", projectRoot);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toMatch(/outside project root/i);
    expect(existsSync(join(outside, "escape-attempt"))).toBe(false);
  });

  it("on success, the materialized SKILL.md is loadable by pi's public loadSkillsFromDir (not just present on disk)", () => {
    ctx = makeOrgDb();
    projectRoot = makeProjectRoot();
    const s = new SkillStore(ctx.repoDb);
    s.stageCandidate({
      name: "release-notes",
      category: "release",
      body: "Draft release notes from merged PR titles since the last tag.",
    });
    const res = s.approveCandidate("release-notes", projectRoot);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");

    const skillsDir = join(projectRoot, ".spider", "skills");
    const { skills, diagnostics } = loadSkillsFromDir({ dir: skillsDir, source: "project" });
    const loaded = skills.find((sk) => sk.name === "release-notes");
    expect(loaded, `expected pi's loader to discover release-notes; diagnostics: ${JSON.stringify(diagnostics)}`).toBeDefined();
    expect(loaded!.description.length).toBeGreaterThan(0);
    expect(loaded!.filePath).toBe(skillFilePath(projectRoot, "release-notes"));
    // No warning-level diagnostic should be emitted for a well-formed, activated skill.
    expect(diagnostics.filter((d) => d.path === loaded!.filePath)).toHaveLength(0);
  });

  it("rejection changes status without installing any file", () => {
    ctx = makeOrgDb();
    projectRoot = makeProjectRoot();
    const s = new SkillStore(ctx.repoDb);
    s.stageCandidate({ name: "not-worth-it", body: "# Skip me" });
    const row = s.rejectCandidate("not-worth-it");
    expect(row?.status).toBe("rejected");
    expect(existsSync(skillFilePath(projectRoot, "not-worth-it"))).toBe(false);
  });
});

describe("skillAction — approve/reject op surface", () => {
  function deps(repoDb: any, projectRealPath: string): OrganismActionDeps {
    return {
      db: repoDb,
      globalDb: repoDb,
      project: { projectKey: "k", realPath: projectRealPath, dbPath: "/x/.spider/project.db" } as any,
      worker: {} as any,
    };
  }

  it("exposes op:'approve' — activates a staged candidate and reports its path", () => {
    ctx = makeOrgDb();
    projectRoot = makeProjectRoot();
    const store = new SkillStore(ctx.repoDb);
    store.stageCandidate({ name: "answer-style", body: "# Style\nBe terse." });

    const result = skillAction(deps(ctx.repoDb, projectRoot), { op: "approve", name: "answer-style" } as any);
    expect(store.get("answer-style")!.status).toBe("active"); // was: falls through to "list", status stays "staged"
    expect((result.details as { ok: boolean }).ok).toBe(true);
    expect(result.display).toContain("answer-style");
  });

  it("exposes op:'reject' — leaves status rejected, no file, and a compatible sync result", () => {
    ctx = makeOrgDb();
    projectRoot = makeProjectRoot();
    const store = new SkillStore(ctx.repoDb);
    store.stageCandidate({ name: "skip-me", body: "# nah" });

    const result = skillAction(deps(ctx.repoDb, projectRoot), { op: "reject", name: "skip-me" } as any);
    expect(store.get("skip-me")!.status).toBe("rejected");
    expect(existsSync(skillFilePath(projectRoot, "skip-me"))).toBe(false);
    expect(result.details).not.toBeNull();
  });

  it("approve reports an actionable error (not a thrown exception) for an unknown candidate", () => {
    ctx = makeOrgDb();
    projectRoot = makeProjectRoot();
    const result = skillAction(deps(ctx.repoDb, projectRoot), { op: "approve", name: "ghost" } as any);
    expect((result.details as { ok: boolean }).ok).toBe(false);
    expect(result.display).toMatch(/could not approve/i);
  });

  it("still supports list/view/distill unchanged", () => {
    ctx = makeOrgDb();
    projectRoot = makeProjectRoot();
    const store = new SkillStore(ctx.repoDb);
    store.upsert({ name: "release-flow" });
    const list = skillAction(deps(ctx.repoDb, projectRoot), { op: "list" } as any);
    expect((list.details as unknown[]).length).toBeGreaterThan(0);
    const view = skillAction(deps(ctx.repoDb, projectRoot), { op: "view", name: "release-flow" } as any);
    expect(view.details).not.toBeNull();
    const distill = skillAction(deps(ctx.repoDb, projectRoot), { op: "distill", text: "hi" } as any);
    expect(typeof distill.display).toBe("string");
  });

  it("exposes op:'add' — stages a real candidate via SkillStore.stageCandidate (G5a)", () => {
    ctx = makeOrgDb();
    projectRoot = makeProjectRoot();
    const store = new SkillStore(ctx.repoDb);
    const result = skillAction(deps(ctx.repoDb, projectRoot), { op: "add", name: "release-notes", text: "# Release notes\nDraft from merged PR titles." } as any);
    expect((result.details as { ok: boolean }).ok).toBe(true);
    const row = store.get("release-notes");
    expect(row?.status).toBe("staged");
    expect(row?.source).toBe("auto");
    expect(row?.candidateBody).toContain("Draft from merged PR titles");
    // Staging must never itself activate a file.
    expect(existsSync(skillFilePath(projectRoot, "release-notes"))).toBe(false);
  });

  it("op:'add' rejects an invalid name without staging anything", () => {
    ctx = makeOrgDb();
    projectRoot = makeProjectRoot();
    const store = new SkillStore(ctx.repoDb);
    const result = skillAction(deps(ctx.repoDb, projectRoot), { op: "add", name: "Not Valid", text: "body" } as any);
    expect((result.details as { ok: boolean }).ok).toBe(false);
    expect(store.get("Not Valid")).toBeUndefined();
  });

  it("op:'add' rejects an empty body without staging anything", () => {
    ctx = makeOrgDb();
    projectRoot = makeProjectRoot();
    const store = new SkillStore(ctx.repoDb);
    const result = skillAction(deps(ctx.repoDb, projectRoot), { op: "add", name: "valid-name", text: "   " } as any);
    expect((result.details as { ok: boolean }).ok).toBe(false);
    expect(store.get("valid-name")).toBeUndefined();
  });

  it("an unknown op (including the hallucinated 'create') reports a host-visible error, never a successful listing (G5a)", () => {
    ctx = makeOrgDb();
    projectRoot = makeProjectRoot();
    const result = skillAction(deps(ctx.repoDb, projectRoot), { op: "create" } as any);
    expect((result.details as { ok: boolean }).ok).toBe(false);
    expect(Array.isArray(result.details)).toBe(false);
    expect(result.display).toMatch(/unknown skill op/i);
  });
});
