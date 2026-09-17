import { describe, it, expect, vi } from "vitest";
import { PolyglotExecutor } from "../executor";
import { runExec, runExecFile, runBatch } from "../actions/exec";

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

  // A-H2 (branch-review A-architecture.md): `executeFile`'s own implementation used to
  // destructure only {path, language, code, timeout} from `opts` and silently drop
  // `onData`/`signal`, even though `ExecuteFileOptions extends ExecuteOptions` (which
  // declares both) — so ANY caller passing them got no streaming/abort at all, one level
  // below actions/exec.ts.
  it("executor.executeFile ALSO streams output chunks as they arrive, not just execute() (A-H2)", async () => {
    const chunks: string[] = [];
    await ex().executeFile({
      path: "package.json",
      language: "shell",
      code: "echo first; sleep 0.15; echo second",
      onData: (c: string) => chunks.push(c),
    } as any);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toContain("second");
  });

  // The host declares exec_file/batch streaming (extension.ts's `streams` predicate) and
  // threads `onPartial` all the way to `ActionCtx` — but actions/exec.ts's `runExecFile`/
  // `runBatch` passed it to NEITHER `executeFile()` nor `execute()`. Mutation this catches:
  // stop threading onPartial through runExecFile -> onPartial never fires.
  it("runExecFile forwards partial output through ctx.onPartial (A-H2)", async () => {
    const seen: string[] = [];
    await runExecFile(
      { action: "exec_file", path: "package.json", language: "shell", code: "echo a; sleep 0.15; echo b" } as any,
      { cwd: process.cwd(), onPartial: (t: string) => seen.push(t) } as any,
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toContain("a");
  });

  // Mutation this catches: stop threading onPartial through runBatch -> onPartial never fires,
  // or omit the completion flush -> the throttled tail never reaches the final partial.
  it("runBatch flushes the final cumulative partial without waiting out the throttle (A-H2)", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const seen: string[] = [];
    const alreadyFinal: string[] = [];
    try {
      await runBatch(
        { action: "batch", commands: [
          { language: "shell", code: "echo a" },
          { language: "shell", code: "echo c" },
        ] } as any,
        { cwd: process.cwd(), onPartial: (t: string) => seen.push(t) } as any,
      );
      await runExec(
        { action: "exec", language: "shell", code: "echo only" } as any,
        { cwd: process.cwd(), onPartial: (t: string) => alreadyFinal.push(t) } as any,
      );
    } finally {
      now.mockRestore();
    }
    expect(seen.length).toBeGreaterThan(0);
    // The frozen clock makes every chunk after the first stay inside the throttle window.
    // Completion must still publish the whole batch transcript, with no fixture sleeps.
    expect(seen[seen.length - 1]).toContain("a");
    expect(seen[seen.length - 1]).toContain("c");
    // A one-chunk command was already published exactly; completion must not repeat it.
    expect(alreadyFinal).toEqual(["only\n"]);
  });
});
