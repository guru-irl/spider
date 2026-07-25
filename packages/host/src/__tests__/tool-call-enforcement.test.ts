// packages/host/src/__tests__/tool-call-enforcement.test.ts
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setGlobalDbPathForTests } from "@spider/db-core";
import { registerHooks } from "../hooks";
import { controlConfig } from "../control";

const scratch = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".spider", "scratch", `enforcement-${process.pid}`);
beforeEach(() => { 
  mkdirSync(scratch, { recursive: true }); 
  // Initialize as git repo so projectRoot resolves to this directory, not parent repo
  require("child_process").execFileSync("git", ["init", "-q"], { cwd: scratch });
  setGlobalDbPathForTests(join(scratch, `g-${Date.now()}.db`)); 
});
afterEach(() => { setGlobalDbPathForTests(null); rmSync(scratch, { recursive: true, force: true }); });

describe("tool_call hook bash enforcement", () => {
  it("blocks bash when exec.enforce is unset (default ON)", () => {
    const dir = join(scratch, "default"); mkdirSync(dir, { recursive: true });
    const handlers: Record<string, Function> = {};
    const mockPi = { on: (name: string, fn: Function) => { handlers[name] = fn; } };
    
    registerHooks(mockPi);
    
    expect(handlers["tool_call"]).toBeDefined();
    const result = handlers["tool_call"]({ 
      toolName: "bash", 
      input: { command: "echo hello" }, 
      cwd: dir 
    });
    
    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain("bash is disabled");
    expect(result.reason).toContain("spider exec");
    expect(result.reason).toContain("echo hello");
  });

  it("blocks bash and shows exact replacement command", () => {
    const dir = join(scratch, "replacement"); mkdirSync(dir, { recursive: true });
    const handlers: Record<string, Function> = {};
    const mockPi = { on: (name: string, fn: Function) => { handlers[name] = fn; } };
    
    registerHooks(mockPi);
    
    const testCmd = "npm test -- --run";
    const result = handlers["tool_call"]({ 
      toolName: "bash", 
      input: { command: testCmd }, 
      cwd: dir 
    });
    
    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain(testCmd);
    expect(result.reason).toContain('action: "exec"');
    expect(result.reason).toContain('language: "shell"');
  });

  it("does NOT block bash when exec.enforce is explicitly false", () => {
    const dir = join(scratch, "disabled"); mkdirSync(dir, { recursive: true });
    controlConfig("set", dir, "exec.enforce", false);
    
    const handlers: Record<string, Function> = {};
    const mockPi = { on: (name: string, fn: Function) => { handlers[name] = fn; } };
    
    registerHooks(mockPi);
    
    const result = handlers["tool_call"]({ 
      toolName: "bash", 
      input: { command: "ls -la" }, 
      cwd: dir 
    });
    
    expect(result).toBeUndefined();
  });

  it("does NOT block non-bash tools regardless of config", () => {
    const dir = join(scratch, "nonbash"); mkdirSync(dir, { recursive: true });
    // Config is ON (default)
    
    const handlers: Record<string, Function> = {};
    const mockPi = { on: (name: string, fn: Function) => { handlers[name] = fn; } };
    
    registerHooks(mockPi);
    
    const readResult = handlers["tool_call"]({ 
      toolName: "read", 
      input: { path: "/some/file" }, 
      cwd: dir 
    });
    expect(readResult).toBeUndefined();
    
    const writeResult = handlers["tool_call"]({ 
      toolName: "write", 
      input: { path: "/some/file", content: "data" }, 
      cwd: dir 
    });
    expect(writeResult).toBeUndefined();
  });

  it("handles very long commands by truncating the reason", () => {
    const dir = join(scratch, "longcmd"); mkdirSync(dir, { recursive: true });
    const handlers: Record<string, Function> = {};
    const mockPi = { on: (name: string, fn: Function) => { handlers[name] = fn; } };
    
    registerHooks(mockPi);
    
    const longCmd = "echo " + "x".repeat(1000);
    const result = handlers["tool_call"]({ 
      toolName: "bash", 
      input: { command: longCmd }, 
      cwd: dir 
    });
    
    expect(result).toMatchObject({ block: true });
    expect(result.reason.length).toBeLessThan(1500); // Reasonable cap
  });

  it("never propagates errors from hook handler (defensive style)", () => {
    const handlers: Record<string, Function> = {};
    const mockPi = { on: (name: string, fn: Function) => { handlers[name] = fn; } };
    
    registerHooks(mockPi);
    
    // Force an error condition by passing malformed input
    expect(() => {
      handlers["tool_call"]({ 
        toolName: "bash", 
        input: null, // Bad input
        cwd: "/nonexistent" 
      });
    }).not.toThrow();
  });
});
