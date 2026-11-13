import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import spiderExtension from "../extension";
import { hostUnitPorts } from "./fixtures/pi-events";

let root = "";
afterEach(() => {
  vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

it("refreshes managed guidance before Pi reads context files", async () => {
  const scratch = resolve(".spider/scratch/tmp"); mkdirSync(scratch, { recursive: true });
  root = mkdtempSync(join(scratch, "guidance-startup-"));
  const agentDir = join(root, "agent"), cwd = join(root, "project");
  mkdirSync(agentDir); mkdirSync(cwd);
  const file = join(agentDir, "AGENTS.md");
  writeFileSync(file, "<!-- spider:start -->\nold managed guidance\n<!-- spider:end -->\n\n# Personal instructions\nKeep this.\n");
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("SPIDER_GLOBAL_ROOT", join(root, "global"));
  vi.stubEnv("VITEST", "false"); // Exercise the real guidance write, confined to agentDir.
  const loader = new DefaultResourceLoader({
    cwd, agentDir, extensionFactories: [pi => spiderExtension(pi as never, hostUnitPorts)],
    disabledBuiltinExtensions: ["mcp", "codemode", "tool-search", "llama.cpp"],
    noSkills: true, noPromptTemplates: true, noThemes: true,
  });
  await loader.reload();
  const loaded = loader.getAgentsFiles().agentsFiles.find(item => item.path === file)?.content;
  expect(loaded).toContain("# spider (managed");
  expect(loaded).not.toContain("old managed guidance");
  expect(loaded).toContain("# Personal instructions\nKeep this.");
  expect(readFileSync(file, "utf8")).toBe(loaded);
}, 5000);
