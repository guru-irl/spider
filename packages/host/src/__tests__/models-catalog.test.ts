import { describe, it, expect, afterEach } from "vitest";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { paths } from "@spider/db-core";
import { controlConfig } from "../control";
import { listCatalog } from "../control/models-cmd";
import spiderExtension from "../extension";
import { isolatedCwd } from "./isolated-cwd";
const fixtureCwd = isolatedCwd("models-catalog");
const originalGlobalRoot = paths.globalRoot;
afterEach(() => { paths.globalRoot = originalGlobalRoot; });

// A stand-in for pi's real ModelRegistry (dist/core/model-registry.d.ts).
// Field names are pi's, not ours: `reasoning` (not thinking) and
// `input: ("text"|"image")[]` (not a vision boolean).
const model = (provider: string, id: string, extra: any = {}) => ({
  id, name: id, provider, reasoning: false, input: ["text"], contextWindow: 200000, ...extra,
});
const mkRegistry = (all: any[], available?: any[]) => ({
  getAll: () => all,
  getAvailable: () => available ?? all,
});

describe("control models catalog", () => {
  // Mutation this catches: read pi.listModels/pi.availableModels (neither exists on pi)
  // -> catalog is always [].
  it("enumerates models from the registry", () => {
    const reg = mkRegistry([
      model("github-copilot", "claude-sonnet-5"),
      model("openai", "gpt-5"),
    ]);
    const c = listCatalog(reg);
    expect(c.length).toBeGreaterThan(0);
    expect(c.map((m: any) => m.id)).toContain("claude-sonnet-5");
  });

  it("maps pi's `reasoning` onto thinking", () => {
    const c = listCatalog(mkRegistry([model("openai", "o-thinky", { reasoning: true })]));
    expect(c.find((m: any) => m.id === "o-thinky")?.thinking).toBe(true);
  });

  it("derives vision from input including image, not a `vision` field", () => {
    const c = listCatalog(mkRegistry([model("openai", "sees", { input: ["text", "image"] })]));
    expect(c.find((m: any) => m.id === "sees")?.vision).toBe(true);
  });

  it("drops models the subscription does not grant, rather than listing them as unavailable", () => {
    const a = model("openai", "here");
    const b = model("openai", "gone");
    const c = listCatalog(mkRegistry([a, b], [a]));
    expect(c.map((m: any) => m.id)).toEqual(["here"]);
    expect(c.find((m: any) => m.id === "gone")).toBeUndefined();
  });

  it("a registry-less host degrades to an empty catalog, not a crash", () => {
    expect(listCatalog(undefined)).toEqual([]);
    expect(listCatalog({})).toEqual([]);
  });
});

