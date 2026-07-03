import { describe, it, expect } from "vitest";
import { scrubSecrets, INJECTION_NOTE, SECRET_PATTERNS } from "../scanner";

describe("scrubSecrets", () => {
  it("redacts a GitHub token and reports the id", () => {
    const token = "ghp_" + "a".repeat(20);
    const r = scrubSecrets(`export TOKEN=${token}`);
    expect(r.text).not.toContain(token);
    expect(r.text).toContain("[REDACTED:");
    expect(r.flagged).toContain("github_personal_token");
  });

  it("leaves clean content untouched with no flags", () => {
    const r = scrubSecrets("total files: 42\nall green");
    expect(r.text).toBe("total files: 42\nall green");
    expect(r.flagged).toEqual([]);
  });

  it("redacts every occurrence (global), deduping the id list", () => {
    const token = "ghp_" + "b".repeat(20);
    const r = scrubSecrets(`${token} and again ${token}`);
    expect(r.text.match(/\[REDACTED:/g)).toHaveLength(2);
    expect(r.flagged).toEqual(["github_personal_token"]);
  });

  it("exposes SECRET_PATTERNS + INJECTION_NOTE constants", () => {
    expect(SECRET_PATTERNS.length).toBeGreaterThan(0);
    expect(INJECTION_NOTE).toMatch(/untrusted DATA/);
  });

  it("redacts a secret located BEYOND 64KB (no unscrubbed tail leaks) [P3 review M1]", () => {
    const token = "ghp_" + "z".repeat(20);
    const r = scrubSecrets("x".repeat(70_000) + "\n" + token + "\n" + "y".repeat(1000));
    expect(r.text).not.toContain(token);
    expect(r.text).toContain("[REDACTED:github_personal_token]");
    expect(r.flagged).toContain("github_personal_token");
  });
});
