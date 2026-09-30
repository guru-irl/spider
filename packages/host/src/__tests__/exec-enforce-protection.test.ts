// packages/host/src/__tests__/exec-enforce-protection.test.ts
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setGlobalDbPathForTests, paths } from "@spider/db-core";
import { registerHooks } from "../hooks";
import { controlConfig } from "../control";
import { applyConfigEdit } from "../control/config-cmd";

const scratch = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".spider", "scratch", `protect-${process.pid}`);
beforeEach(() => { 
  mkdirSync(scratch, { recursive: true }); 
  // Initialize as git repo so projectRoot resolves to this directory, not parent repo
  require("child_process").execFileSync("git", ["init", "-q"], { cwd: scratch });
  setGlobalDbPathForTests(join(scratch, `g-${Date.now()}.db`)); 
});
afterEach(() => { setGlobalDbPathForTests(null); rmSync(scratch, { recursive: true, force: true }); });

describe("exec.enforce protection", () => {
  for (const [globalValue, localValue, blocked] of [
    [false, true, true],
    [true, false, false],
  ] as const) {
    it(`lets local ${localValue} override global ${globalValue} for bash`, () => {
      const priorRoot = paths.globalRoot;
      paths.globalRoot = join(scratch, "global");
      try {
        const globalFile = join(paths.globalRoot, "config.json");
        const localFile = join(scratch, ".spider", "config.json");
        mkdirSync(dirname(globalFile), { recursive: true });
        mkdirSync(dirname(localFile), { recursive: true });
        writeFileSync(globalFile, JSON.stringify({ "exec.enforce": globalValue }));
        writeFileSync(localFile, JSON.stringify({ "exec.enforce": localValue }));
        const handlers: Record<string, Function> = {};
        registerHooks({ on: (name, fn) => { handlers[name] = fn; } });
        const result = handlers.tool_call({ toolName: "bash", cwd: scratch, input: { command: "echo test" } });
        if (blocked) expect(result).toMatchObject({ block: true });
        else expect(result).toBeUndefined();
      } finally { paths.globalRoot = priorRoot; }
    });
  }

  for (const layer of ["local", "global"] as const) {
    for (const invalid of ["x", null] as const) {
      it(`allows bash with ${layer} invalid models.defaults ${String(invalid)} and effective false`, () => {
        const priorRoot = paths.globalRoot;
        paths.globalRoot = join(scratch, "global");
        try {
          const file = layer === "global" ? join(paths.globalRoot, "config.json") : join(scratch, ".spider", "config.json");
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, JSON.stringify({ "exec.enforce": false, "models.defaults": invalid }));
          const handlers: Record<string, Function> = {};
          registerHooks({ on: (name, fn) => { handlers[name] = fn; } });
          expect(handlers.tool_call({ toolName: "bash", cwd: scratch, input: { command: "echo test" } })).toBeUndefined();
        } finally { paths.globalRoot = priorRoot; }
      });
    }
  }

  for (const invalid of [null, "false", 0] as const) {
    it(`blocks bash when effective exec.enforce is ${String(invalid)} rather than boolean false`, () => {
      const priorRoot = paths.globalRoot;
      paths.globalRoot = join(scratch, "global");
      try {
        const globalFile = join(paths.globalRoot, "config.json");
        const localFile = join(scratch, ".spider", "config.json");
        mkdirSync(dirname(globalFile), { recursive: true });
        mkdirSync(dirname(localFile), { recursive: true });
        writeFileSync(globalFile, JSON.stringify({ "exec.enforce": false }));
        writeFileSync(localFile, JSON.stringify({ "exec.enforce": invalid }));
        const handlers: Record<string, Function> = {};
        registerHooks({ on: (name, fn) => { handlers[name] = fn; } });
        expect(handlers.tool_call({ toolName: "bash", cwd: scratch, input: { command: "echo test" } })).toMatchObject({ block: true });
      } finally { paths.globalRoot = priorRoot; }
    });
  }

  it("allows local false over an invalid global exec.enforce when both files parse", () => {
    const priorRoot = paths.globalRoot;
    paths.globalRoot = join(scratch, "global");
    try {
      const globalFile = join(paths.globalRoot, "config.json");
      const localFile = join(scratch, ".spider", "config.json");
      mkdirSync(dirname(globalFile), { recursive: true });
      mkdirSync(dirname(localFile), { recursive: true });
      writeFileSync(globalFile, '{"exec.enforce": "false"}');
      writeFileSync(localFile, '{"exec.enforce": false}');
      const handlers: Record<string, Function> = {};
      registerHooks({ on: (name, fn) => { handlers[name] = fn; } });
      expect(handlers.tool_call({ toolName: "bash", cwd: scratch, input: { command: "echo test" } })).toBeUndefined();
    } finally { paths.globalRoot = priorRoot; }
  });

  for (const badLayer of ["local", "global"] as const) {
    it(`blocks bash when ${badLayer} config is malformed despite a valid false in the other layer`, () => {
      const priorRoot = paths.globalRoot;
      paths.globalRoot = join(scratch, "global");
      try {
        const localFile = join(scratch, ".spider", "config.json");
        const globalFile = join(paths.globalRoot, "config.json");
        const goodFile = badLayer === "local" ? globalFile : localFile;
        const badFile = badLayer === "local" ? localFile : globalFile;
        mkdirSync(dirname(goodFile), { recursive: true });
        mkdirSync(dirname(badFile), { recursive: true });
        writeFileSync(goodFile, '{"exec.enforce": false}');
        writeFileSync(badFile, '{"exec.enforce": true, }');
        const handlers: Record<string, Function> = {};
        registerHooks({ on: (name, fn) => { handlers[name] = fn; } });
        const event = { toolName: "bash", cwd: scratch, input: { command: "echo test" } };
        expect(handlers.tool_call(event)).toMatchObject({ block: true });
        writeFileSync(badFile, "{}");
        expect(handlers.tool_call(event)).toBeUndefined();
      } finally { paths.globalRoot = priorRoot; }
    });
  }

  it("reads both config layers once for one bash decision", () => {
    const handlers: Record<string, Function> = {};
    registerHooks({ on: (name, fn) => { handlers[name] = fn; } });
    const root = paths.projectRoot;
    const lookup = vi.spyOn(paths, "projectRoot").mockImplementation((cwd: string) => root(cwd));
    try {
      expect(handlers.tool_call({ toolName: "bash", cwd: scratch, input: { command: "echo test" } })).toMatchObject({ block: true });
      expect(lookup).toHaveBeenCalledTimes(1);
    } finally { lookup.mockRestore(); }
  });
  it("fails closed when config lookup throws", () => {
    const handlers: Record<string, Function> = {};
    registerHooks({ on: (name, fn) => { handlers[name] = fn; } });
    const lookup = vi.spyOn(paths, "projectRoot").mockImplementation(() => { throw new Error("config lookup failed"); });
    try {
      expect(handlers.tool_call({ toolName: "bash", cwd: scratch, input: { command: "echo test" } })).toMatchObject({ block: true });
    } finally { lookup.mockRestore(); }
  });
  it("block reason does NOT contain exec.enforce, config set, or disable", () => {
    const dir = join(scratch, "reason"); mkdirSync(dir, { recursive: true });
    const handlers: Record<string, Function> = {};
    const mockPi = { on: (name: string, fn: Function) => { handlers[name] = fn; } };
    
    registerHooks(mockPi);
    
    const result = handlers["tool_call"]({ 
      toolName: "bash", 
      input: { command: "echo test" }, 
      cwd: dir 
    });
    
    expect(result).toMatchObject({ block: true });
    expect(result.reason).not.toContain("exec.enforce");
    expect(result.reason).not.toContain("config set");
    expect(result.reason).not.toMatch(/disable enforcement/i);
    expect(result.reason).not.toMatch(/To disable/i);
    expect(result.reason).toContain("spider exec"); // Must still teach replacement
  });

  it("model-facing control config set exec.enforce false is REFUSED and value unchanged", () => {
    const dir = join(scratch, "model-block"); mkdirSync(dir, { recursive: true });
    
    // Set it to true first
    controlConfig("set", dir, "exec.enforce", true);
    
    // Try to change via model-facing path (applyConfigEdit which has the guard)
    const result = applyConfigEdit(dir, "exec.enforce", "false");
    
    expect(result.ok).toBe(false);
    expect(result.error).toContain("exec.enforce");
    expect(result.error).toContain("protected");
    
    // CRITICAL: verify the actual stored value is UNCHANGED
    const stored = controlConfig("get", dir, "exec.enforce");
    expect(stored).toBe(true);
  });

  it("model-facing control config set on unrelated key still works", () => {
    const dir = join(scratch, "unrelated"); mkdirSync(dir, { recursive: true });
    
    // Try a different valid key (ui.footer exists in schema)
    const result = applyConfigEdit(dir, "ui.footer", "false");
    
    expect(result.ok).toBe(true);
    const stored = controlConfig("get", dir, "ui.footer");
    expect(stored).toBe(false);
  });

  it("with flag off, bash is not blocked; with it on/unset, bash is blocked", () => {
    const handlers: Record<string, Function> = {};
    const mockPi = { on: (name: string, fn: Function) => { handlers[name] = fn; } };
    registerHooks(mockPi);
    
    // Test 1: flag OFF
    const dirOff = join(scratch, "flag-off"); mkdirSync(dirOff, { recursive: true });
    controlConfig("set", dirOff, "exec.enforce", false);
    
    const resultOff = handlers["tool_call"]({ 
      toolName: "bash", 
      input: { command: "echo test" }, 
      cwd: dirOff 
    });
    expect(resultOff).toBeUndefined(); // Not blocked
    
    // Test 2: flag ON
    const dirOn = join(scratch, "flag-on"); mkdirSync(dirOn, { recursive: true });
    controlConfig("set", dirOn, "exec.enforce", true);
    
    const resultOn = handlers["tool_call"]({ 
      toolName: "bash", 
      input: { command: "echo test" }, 
      cwd: dirOn 
    });
    expect(resultOn).toMatchObject({ block: true });
    
    // Test 3: flag UNSET (default)
    const dirUnset = join(scratch, "flag-unset"); mkdirSync(dirUnset, { recursive: true });
    
    const resultUnset = handlers["tool_call"]({ 
      toolName: "bash", 
      input: { command: "echo test" }, 
      cwd: dirUnset 
    });
    expect(resultUnset).toMatchObject({ block: true });
  });

  it("slash command path DOES change the flag (user-only bypass)", () => {
    const dir = join(scratch, "slash"); mkdirSync(dir, { recursive: true });
    
    // Slash command uses controlConfig directly, bypassing applyConfigEdit guard
    controlConfig("set", dir, "exec.enforce", false);
    expect(controlConfig("get", dir, "exec.enforce")).toBe(false);
    
    controlConfig("set", dir, "exec.enforce", true);
    expect(controlConfig("get", dir, "exec.enforce")).toBe(true);
  });
});
