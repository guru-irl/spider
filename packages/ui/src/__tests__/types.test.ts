import { describe, it, expect } from "vitest";
import { STATUS_GLYPH, statusToken } from "../agents/types";

describe("agent status vocabulary", () => {
  it("has a glyph for every status", () => {
    for (const s of ["queued","running","paused","done","failed","cancelled"] as const) {
      expect(typeof STATUS_GLYPH[s]).toBe("string");
      expect(STATUS_GLYPH[s].length).toBeGreaterThan(0);
    }
  });
  it("maps status to a semantic theme token", () => {
    expect(statusToken("done")).toBe("success");
    expect(statusToken("failed")).toBe("error");
    expect(statusToken("cancelled")).toBe("warning");
    expect(statusToken("running")).toBe("accent");
    expect(statusToken("queued")).toBe("muted");
    expect(statusToken("paused")).toBe("muted");
  });
});
