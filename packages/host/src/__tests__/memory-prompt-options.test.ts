import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
  ModelRuntime, SessionManager, SettingsManager,
  type AgentSessionRuntime, type ExtensionAPI, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt,
  getCurrentTools, InMemoryCredentialStore, InMemoryModelsStore, Type,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { bindSession, openDbAt, openGlobal, setGlobalDbPathForTests, unbindSession, type Db } from "@spider/db-core";
import { addMemory } from "@spider/memory";
import spiderExtension from "../extension";
import { registerHooks } from "../hooks";
import * as injectionSnapshot from "../injection-snapshot";
import { openSessionRunDb } from "../session-run-db";

const root = join(process.cwd(), ".spider", "scratch", `memory-sections-${process.pid}`);
const hosts: AgentSessionRuntime[] = [];
const dbs: Db[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const db of dbs.splice(0)) db.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setGlobalDbPathForTests(null);
  rmSync(root, { recursive: true, force: true });
});

function fixture(name: string) {
  const cwd = join(root, name);
  mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd });
  setGlobalDbPathForTests(join(root, "global.db"));
  const repo = openDbAt(join(cwd, ".git", "spider", "repo.db"), "repo");
  dbs.push(repo);
  const add = (content: string) => addMemory(repo, "repo", { category: "preference", content, source: "user", status: "active" });
  return { cwd, repo, add };
}

type Request = Parameters<FauxResponseFactory>[0];
async function sdk(cwd: string, options: {
  extensions?: ExtensionFactory[];
  respond?: FauxResponseFactory;
  preflight?: (pi: ExtensionAPI) => void;
} = {}) {
  const requests: Request[] = [];
  const starts: string[] = [];
  const forced: Array<string | undefined> = [];
  let toolExecutions = 0;
  const faux = fauxProvider({ models: [{ id: "memory-sections" }], tokensPerSecond: 100000 });
  faux.setResponses(Array.from({ length: 100 }, (): FauxResponseFactory => async (...args) => {
    const [context] = args;
    requests.push(structuredClone(context));
    return options.respond ? options.respond(...args) : fauxAssistantMessage("OK");
  }));
  const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  models.registerNativeProvider(faux.provider);
  const host = await createAgentSessionRuntime(async target => {
    const services = await createAgentSessionServices({
      cwd: target.cwd, agentDir: process.env.PI_CODING_AGENT_DIR!, modelRuntime: models,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 100, reserveTokens: 1000 }, retry: { enabled: false } }),
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
        systemPromptOverride: () => "Fixture base",
        extensionFactories: [
          ...(options.extensions ?? [pi => registerHooks(pi)]),
          pi => {
            options.preflight?.(pi);
            pi.on("before_agent_start", event => {
              starts.push(event.messageType);
              forced.push(event.systemPromptOptions.forceSystemPrompt);
            });
            pi.registerTool({ name: "fixture_tool", label: "Fixture tool", description: "Return a fixture result", parameters: Type.Object({}),
              async execute() { toolExecutions++; return { content: [{ type: "text", text: "Fixture tool result" }], details: {} }; } });
          },
        ],
      },
    });
    return {
      ...await createAgentSessionFromServices({ services, sessionManager: target.sessionManager, sessionStartEvent: target.sessionStartEvent, model: faux.getModel(), tools: ["fixture_tool"] }),
      services, diagnostics: services.diagnostics,
    };
  }, { cwd, agentDir: process.env.PI_CODING_AGENT_DIR!, sessionManager: SessionManager.create(cwd, join(root, "sessions")) });
  hosts.push(host);
  host.setRebindSession(async session => { await session.bindExtensions({}); });
  await host.session.bindExtensions({});
  return { host, requests, starts, forced, toolExecutions: () => toolExecutions };
}

const rawCopies = (request: Request, text: string) => JSON.stringify(request.messages.filter(message => message.role === "system")).split(text).length - 1;
function savedSections(manager: SessionManager) {
  return manager.getEntries().flatMap(entry => entry.type === "message" && entry.message.role === "system" && Object.hasOwn(entry.message.sections ?? {}, "spider_memory")
    ? [entry.message.sections!.spider_memory] : []);
}
const wake = (host: AgentSessionRuntime, content = "Child completed") => host.session.sendCustomMessage({ customType: "spider.subagent_done", content, display: true }, { triggerTurn: true });

