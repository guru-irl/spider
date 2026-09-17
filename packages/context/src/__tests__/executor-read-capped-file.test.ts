import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@spider/db-core";
import { readCappedFile } from "../executor";

describe("readCappedFile", () => {
  it("returns full content and truncated:false when the file is under the cap", () => {
    const dir = mkdtempSync(join(paths.scratch("project", process.cwd()), ".rcf-"));
    try {
      const p = join(dir, "small.log");
      writeFileSync(p, "hello world");
      const r = readCappedFile(p, 1000);
      expect(r).toEqual({ text: "hello world", truncated: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps at maxBytes and reports truncated:true when the file is over the cap", () => {
    const dir = mkdtempSync(join(paths.scratch("project", process.cwd()), ".rcf-"));
    try {
      const p = join(dir, "big.log");
      writeFileSync(p, "0123456789");
      const r = readCappedFile(p, 4);
      expect(r.truncated).toBe(true);
      expect(r.text).toBe("0123");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty, non-truncated content for a file that doesn't exist", () => {
    const r = readCappedFile("/no/such/path/ever", 1000);
    expect(r).toEqual({ text: "", truncated: false });
  });
});
