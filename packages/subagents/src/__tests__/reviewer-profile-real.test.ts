import { expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildChildSpawnSpec } from "../pi-args";
import { defaultSpawner } from "../spawn-default";
const piRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const probeExtension = fileURLToPath(new URL("./helpers/offline-tool-profile-extension.ts", import.meta.url));

for (const childMode of ["rpc", "print"] as const) {
  for (const tools of [undefined, "read,edit,write,profile_probe", "+edit,+write,+profile_probe"]) {
    it(`real pi: ${childMode} reviewer excludes declarations and nested calls with --tools=${tools ?? "defaults"}`, async () => {
      const scratch = resolve(process.env.SPIDER_TEST_FIXTURE_CHECKOUT!, ".spider/scratch/reviewer-profile-real");
      mkdirSync(scratch, { recursive: true });
      const root = mkdtempSync(join(scratch, "case-"));
      const evidence = join(root, "evidence.json"), target = join(root, "target.txt"), agentDir = join(root, "agent");
      mkdirSync(agentDir);
      writeFileSync(target, "original");
      // If --no-extensions regresses, these settings would load built-in codemode/MCP.
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["+codemode", "+tool_search"] }));
      writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { forbidden: { command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(join(root, "mcp-started"))}, 'started')`] } } }));
      const spec = buildChildSpawnSpec({ runId: "profile", sessionId: "owner", agent: "reviewer", task: "check tools", context: "fresh",
        parentSessionId: "owner", childIndex: 0, dbPath: join(root, "project.db"), scratchRoot: root, cwd: root, childMode,
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
        for (const list of [result.declared, result.active, result.registered, result.callable]) {
          expect(list).toContain("read");
          for (const name of ["edit", "write", "codemode", "tool_search"]) expect(list).not.toContain(name);
          expect(list.some((name: string) => name.startsWith("mcp__"))).toBe(false);
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
