import { describe, it, expect } from "vitest";
import { PolyglotExecutor } from "../executor";
import { runExec } from "../actions/exec";

const ex = () => new PolyglotExecutor({ projectRoot: () => process.cwd() });

describe("exec streaming (matches pi's bash tool pattern)", () => {
  // Mutation this catches: drop the onData call in #spawn -> chunks stays empty.
  it("executor emits output chunks AS THEY ARRIVE, not only at the end", async () => {
    const chunks: string[] = [];
    const r = await ex().execute({
      language: "shell",
      code: "echo first; sleep 0.15; echo second",
      onData: (c: string) => chunks.push(c),
    } as any);
    expect(chunks.length).toBeGreaterThan(0);
    // Arrived in more than one chunk => genuinely streamed, not flushed once at close.
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toContain("first");
    expect(chunks.join("")).toContain("second");
    expect(r.stdout).toContain("second");
  });

  it("stderr streams too", async () => {
    const chunks: string[] = [];
    await ex().execute({
      language: "shell",
      code: "echo oops 1>&2",
      onData: (c: string) => chunks.push(c),
    } as any);
    expect(chunks.join("")).toContain("oops");
  });

  it("no onData supplied → still works (callback is optional)", async () => {
    const r = await ex().execute({ language: "shell", code: "echo fine" } as any);
    expect(r.stdout).toContain("fine");
  });

  // Mutation this catches: stop threading onPartial -> onPartial never fires.
  it("runExec forwards partial output through ctx.onPartial", async () => {
    const seen: string[] = [];
    await runExec(
      { action: "exec", language: "shell", code: "echo a; sleep 0.15; echo b" } as any,
      { cwd: process.cwd(), onPartial: (t: string) => seen.push(t) } as any,
    );
    expect(seen.length).toBeGreaterThan(0);
    // Partials are cumulative snapshots, so the last one holds everything so far.
    expect(seen[seen.length - 1]).toContain("a");
  });

  it("partial snapshots respect the same 10k cap as the final result", async () => {
    const seen: string[] = [];
    await runExec(
      { action: "exec", language: "shell", code: "for i in $(seq 1 2000); do echo 'the quick brown fox jumps over the lazy dog'; done" } as any,
      { cwd: process.cwd(), onPartial: (t: string) => seen.push(t) } as any,
    );
    for (const s of seen) expect(Buffer.byteLength(s)).toBeLessThanOrEqual(10_000);
  });
});
