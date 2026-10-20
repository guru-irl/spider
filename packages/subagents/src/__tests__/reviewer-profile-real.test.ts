import { expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildChildSpawnSpec } from "../pi-args";
import { defaultSpawner } from "../spawn-default";
import { createEditTool, createReadTool, createWriteTool, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
const piRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const probeExtension = fileURLToPath(new URL("./helpers/offline-tool-profile-extension.ts", import.meta.url));

for (const context of ["fresh", "fork"] as const) {
  for (const childMode of ["rpc", "print"] as const) {
    for (const tools of [undefined, "read,edit,write,profile_probe", "+edit,+write,+profile_probe"]) {
      it(`real pi: ${context} ${childMode} reviewer excludes declarations and direct/nested calls with --tools=${tools ?? "defaults"}`, async () => {
        const scratch = resolve(process.env.SPIDER_TEST_FIXTURE_CHECKOUT!, ".spider/scratch/reviewer-profile-real");
        mkdirSync(scratch, { recursive: true });
        const root = mkdtempSync(join(scratch, "case-"));
        const evidence = join(root, "evidence.json"), target = join(root, "target.txt"), agentDir = join(root, "agent");
        mkdirSync(agentDir);
        writeFileSync(target, "original");
        // If --no-extensions regresses, these settings would load built-in codemode/MCP.
        writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["+codemode", "+tool_search"] }));
        writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { forbidden: { command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(join(root, "mcp-started"))}, 'started')`] } } }));
        let parentSessionFile: string | undefined;
        if (context === "fork") {
          const parent = SessionManager.create(root, join(root, "parent-sessions"));
          parent.appendMessage({ role: "system", content: "", sections: { preamble: "Parent prompt" }, timestamp: Date.now(),
            toolsAdded: [createReadTool(root), createEditTool(root), createWriteTool(root)].map(({ name, description, parameters }) => ({ name, description, parameters })) });
          parent.appendMessage({ role: "user", content: "Inherited parent turn", timestamp: Date.now() });
          parent.appendMessage(fauxAssistantMessage("Parent done"));
          parentSessionFile = parent.getSessionFile()!;
          const transcript = readFileSync(parentSessionFile, "utf8");
          expect(transcript).toContain('"name":"edit"');
          expect(transcript).toContain('"name":"write"');
        }
        const spec = buildChildSpawnSpec({ runId: "profile", sessionId: "owner", agent: "reviewer", task: "check tools", context,
          parentSessionId: "owner", parentSessionFile, childIndex: 0, dbPath: join(root, "project.db"), scratchRoot: root, cwd: root, childMode,
          model: "spider-offline-profile/fixture", childExtensionPath: probeExtension });
        const args = [join(piRoot, "dist/cli.js"), ...spec.argv.slice(1), "--offline", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes"];
        if (tools) args.push("--tools", tools);
        const events: unknown[] = [];
        const handle = defaultSpawner({ ...spec, argv: [process.execPath, ...args],
          env: { ...spec.env, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_CODING_AGENT_DIR: agentDir,
            PROFILE_EVIDENCE: evidence, PROFILE_TARGET: target }, onRpcEvent: event => { events.push(event); } });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const outcome = await Promise.race([handle.wait(), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Tool profile child timed out: ${JSON.stringify(events)}`)), 15000);
          })]);
          expect(outcome, JSON.stringify(events)).toMatchObject({ exitCode: 0 });
          const result = JSON.parse(readFileSync(evidence, "utf8"));
          expect(result.directResults).toEqual(["edit", "write"].map(toolName => ({ toolName, isError: true, text: expect.stringMatching(/not (found|available)|unknown/i) })));
          for (const list of [result.declared, result.active, result.registered, result.callable]) {
            expect(list, JSON.stringify(result)).toContain("read");
            for (const name of ["edit", "write", "codemode", "tool_search"]) expect(list).not.toContain(name);
            expect(list.some((name: string) => name.startsWith("mcp__"))).toBe(false);
          }
          if (context === "fork") {
            const inherited = readFileSync(result.sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
            expect(inherited.some(entry => entry.type === "message" && entry.message.role === "user" && entry.message.content === "Inherited parent turn")).toBe(true);
            for (const name of ["edit", "write"]) expect(inherited.some(entry => entry.type === "message" && entry.message.role === "system" && entry.message.toolsAdded?.some((tool: { name: string }) => tool.name === name))).toBe(true);
          }
          expect(result.errors).toEqual({ edit: expect.stringMatching(/not (found|available)|unknown/i), write: expect.stringMatching(/not (found|available)|unknown/i) });
          expect(readFileSync(target, "utf8")).toBe("original");
          expect(() => readFileSync(join(root, "mcp-started"))).toThrow();
        } finally {
          clearTimeout(timer);
          await handle.killAsync?.();
          rmSync(root, { recursive: true, force: true });
        }
      }, 20000);
    }
  }
}
