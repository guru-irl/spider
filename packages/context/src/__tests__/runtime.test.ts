import { describe, it, expect } from "vitest";
import { detectRuntimes, getAvailableLanguages } from "../runtime";

describe("runtime detection", () => {
  it("always reports javascript + shell available (node + sh present)", () => {
    const rt = detectRuntimes();
    const langs = getAvailableLanguages(rt);
    expect(langs).toContain("javascript");
    expect(langs).toContain("shell");
  });
});