describe("named frozen memory through the real pi SDK", () => {
  // A full-prompt return masks later sections; failing to extend an earlier force loses memory.
  for (const order of ["before", "after"] as const) {
    for (const force of ["none", "return", "options"] as const) {
      it(`composes with another extension ${order} spider (${force}) across repeated tool-using wakes`, async () => {
        const f = fixture(`${order}-${force}`);
        f.add("Stable SDK memory fact");
        const other: ExtensionFactory = pi => {
          pi.on("before_agent_start", event => {
            event.systemPromptOptions.sections.other_extension = "Other section";
            if (force === "return") return { systemPrompt: event.systemPrompt + "\nForced suffix" };
            if (force === "options") event.systemPromptOptions.forceSystemPrompt = event.systemPrompt + "\nForced suffix";
          });
        };
        const spider: ExtensionFactory = pi => registerHooks(pi);
        let requests = 0;
        const s = await sdk(f.cwd, { extensions: order === "before" ? [other, spider] : [spider, other],
          respond: () => {
            requests++;
            return [2, 3, 5, 6, 8, 9].includes(requests)
              ? fauxAssistantMessage(fauxToolCall("fixture_tool", {}, { id: `tool-${requests}` }), { stopReason: "toolUse" })
              : fauxAssistantMessage("OK");
          },
        });
        await s.host.session.prompt("First user turn");
        f.add("Later SDK memory fact");
        for (let i = 0; i < 3; i++) await wake(s.host, `Child completed ${i}`);
        await s.host.session.prompt("Last user turn");
        expect(s.starts).toEqual(["user", "custom", "custom", "custom", "user"]);
        expect(s.requests).toHaveLength(11);
        expect(s.toolExecutions()).toBe(6);
        for (const request of s.requests) {
          expect(rawCopies(request, "Stable SDK memory fact")).toBe(1);
          expect(rawCopies(request, "Later SDK memory fact")).toBe(0);
          expect(getCurrentSystemPrompt(request.messages)).toContain("Other section");
          expect(getCurrentTools(request.messages)).toEqual(getCurrentTools(s.requests[0].messages));
          if (force !== "none") expect(getCurrentSystemPrompt(request.messages)).toContain("Forced suffix");
        }
        if (force === "none") expect(s.forced).toEqual(Array(5).fill(undefined));
        const patches = savedSections(s.host.session.sessionManager);
        expect(patches).toHaveLength(1);
        expect(patches[0]).toContain("Stable SDK memory fact");
        const file = readFileSync(s.host.session.sessionFile!, "utf8");
        expect(file.split("Stable SDK memory fact")).toHaveLength(2);
      });
    }
  }

  // A thrown snapshot read must not persist a removal or log on every retry.
  for (const firstTurn of [false, true]) {
    it(`keeps ${firstTurn ? "the section unset on first-turn" : "the previous section on later"} memory failures and logs once per session`, async () => {
      const f = fixture(`load-failure-${firstTurn}`);
      const bound = fixture(`load-failure-bound-${firstTurn}`);
      f.add("Last successful memory fact");
      bound.add("Recovered bound memory fact");
      const s = await sdk(f.cwd);
      if (!firstTurn) await s.host.session.prompt("Load memory successfully");
      const global = openGlobal();
      dbs.push(global);
      bindSession(global, s.host.session.sessionId, bound.cwd);
      const snapshot = vi.spyOn(injectionSnapshot, "readInjectionSnapshot").mockImplementation(() => { throw new Error("Snapshot fixture failure"); });
      await wake(s.host, "First failing read");
      await s.host.session.prompt("Second failing read");
      for (const request of s.requests) {
        expect(rawCopies(request, "Last successful memory fact")).toBe(firstTurn ? 0 : 1);
        expect(getCurrentSystemPrompt(request.messages).includes("Last successful memory fact")).toBe(!firstTurn);
      }
      expect(savedSections(s.host.session.sessionManager)).toHaveLength(firstTurn ? 0 : 1);
      const fileEntries = readFileSync(s.host.session.sessionFile!, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(fileEntries.filter(entry => entry.type === "message" && entry.message.role === "system" && entry.message.sections?.spider_memory === null)).toEqual([]);
      const runDb = openSessionRunDb(f.cwd, s.host.session.sessionId).db;
      try {
        const failures = runDb.prepare("SELECT description FROM events WHERE session_id = ? AND tool = 'memory'").all(s.host.session.sessionId);
        expect(failures).toEqual([{ description: expect.stringContaining("Snapshot fixture failure") }]);
      } finally { runDb.close(); }
      snapshot.mockRestore();
      await wake(s.host, "Read recovered");
      expect(rawCopies(s.requests.at(-1)!, "Recovered bound memory fact")).toBe(1);
      expect(savedSections(s.host.session.sessionManager)).toHaveLength(firstTurn ? 1 : 2);
    });
  }

  // An earlier extension can carry a previously composed prompt into another run.
  it("does not duplicate memory already present in another extension's force", async () => {
    const f = fixture("already-forced");
    f.add("Already composed fact");
    let forceText: string | undefined;
    const other: ExtensionFactory = pi => {
      pi.on("before_agent_start", event => { event.systemPromptOptions.forceSystemPrompt = forceText; });
    };
    const s = await sdk(f.cwd, { extensions: [other, pi => registerHooks(pi)] });
    await s.host.session.prompt("Initial section");
    forceText = "External prompt\n" + savedSections(s.host.session.sessionManager)[0];
    await wake(s.host);
    expect(s.requests).toHaveLength(2);
    for (const request of s.requests) expect(rawCopies(request, "Already composed fact")).toBe(1);
    expect(getCurrentSystemPrompt(s.requests[1].messages)).toContain("External prompt");
    expect(savedSections(s.host.session.sessionManager)).toHaveLength(1);
  });

  // The section must be removed without deleting sections owned by another extension.
  it("deletes only spider's stale section when frozen memory is empty", () => {
    const f = fixture("empty-section");
    const handlers: Record<string, (...args: any[]) => unknown> = {};
    registerHooks({ on(name, handler) { handlers[name] = handler; } });
    const options = { sections: { spider_memory: "Stale memory", other_extension: "Other section" } };
    expect(handlers.before_agent_start({ systemPrompt: "base", systemPromptOptions: options }, { cwd: f.cwd })).toBeUndefined();
    expect(options.sections).toEqual({ other_extension: "Other section" });
  });

  // Dropping preflight on busy/queued custom starts would remove the section at a tool boundary.
  for (const continuation of ["startup completion", "queued completion", "steer", "follow-up"] as const) {
    it(`keeps one saved and provider-bound copy with a ${continuation}`, async () => {
      const f = fixture(continuation);
      f.add("Queued memory fact");
      let s: Awaited<ReturnType<typeof sdk>>;
      let count = 0;
      let startupQueued = false;
      s = await sdk(f.cwd, { preflight: pi => {
        pi.on("before_agent_start", async () => {
          if (continuation === "startup completion" && !startupQueued) {
            startupQueued = true;
            await wake(s.host, "Queued child completed");
          }
        });
      }, respond: async () => {
        if (++count === 1) {
          if (continuation === "queued completion") await wake(s.host, "Queued child completed");
          if (continuation === "steer") await s.host.session.steer("Steer instruction");
          if (continuation === "follow-up") await s.host.session.followUp("Follow-up instruction");
          return fauxAssistantMessage(fauxToolCall("fixture_tool", {}, { id: "queued-tool" }), { stopReason: "toolUse" });
        }
        return fauxAssistantMessage("OK");
      } });
      await s.host.session.prompt("Queue work");
      expect(s.requests.length).toBeGreaterThanOrEqual(2);
      const conversation = JSON.stringify(s.requests.at(-1)!.messages);
      expect(conversation).toContain(continuation.endsWith("completion") ? "Queued child completed" : continuation === "steer" ? "Steer instruction" : "Follow-up instruction");
      for (const request of s.requests) expect(rawCopies(request, "Queued memory fact")).toBe(1);
      expect(savedSections(s.host.session.sessionManager)).toHaveLength(1);
    });
  }

  // Freezing an empty snapshot is intentional; reload creates a new hook instance.
  it("freezes empty memory on a custom-first session and refreshes it on /reload", async () => {
    const f = fixture("reload-empty");
    const s = await sdk(f.cwd);
    await wake(s.host);
    f.add("After reload fact");
    await s.host.session.prompt("Still empty");
    expect(s.requests.map(request => rawCopies(request, "After reload fact"))).toEqual([0, 0]);
    expect(savedSections(s.host.session.sessionManager)).toEqual([]);
    await s.host.session.reload();
    await wake(s.host);
    await s.host.session.prompt("Unchanged after reload");
    expect(s.requests.map(request => rawCopies(request, "After reload fact"))).toEqual([0, 0, 1, 1]);
    expect(savedSections(s.host.session.sessionManager)).toHaveLength(1);
  });

  // Binding changes invalidate the source, but ordinary writes must not thaw it.
  it("records one patch per binding change, including removal of an empty target", async () => {
    const a = fixture("binding-a");
    const b = fixture("binding-b");
    const empty = fixture("binding-empty");
    a.add("Cwd binding fact");
    b.add("Bound binding fact");
    const s = await sdk(a.cwd);
    const global = openGlobal();
    dbs.push(global);
    await wake(s.host);
    bindSession(global, s.host.session.sessionId, b.cwd);
    await wake(s.host);
    b.add("Later bound fact");
    await wake(s.host);
    bindSession(global, s.host.session.sessionId, empty.cwd);
    await wake(s.host);
    unbindSession(global, s.host.session.sessionId);
    await wake(s.host);
    const patches = savedSections(s.host.session.sessionManager);
    expect(patches).toHaveLength(4);
    expect(patches[0]).toContain("Cwd binding fact");
    expect(patches[1]).toContain("Bound binding fact");
    expect(patches[2]).toBeNull();
    expect(patches[3]).toBe(patches[0]);
    const prompts = s.requests.map(request => getCurrentSystemPrompt(request.messages));
    expect(prompts[1]).toContain("Bound binding fact");
    expect(prompts[1]).not.toContain("Cwd binding fact");
    expect(prompts[2]).toBe(prompts[1]);
    expect(prompts[3]).not.toContain("binding fact");
    expect(prompts[4]).toContain("Cwd binding fact");
    expect(JSON.stringify(s.requests)).not.toContain("Later bound fact");
  });

  // Real /new, /resume and /fork replace the session and must refresh the snapshot.
  it("refreshes on new, resumed and forked sessions without repeating unchanged patches", async () => {
    const f = fixture("sessions");
    f.add("Original session fact");
    const s = await sdk(f.cwd);
    await s.host.session.prompt("Original session");
    const original = s.host.session.sessionFile!;
    f.add("New session fact");
    await s.host.newSession();
    await wake(s.host);
    expect(getCurrentSystemPrompt(s.requests.at(-1)!.messages)).toContain("New session fact");
    expect(rawCopies(s.requests.at(-1)!, "New session fact")).toBe(1);
    f.add("Resumed session fact");
    await s.host.switchSession(original);
    await wake(s.host);
    await wake(s.host);
    expect(getCurrentSystemPrompt(s.requests.at(-1)!.messages)).toContain("Resumed session fact");
    expect(rawCopies(s.requests.at(-1)!, "Resumed session fact")).toBe(1);
    expect(savedSections(s.host.session.sessionManager)).toHaveLength(2);
    const user = s.host.session.sessionManager.getEntries().find(entry => entry.type === "message" && entry.message.role === "user")!;
    f.add("Forked session fact");
    await s.host.fork(user.id, { position: "at" });
    expect(s.host.session.sessionFile).not.toBe(original);
    await s.host.session.prompt("Fork turn");
    await wake(s.host);
    expect(getCurrentSystemPrompt(s.requests.at(-1)!.messages)).toContain("Forked session fact");
    expect(rawCopies(s.requests.at(-1)!, "Forked session fact")).toBe(1);
    expect(savedSections(s.host.session.sessionManager)).toHaveLength(2);
  });

  // Compaction must keep the canonical section checkpoint without thawing the snapshot.
  it("preserves the frozen section across real SDK compaction", async () => {
    const f = fixture("compaction");
    f.add("Compacted frozen fact");
    const s = await sdk(f.cwd, { preflight: pi => {
      pi.on("session_before_compact", event => ({ compaction: { summary: "Fixture summary", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } }));
    } });
    for (let i = 0; i < 3; i++) await s.host.session.prompt(`Conversation ${i} ${"history ".repeat(200)}`);
    f.add("After compaction fact");
    await s.host.session.compact();
    await wake(s.host);
    await s.host.session.prompt("After compaction");
    for (const request of s.requests) {
      expect(rawCopies(request, "Compacted frozen fact")).toBe(1);
      expect(rawCopies(request, "After compaction fact")).toBe(0);
    }
    expect(savedSections(s.host.session.sessionManager)).toHaveLength(1);
    const compactions = s.host.session.sessionManager.getEntries().filter(entry => entry.type === "compaction");
    expect(compactions).toHaveLength(1);
    expect(JSON.stringify(compactions[0].systemMessage)).toContain("Compacted frozen fact");
    // A prompt checkpoint is an additional saved copy, not another section-change patch.
    expect(readFileSync(s.host.session.sessionFile!, "utf8").split("Compacted frozen fact")).toHaveLength(3);
  });

  // This catches accidentally moving registerHooks behind extension.ts's parent-only guard.
  it("gives a child loaded through extension.ts its own frozen named section", async () => {
    const f = fixture("child");
    f.add("Parent section fact");
    const parent = await sdk(f.cwd);
    await parent.host.session.prompt("Parent turn");
    f.add("Child section fact");
    vi.stubEnv("PI_SUBAGENT_CHILD", "1");
    vi.stubEnv("PI_SPIDER_DB_PATH", join(root, "child-runs.db"));
    const child = await sdk(f.cwd, { extensions: [pi => spiderExtension(pi as unknown as Parameters<typeof spiderExtension>[0])] });
    await wake(child.host);
    f.add("After child section fact");
    await child.host.session.prompt("Child turn");
    for (const request of child.requests) {
      expect(rawCopies(request, "Child section fact")).toBe(1);
      expect(rawCopies(request, "After child section fact")).toBe(0);
    }
    expect(savedSections(child.host.session.sessionManager)).toHaveLength(1);
    expect(savedSections(parent.host.session.sessionManager)[0]).not.toContain("Child section fact");
  });
});
