// packages/host/src/__tests__/exec-enforce-protection.test.ts
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setGlobalDbPathForTests } from "@spider/db-core";
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
