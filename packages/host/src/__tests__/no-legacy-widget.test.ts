// packages/host/src/__tests__/no-legacy-widget.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

describe("no legacy subagents widget", () => {
  it("subagents package does not register subagent-async widget or a poll interval", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const src = readFileSync(join(root, "subagents", "src", "index.ts"), "utf-8");
    expect(src).not.toContain("subagent-async");
    expect(src).not.toMatch(/setInterval\([^)]*250/);
  });
});
