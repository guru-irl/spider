// Test-only harness for executor-background-survival.test.ts.
//
// This file is never imported directly by the test (or by anything else) — it is
// bundled by esbuild into a single, dependency-free .mjs and run with plain `node`
// as a genuinely SEPARATE OS process. That is the entire point: the headline test
// needs a real "launching process" that can actually terminate (simulating a pi
// session / subagent finishing) while the vitest worker that started it keeps
// running to observe what happens to the grandchild afterward. You cannot fake
// that from inside the same process — only a real process exit closes the pipe
// read-ends the old, buggy code depended on.
//
// argv: [projectRoot, shellCode, timeoutMs, handoffPath]
import { PolyglotExecutor } from "../../executor";

async function main(): Promise<void> {
  const [projectRoot, shellCode, timeoutMsRaw, handoffPath] = process.argv.slice(2);
  const executor = new PolyglotExecutor({ projectRoot });
  const result = await executor.execute({
    language: "shell",
    code: shellCode,
    background: true,
    timeout: Number(timeoutMsRaw),
  });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(handoffPath, JSON.stringify(result));
  // The moment that matters: simulate the launching pi process exiting right
  // after the command was backgrounded (e.g. a subagent finishing). Under the
  // old code this is exactly when the child's stdout/stderr pipes lose their
  // read end.
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("HARNESS_ERROR", err);
  process.exit(1);
});
