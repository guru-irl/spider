import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tailLogs } from "../log-tail";

const dirs: string[] = [];
function fixtureDir(): string {
  const d = mkdtempSync(join(tmpdir(), "log-tail-test-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("tailLogs — incremental file tail", () => {
  it("delivers appended bytes incrementally, in more than one chunk", async () => {
    const dir = fixtureDir();
    const stdout = join(dir, "stdout.log");
    const stderr = join(dir, "stderr.log");
    writeFileSync(stdout, "");
    writeFileSync(stderr, "");

    const chunks: string[] = [];
    const tail = tailLogs({ stdout, stderr }, (c) => chunks.push(c), { intervalMs: 20 });

    appendFileSync(stdout, "hello ");
    await sleep(60);
    appendFileSync(stdout, "world");
    await sleep(60);

    tail.stop();
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe("hello world");
  });

  it("stderr is tailed independently of stdout", async () => {
    const dir = fixtureDir();
    const stdout = join(dir, "stdout.log");
    const stderr = join(dir, "stderr.log");
    writeFileSync(stdout, "");
    writeFileSync(stderr, "");

    const chunks: string[] = [];
    const tail = tailLogs({ stdout, stderr }, (c) => chunks.push(c), { intervalMs: 20 });
    appendFileSync(stderr, "oops");
    await sleep(60);
    tail.stop();
    expect(chunks.join("")).toContain("oops");
  });

  it("handles a split multi-byte UTF-8 sequence across two reads without corruption", async () => {
    const dir = fixtureDir();
    const stdout = join(dir, "stdout.log");
    const stderr = join(dir, "stderr.log");
    writeFileSync(stdout, "");
    writeFileSync(stderr, "");

    // "🕸" is 4 bytes in UTF-8 (F0 9F 95 B8). Write byte-by-byte with a poll in
    // between so the tail is forced to observe a partial sequence mid-character.
    const full = Buffer.from("before 🕸 after", "utf-8");
    const chunks: string[] = [];
    const tail = tailLogs({ stdout, stderr }, (c) => chunks.push(c), { intervalMs: 15 });

    const fd = openSync(stdout, "a");
    for (let i = 0; i < full.length; i++) {
      require("node:fs").writeSync(fd, full, i, 1);
      if (i % 3 === 0) await sleep(20);
    }
    closeSync(fd);
    await sleep(80);
    tail.stop();

    expect(chunks.join("")).toBe(full.toString("utf-8"));
    expect(chunks.join("")).not.toContain("\uFFFD"); // no replacement-character corruption
  });

  it("stop() halts polling — no callback fires for data appended after stop()", async () => {
    const dir = fixtureDir();
    const stdout = join(dir, "stdout.log");
    const stderr = join(dir, "stderr.log");
    writeFileSync(stdout, "");
    writeFileSync(stderr, "");

    const chunks: string[] = [];
    const tail = tailLogs({ stdout, stderr }, (c) => chunks.push(c), { intervalMs: 15 });
    appendFileSync(stdout, "before-stop");
    await sleep(50);
    tail.stop();
    const countAtStop = chunks.length;
    appendFileSync(stdout, "after-stop");
    await sleep(100);
    expect(chunks.length).toBe(countAtStop);
    expect(chunks.join("")).not.toContain("after-stop");
  });

  it("stop() is idempotent — calling it twice does not throw", async () => {
    const dir = fixtureDir();
    const stdout = join(dir, "stdout.log");
    const stderr = join(dir, "stderr.log");
    writeFileSync(stdout, "");
    writeFileSync(stderr, "");
    const tail = tailLogs({ stdout, stderr }, () => {}, { intervalMs: 15 });
    tail.stop();
    expect(() => tail.stop()).not.toThrow();
  });

  it("tolerates the log file not existing yet at start, then picks up writes once it appears", async () => {
    const dir = fixtureDir();
    const stdout = join(dir, "stdout.log");
    const stderr = join(dir, "stderr.log");
    // Neither file exists yet when tailLogs starts.
    const chunks: string[] = [];
    const tail = tailLogs({ stdout, stderr }, (c) => chunks.push(c), { intervalMs: 15 });
    await sleep(40);
    writeFileSync(stdout, "late-arrival");
    await sleep(80);
    tail.stop();
    expect(chunks.join("")).toContain("late-arrival");
  });

  it("stop() performs one final bounded read before closing — the tail end reaches onData with NO trailing sleep and no further poll tick (I1)", async () => {
    const dir = fixtureDir();
    const stdout = join(dir, "stdout.log");
    const stderr = join(dir, "stderr.log");
    writeFileSync(stdout, "");
    writeFileSync(stderr, "");

    const chunks: string[] = [];
    // A long interval so the write below has NO chance to be picked up by a
    // regular poll tick before stop() is called right after it — the only way
    // this can pass is if stop() itself performs a final read, not the poll loop.
    const tail = tailLogs({ stdout, stderr }, (c) => chunks.push(c), { intervalMs: 5000 });
    await sleep(30); // let the (empty) first tick land — nothing to prove yet
    appendFileSync(stdout, "FINAL_LINE_NO_SLEEP");
    appendFileSync(stderr, "FINAL_ERR_NO_SLEEP");
    tail.stop(); // called IMMEDIATELY — no trailing sleep, no future tick will ever fire
    const joined = chunks.join("");
    expect(joined).toContain("FINAL_LINE_NO_SLEEP");
    expect(joined).toContain("FINAL_ERR_NO_SLEEP");
  });

  it("a second stop() after the final flush does not re-deliver or duplicate the flushed bytes", async () => {
    const dir = fixtureDir();
    const stdout = join(dir, "stdout.log");
    const stderr = join(dir, "stderr.log");
    writeFileSync(stdout, "");
    writeFileSync(stderr, "");
    const chunks: string[] = [];
    const tail = tailLogs({ stdout, stderr }, (c) => chunks.push(c), { intervalMs: 5000 });
    appendFileSync(stdout, "ONCE");
    tail.stop();
    tail.stop();
    expect(chunks.join("")).toBe("ONCE");
  });

  it("bounds a single read to maxBytes — a huge backlog is delivered over multiple ticks, not one giant read", async () => {
    const dir = fixtureDir();
    const stdout = join(dir, "stdout.log");
    const stderr = join(dir, "stderr.log");
    const big = "x".repeat(10_000);
    writeFileSync(stdout, big);
    writeFileSync(stderr, "");

    const chunkSizes: number[] = [];
    const tail = tailLogs({ stdout, stderr }, (c) => chunkSizes.push(Buffer.byteLength(c)), {
      intervalMs: 20,
      maxBytes: 1000,
    });
    await sleep(400);
    tail.stop();
    expect(chunkSizes.length).toBeGreaterThan(1); // more than one read was needed
    for (const size of chunkSizes) expect(size).toBeLessThanOrEqual(1000);
    expect(chunkSizes.reduce((a, b) => a + b, 0)).toBe(10_000);
  });
});
