import { describe, it, expect } from "vitest";
import { buildCommand, detectRuntimes, getAvailableLanguages, type Language, type RuntimeMap } from "../runtime";

describe("runtime detection", () => {
  it("always reports javascript + shell available (node + sh present)", () => {
    const rt = detectRuntimes();
    const langs = getAvailableLanguages(rt);
    expect(langs).toContain("javascript");
    expect(langs).toContain("shell");
  });

  const baseRuntimes: RuntimeMap = {
    javascript: process.execPath, typescript: null, python: null, shell: "sh",
    ruby: null, go: null, rust: null, php: null, perl: null, r: null,
    elixir: null, csharp: null,
  };
  const configuredCommands: { language: Language; runtime: keyof RuntimeMap; binary: string; args: string[] }[] = [
    { language: "go", runtime: "go", binary: "/fixture/tools/go", args: ["run", "/fixture/script.go"] },
    { language: "php", runtime: "php", binary: "/fixture/tools/php", args: ["/fixture/script.php"] },
    { language: "perl", runtime: "perl", binary: "/fixture/tools/perl", args: ["/fixture/script.pl"] },
    { language: "elixir", runtime: "elixir", binary: "/fixture/tools/elixir", args: ["/fixture/script.exs"] },
    { language: "typescript", runtime: "typescript", binary: "/fixture/tools/tsx", args: ["/fixture/script.ts"] },
    { language: "typescript", runtime: "typescript", binary: "/fixture/tools/ts-node", args: ["/fixture/script.ts"] },
  ];
  for (const { language, runtime, binary, args } of configuredCommands) {
    it(`${language} uses configured ${binary.split("/").pop()} executable`, () => {
      const runtimes = { ...baseRuntimes, [runtime]: binary };
      expect(buildCommand(runtimes, language, args.at(-1)!)).toEqual([binary, ...args]);
    });
  }
});
