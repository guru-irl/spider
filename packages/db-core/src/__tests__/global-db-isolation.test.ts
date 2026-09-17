import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { openGlobal } from "../registry";
import { paths } from "../paths";

const REAL_GLOBAL_ROOT = join(homedir(), ".pi", "agent", "spider");
const REAL_GLOBAL_DB = join(REAL_GLOBAL_ROOT, "spider.db");

describe("global database test isolation guard", () => {
  it("redirects openGlobal away from the user's real database before opening anything", () => {
    // These assertions MUST run before openGlobal(). If test isolation is absent or
    // paths.ts stops honoring it, fail without opening or migrating the real DB.
    expect(
      process.env.SPIDER_GLOBAL_ROOT,
      "Vitest must install a process-scoped SPIDER_GLOBAL_ROOT before test modules load",
    ).toBeTruthy();
    expect(
      resolve(paths.globalRoot),
      `refusing to open the user's real global DB at ${REAL_GLOBAL_DB}`,
    ).not.toBe(resolve(REAL_GLOBAL_ROOT));

    const db = openGlobal();
    try {
      const rows = db.raw.pragma("database_list") as Array<{ name: string; file: string }>;
      const file = rows.find((row) => row.name === "main")?.file;
      expect(file).toBeTruthy();
      expect(resolve(file!)).toBe(resolve(paths.globalRoot, "spider.db"));
      expect(resolve(file!)).not.toBe(resolve(REAL_GLOBAL_DB));
    } finally {
      db.close();
    }
  });
});
