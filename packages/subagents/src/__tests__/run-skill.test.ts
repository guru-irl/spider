import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { makeRunHandler } from "../actions/run";
import { teardownCoordinators } from "../coordinators";
import type { ChildSpawnSpec } from "../pi-args";
import type { Spawner } from "../runner";
import { freshDb, testScratchPath } from "./helpers/testutil";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(childMode: "rpc" | "print") {
  const root = mkdtempSync(testScratchPath("run-skill-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const skillDir = join(root, "skills", "fixture-skill");
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  writeFileSync(skillPath, "---\nname: fixture-skill\ndescription: Use when testing selected skills.\n---\nRead the fixture instructions.\n");
  const overrideDir = join(root, "skills", "override-skill");
  mkdirSync(overrideDir);
  const overridePath = join(overrideDir, "SKILL.md");
  writeFileSync(overridePath, "---\nname: override-skill\ndescription: Use when testing stage overrides.\n---\nFollow the override instructions.\n");
  const skills = loadSkillsFromDir({ dir: join(root, "skills"), source: "project" }).skills;
  const db = freshDb();
  cleanups.push(() => db.close());
  const sessionId = randomUUID();
  cleanups.push(() => teardownCoordinators(sessionId));
  const spawned: ChildSpawnSpec[] = [];
  const notifications: any[] = [];
  let resolveFinished!: () => void;
  const finished = new Promise<void>(resolve => { resolveFinished = resolve; });
  let expectedNotifications = 1;
  const spawner: Spawner = spec => {
    spawned.push(spec);
    return {
      wait: async () => ({ exitCode: 0, result: "step output" }),
      kill: () => {},
      detach: () => {},
    };
  };
  const handler = makeRunHandler({ spawner });
  const ctx = {
    db, sessionId, cwd: root, childMode, project: { dbPath: join(root, "fixture.db") },
    pi: {
      getCommands: () => skills.map(skill => ({ name: `skill:${skill.name}`, source: "skill", description: skill.description, sourceInfo: skill.sourceInfo })),
      sendMessage: (message: any) => {
        notifications.push(message);
        if (notifications.length >= expectedNotifications) resolveFinished();
      },
    },
  };
  return {
    ctx, db, handler, spawned, skillPath, overridePath,
    dispatch: async (args: any, notificationCount = 1) => {
      expectedNotifications = notificationCount;
      await handler(args, ctx);
      await finished;
    },
  };
}

function childPrompt(spec: ChildSpawnSpec): string {
  if (spec.childMode === "rpc") return spec.prompt!;
  const task = spec.argv.at(-1)!;
  return task.startsWith("@") ? readFileSync(task.slice(1), "utf8") : task;
}

// Removing skill delivery in any mode must remove the resolved SKILL.md path from
// the actual child prompt. Only the OS process is replaced; routing, coordinators,
// runner, interpolation and spawn-argument construction are real.
const modes = [
  { name: "SINGLE", args: { agent: "worker", task: "single task", skill: "fixture-skill" }, tasks: ["single task"], notifications: 1 },
  { name: "PARALLEL", args: { tasks: [{ agent: "worker", task: "parallel task", count: 2 }], skill: "fixture-skill" }, tasks: ["parallel task", "parallel task"], notifications: 2 },
  { name: "CHAIN", args: { chain: [{ task: "first task" }, { task: "next task: {previous}" }], skill: "fixture-skill" }, tasks: ["first task", "next task: step output"], notifications: 1 },
  { name: "PIPELINE", args: { pipeline: [{ agent: "worker", task: "first task", skill: "fixture-skill" }, { agent: "worker", task: "next task: {previous}", skill: "fixture-skill" }] }, tasks: ["first task", "next task: step output"], notifications: 2 },
];

describe("selected-skill validation", () => {
  for (const mode of modes) {
    it(`${mode.name} rejects an unknown skill before creating runs`, async () => {
      const f = fixture("rpc");
      const args = mode.name === "PIPELINE"
        ? { pipeline: [{ agent: "worker", task: "first task", skill: "fixture-skill" }, { agent: "worker", task: "second task", skill: "missing-skill" }] }
        : { ...mode.args, skill: "missing-skill" };
      await expect(f.handler(args, f.ctx)).rejects.toThrow(/unknown skill.*missing-skill/i);
      expect(f.spawned).toHaveLength(0);
      expect(f.db.prepare("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 0 });
    });
  }

  it("rejects a skill whose catalog entry points to a missing file", async () => {
    const f = fixture("rpc");
    rmSync(f.skillPath);
    await expect(f.handler({ task: "work", skill: "fixture-skill" }, f.ctx)).rejects.toThrow(/skill.*fixture-skill.*(unavailable|cannot|could not)/i);
    expect(f.spawned).toHaveLength(0);
  });

  it("does not mistake a same-name extension command for a loaded skill", async () => {
    const f = fixture("rpc");
    const commands = f.ctx.pi.getCommands();
    f.ctx.pi.getCommands = () => commands.map(command => ({ ...command, source: "extension" }));
    await expect(f.handler({ task: "work", skill: "fixture-skill" }, f.ctx)).rejects.toThrow(/unknown skill.*fixture-skill/i);
    expect(f.spawned).toHaveLength(0);
  });
});

for (const childMode of ["rpc", "print"] as const) {
  describe(`${childMode} selected-skill dispatch`, () => {
    it("uses the pipeline dispatch skill by default and honors a stage override", async () => {
      const f = fixture(childMode);
      await f.dispatch({
        skill: "fixture-skill",
        pipeline: [{ agent: "worker", task: "default task" }, { agent: "worker", task: "override task", skill: "override-skill" }],
      }, 2);
      expect(f.spawned).toHaveLength(2);
      expect(childPrompt(f.spawned[0])).toContain(f.skillPath);
      expect(childPrompt(f.spawned[0])).not.toContain(f.overridePath);
      expect(childPrompt(f.spawned[1])).toContain(f.overridePath);
      expect(childPrompt(f.spawned[1])).not.toContain(f.skillPath);
    });

    it("leaves an unselected task unchanged without consulting the catalog", async () => {
      const f = fixture(childMode);
      f.ctx.pi.getCommands = () => { throw new Error("must not consult catalog"); };
      await f.dispatch({ task: "ordinary task" });
      expect(f.spawned).toHaveLength(1);
      expect(childPrompt(f.spawned[0])).toBe("Task: ordinary task");
    });

    it("preserves the selected skill when a long task uses overflow transport", async () => {
      const f = fixture(childMode);
      const task = "long task ".repeat(1000);
      await f.dispatch({ task, skill: "fixture-skill" });
      const prompt = childPrompt(f.spawned[0]);
      expect(prompt).toContain(f.skillPath);
      expect(prompt).toContain(task);
    });

    for (const mode of modes) {
      it(`${mode.name} tells every child to read and follow the resolved skill`, async () => {
        const f = fixture(childMode);
        await f.dispatch(mode.args, mode.notifications);
        expect(f.spawned).toHaveLength(mode.tasks.length);
        for (const [index, spec] of f.spawned.entries()) {
          const prompt = childPrompt(spec);
          expect(prompt).toContain(f.skillPath);
          expect(prompt).toMatch(/read[\s\S]*follow/i);
          expect(prompt).toContain(mode.tasks[index]);
        }
      });
    }
  });
}