describe("control models is wired through the real tool", () => {
  it("reports each effective role default's source when local overrides global", async () => {
    const cwd = mkdtempSync(join(resolve(".spider/scratch"), "model-sources-"));
    execFileSync("git", ["init", "-q"], { cwd });
    try {
    paths.globalRoot = join(cwd, "global");
    controlConfig("set", cwd, "models.defaults", { worker: "github-copilot/claude-opus-5" });
    // The global model set action is exercised separately; this fixture supplies a global
    // value directly to assert control models reports both sources and shadowed values.
    mkdirSync(paths.globalRoot, { recursive: true });
    writeFileSync(join(paths.globalRoot, "config.json"), JSON.stringify({
      "models.defaults": { worker: "github-copilot/claude-sonnet-5", reviewer: "github-copilot/claude-opus-5" },
    }));
    let tool: any;
    const pi: any = {
      registerTool: (t: any) => { if (t?.name === "spider") tool = t; },
      registerCommand: () => {}, registerMessageRenderer: () => {}, registerRenderer: () => {},
      registerShortcut: () => {}, on: () => pi, sendMessage: () => {}, addMessage: () => {},
    };
    spiderExtension(pi);
    const r: any = await tool.execute("m2", { action: "control", command: "models" }, undefined, undefined, {
      cwd, sessionId: "s-model-sources", modelRegistry: mkRegistry([model("github-copilot", "claude-sonnet-5")]),
    });
    expect(r.details.defaults).toEqual({
      worker: "github-copilot/claude-opus-5", reviewer: "github-copilot/claude-opus-5",
      planner: "github-copilot/claude-sonnet-5:high", researcher: "github-copilot/claude-sonnet-5:high",
      oracle: "github-copilot/claude-sonnet-5:medium", scout: "github-copilot/claude-sonnet-5:low",
      digest: "github-copilot/claude-sonnet-5:low", self_name: "github-copilot/claude-sonnet-5:low",
      upstream_watch: "github-copilot/claude-sonnet-5:low",
    });
    expect(r.details.sources).toEqual({
      worker: "local", reviewer: "global", planner: "default", researcher: "default", oracle: "default",
      scout: "default", digest: "default", self_name: "default", upstream_watch: "default",
    });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it("control models clear removes only the selected local role", async () => {
    const cwd = mkdtempSync(join(resolve(".spider/scratch"), "model-clear-"));
    execFileSync("git", ["init", "-q"], { cwd });
    try {
      paths.globalRoot = join(cwd, "global");
      controlConfig("set", cwd, "models.defaults", { worker: "prov/local", reviewer: "prov/reviewer" });
      controlConfig("set", cwd, "models.defaults", { worker: "prov/global" }, "global");
      let tool: any;
      const pi: any = { registerTool: (t: any) => { if (t?.name === "spider") tool = t; }, registerCommand: () => {}, registerMessageRenderer: () => {}, registerRenderer: () => {}, registerShortcut: () => {}, on: () => pi, sendMessage: () => {}, addMessage: () => {} };
      spiderExtension(pi);
      const r: any = await tool.execute("m-clear", { action: "control", command: "models", op: "clear", key: "worker" }, undefined, undefined, { cwd, sessionId: "s-clear", modelRegistry: mkRegistry([]) });
      expect(r.details).toMatchObject({ ok: true, cleared: true, role: "worker" });
      expect(controlConfig("get", cwd, "models.defaults")).toEqual({ worker: "prov/global", reviewer: "prov/reviewer" });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it("returns a NON-EMPTY catalog when the host provides a registry", async () => {
    let tool: any;
    const pi: any = {
      registerTool: (t: any) => { if (t?.name === "spider") tool = t; },
      registerCommand: () => {}, registerMessageRenderer: () => {}, registerRenderer: () => {},
      registerShortcut: () => {}, on: () => pi, sendMessage: () => {}, addMessage: () => {},
    };
    spiderExtension(pi);
    const r: any = await tool.execute("m1", { action: "control", command: "models" }, undefined, undefined, {
      cwd: fixtureCwd,
      sessionId: "s-models",
      modelRegistry: mkRegistry([model("github-copilot", "claude-sonnet-5")]),
    });
    // Mutation this catches: stop threading modelRegistry -> catalog is [] again.
    expect(r.details.catalog.length).toBeGreaterThan(0);
  });
});

describe("catalog lists ONLY what the subscription actually allows", () => {
  const reg = mkRegistry(
    [model("github-copilot", "claude-sonnet-5"), model("github-copilot", "claude-opus-4.5"),
     model("anthropic", "claude-sonnet-5"), model("amazon-bedrock", "anthropic.claude-sonnet-5")],
    [model("github-copilot", "claude-sonnet-5")],
  );

  // Mutation this catches: enumerate getAll() -> ~800 entries of provider catalogue,
  // nearly all unusable, dumped into the UI and the model's context.
  it("excludes models the user has no access to", () => {
    const c = listCatalog(reg);
    expect(c.length).toBe(1);
    expect(c[0].provider).toBe("github-copilot");
  });

  it("never returns an entry marked unavailable", () => {
    expect(listCatalog(reg).filter((m: any) => m.available === false)).toEqual([]);
  });

  it("falls back to getAll() when a host exposes no getAvailable()", () => {
    expect(listCatalog({ getAll: () => [model("openai", "gpt-5")] }).length).toBe(1);
  });
});
