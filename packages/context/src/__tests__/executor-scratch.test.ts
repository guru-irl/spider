import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { PolyglotExecutor } from "../executor";
import { paths } from "@spider/db-core";

describe("executor zero-temp-dir", () => {
  it("runs shell and keeps the child TMPDIR under the spider scratch root, never /tmp", async () => {
    const exec = new PolyglotExecutor({ projectRoot: process.cwd() });
    const res = await exec.execute({ language: "shell", code: 'echo "TMP=$TMPDIR"; echo hi', timeout: 20000 });
    expect(res.stdout).toContain("hi");
    const m = res.stdout.match(/TMP=(.*)/);
    const childTmp = (m?.[1] ?? "").trim();
    const scratchRoot = paths.scratch("project", process.cwd());
    expect(childTmp).not.toBe("");
    expect(childTmp.startsWith(scratchRoot)).toBe(true);   // under spider scratch
    expect(childTmp.startsWith(tmpdir())).toBe(false);     // NOT the OS /tmp
    expect(childTmp.includes("/tmp/")).toBe(false);
  });
});
