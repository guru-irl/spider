import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const root = join(process.env.SPIDER_GLOBAL_ROOT!, "credential");
mkdirSync(root, { recursive: true });
afterEach(() => vi.unstubAllEnvs());

describe("readCopilotOAuthToken", () => {
  it("reads only the configured OAuth refresh credential without writes or key-command execution", async () => {
    const { readCopilotOAuthToken } = await import("../credential.js");
    const authPath = join(root, "auth.json");
    const sentinel = join(root, "command-executed");
    const text = JSON.stringify({
      "github-copilot": { type: "oauth", refresh: "synthetic-refresh", access: "synthetic-access", expires: 0 },
      github: { type: "api_key", key: "synthetic-gh" },
      other: { type: "api_key", key: `!touch '${sentinel}'` },
    });
    writeFileSync(authPath, text);
    const before = statSync(authPath);
    vi.stubEnv("GH_TOKEN", "synthetic-environment-token");
    expect(readCopilotOAuthToken(authPath)).toBe("synthetic-refresh");
    expect(readFileSync(authPath, "utf8")).toBe(text);
    expect(statSync(authPath).mtimeMs).toBe(before.mtimeMs);
    expect(existsSync(sentinel)).toBe(false);
  });

  it.each([
    {},
    { "github-copilot": { type: "api_key", key: "synthetic-key" } },
    { "github-copilot": { type: "api_key", key: "!touch must-not-execute" } },
    { "github-copilot": { type: "oauth", access: "synthetic-access" } },
    { "github-copilot": { type: "oauth", refresh: " " } },
    { "github-copilot": { type: "oauth", refresh: 123 } },
    { github: { type: "oauth", refresh: "synthetic-other-account" } },
  ])("rejects unusable credentials without fallback: %j", async (data) => {
    const { readCopilotOAuthToken } = await import("../credential.js");
    const authPath = join(root, "invalid.json");
    writeFileSync(authPath, JSON.stringify(data));
    vi.stubEnv("GH_TOKEN", "synthetic-environment-token");
    expect(readCopilotOAuthToken(authPath)).toBeUndefined();
  });

  it("missing and malformed synthetic auth are unavailable", async () => {
    const { readCopilotOAuthToken } = await import("../credential.js");
    expect(readCopilotOAuthToken(join(root, "absent.json"))).toBeUndefined();
    const path = join(root, "malformed.json");
    writeFileSync(path, "{malformed");
    expect(readCopilotOAuthToken(path)).toBeUndefined();
  });
});
