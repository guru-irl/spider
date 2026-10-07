import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { dashboardLabel } from "../dashboard-identities.js";
import { createDashboardFixture } from "./fixtures/dashboard-ledger.js";
import { homeForms, labelLeaks } from "./fixtures/label-privacy.js";

const home = "/synthetic/home dir";
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
// Breaks when a prefix, URL authority/port or drive colon hides an absolute start.
it.each([
  ["-C/srv/a/b/c", "-C…/b/c"],
  ["prefix-C/src/private docs/a/b", "prefix-C…/a/b"],
  ["a.a-b-IC://private/src/a/b", "a.a-b-IC:…/a/b"],
  ["C-CC://Root/private/a/b", "C-CC:…/a/b"],
  ["日本file://Root/private/a/b", "日本file:…/a/b"],
  ["𝔸file://Root/private/a/b", "𝔸file:…/a/b"],
  ["-file://example.invalid/private/a/b", "-file://example.invalid…/a/b"],
  ["123file://Root/private/a/b", "123file:…/a/b"],
  [String.raw`\Users\me\x`, "…/me/x"],
  ["docs/x/ya./srv/secret/a/b", "docs…/a/b"],
  ["PATH=/a/b:/c/d/e", "PATH=…/d/e"],
  ["a.FILE:///srv/secret/a/b", "a.FILE://…/a/b"],
  ["*file:///c:\\secret\\a\\b", "*file://…/a/b"],
  ["x!file:///c:\\secret\\a\\b", "x!file://…/a/b"],
  ["/srv/a/b/fooC:\\secret\\x\\y", "…/x/y"],
  ["/Users/bob/My Files/report: ok", "…/My Files/report: ok"],
  ["/srv/secret/My Docs/x:", "…/My Docs/x:"],
  ["vscode-insiders://file/srv/secret/a/b", "vscode-insiders://file…/a/b"],
  ["cursor://file/srv/secret/a/b", "cursor://file…/a/b"],
  ["./src/index.ts", "./src/index.ts"], ["../a/b", "../a/b"], ["see ./docs/x", "see ./docs/x"],
  ["--cwd=./src/index.ts", "--cwd=./src/index.ts"],
  ["(../a/b)", "(../a/b)"], ["`./docs/x`", "`./docs/x`"],
  ["./src/a/b/c", "./src/a/b/c"], ["../日本/a/b/c", "../日本/a/b/c"], ["./🙂/a/b/c", "./🙂/a/b/c"],
  ["./src/foo:/srv/secret/a/b", "./src/foo:…/a/b"],
  ["./src/x-C/srv/secret/a/b", "./src/x-C…/a/b"],
  ["../a.a./srv/secret/a/b", "../a.a.…/a/b"],
  [String.raw`../abc:C:\srv\secret\a\b`, "../abc:…/a/b"],
  ["Review /srv/a/b/c then compare docs/x/y", "Review …/x/y"],
  ["/srv/private/a b/c d/e", "…/c d/e"],
  ["/srv/a/b /other/secret/c/d", "…/c/d"],
  ["/srv/a/b/c ~/Private/work", "…/Private/work"],
  ["file:///srv/a/b", "file://…/a/b"],
])("controller scheme: %s", (input, expected) => {
  const result = dashboardLabel("role", input!, home)!;
  expect(result).toBe(expected);
  expect(labelLeaks(result, [home])).toEqual([]);
});

// Breaks when the last whole-string home backstop omits any representation.
it.each([
  ...["“", "‘", "«", "「", "（", "：", "→", "•", "#", "$", "%", "^", "?", "-I", "-L", "-o", "--prefix", "\u200b", "…", "x"],
])("arbitrary prefix %s cannot hide home or outside roots", prefix => {
  for (const path of [home + "/x", "/srv/secret/a/b"]) {
    const result = dashboardLabel("role", prefix + path, home)!;
    expect(labelLeaks(result, [home], ["secret"])).toEqual([]);
  }
});
it.each([
  `${home}/a -C${home}/b`, `${home}/a x.${home}/b`, `${home}/a -I${home}/b`, `${home}/a see#${home}/b`,
  `@http://h:8080${home}/y`, `${home}/x@http://h:8080${home}/y`,
  `${home}/a\n${home}/b`, `${home}/a\u3000${home}/b`, `PATH=${home}/bin a:${home}/x`,
  ...homeForms(home).flatMap(form => [`prefix${form}`, `İ${form}`]),
  "https://host/synthetic/home%20dir/x", "\\synthetic\\home dir\\x",
])("home backstop: %s", input => {
  expect(labelLeaks(dashboardLabel("role", input, home)!, [home])).toEqual([]);
});
it("home backstop keeps an expanding Unicode prefix intact", () => {
  for (const form of homeForms(home)) expect(dashboardLabel("role", "İ" + form, home)).toBe("İ~");
});
it.each(["darwin", "win32", "linux"])("home matching follows %s casing", platform => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: platform });
    const input = "prefix%2FSYNTHETIC%2FHOME%20DIR";
    expect(dashboardLabel("role", input, home)).toBe(platform === "linux" ? "prefix…/SYNTHETIC/HOME DIR" : "prefix~");
  } finally { Object.defineProperty(process, "platform", descriptor); }
});
it("backstop covers both lexical and realpath homes", () => {
  const fixture = createDashboardFixture(false);
  try {
    const real = join(fixture.root, "home dir"), lexical = join(fixture.root, "home alias");
    mkdirSync(real); symlinkSync(real, lexical);
    vi.stubEnv("HOME", lexical);
    for (const configured of [lexical, real]) for (const form of [...homeForms(lexical), ...homeForms(real)]) {
      const result = dashboardLabel("role", "prefix" + form, configured)!;
      expect(result).toBe("prefix~");
      expect(labelLeaks(result, [lexical, real])).toEqual([]);
    }
  } finally { vi.unstubAllEnvs(); fixture.close(); }
});

// A long path shrinks so a cap-cut home or surrogate becomes visible on the wire.
it("caps before scanning without splitting surrogate pairs or exposing cut home prefixes", () => {
  const lead = "/" + "a/".repeat(2000);
  for (const configured of ["/Users/someuser", home, "/synthetic/hôme ü", "/synthetic/path/to/private/home dir", "C:\\synthetic\\path\\to\\home dir"]) {
    for (const form of homeForms(configured)) for (let cut = 8; cut < form.length; cut++) for (const joiner of [" ", ";"]) {
      const input = lead + "b".repeat(4096 - lead.length - 1 - cut) + joiner + form + "/x";
      const result = dashboardLabel("role", input, configured)!;
      expect(result.endsWith("~…"), `cut ${cut}: ${result}`).toBe(true);
    }
  }
  const input = "/" + "a/".repeat(2046) + "q " + "🙂".repeat(10);
  const result = dashboardLabel("role", input, home)!;
  expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(result)).toBe(false);
  expect(dashboardLabel("role", "/" + "a".repeat(4095) + "/TAIL/SUFFIX", home)).not.toContain("TAIL");
});

it.each(["/", "", "C:", "C:\\\\", "C:/", "//"])("configured home root %j disables raw-home mapping too", root => {
  vi.stubEnv("HOME", home);
  expect(dashboardLabel("role", `at ${home}/a/b`, root)).toBe("at …/a/b");
});
it("embedded drive normalization cannot pop the drive root before home comparison", () => {
  expect(dashboardLabel("role", "C:\\\\a\\\\..\\\\..\\\\x", "C:\\\\x")).toBe("~");
});

// A raw homedir root must not poison a valid configured home's backstop.
it.each(["/", "", "C:", "C:\\\\", "C:/", "//"])("raw home root %j never creates a home backstop", raw => {
  vi.stubEnv("HOME", raw);
  expect(dashboardLabel("role", "at /private/team/project", home)).toBe("at …/team/project");
  expect(dashboardLabel("role", `at ${home}/a/../b`, home)).toBe("at ~/b");
});

function random(seed: number) {
  return () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 2 ** 32; };
}
// Rebuilt from the reviewer's seeded generator. Removing a root detection or
// truncating only the first of glued paths leaves a unique root marker behind.
it("200000 seeded cross-platform labels leak no home-prefix segments or redacted roots", () => {
  const home = "/PrivacyRootQ7/Home UserQ7";
  vi.stubEnv("HOME", home);
  const start = performance.now();
  const examples: string[] = [];
  let leaks = 0;
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    for (const platform of ["darwin", "linux", "win32"]) {
      Object.defineProperty(process, "platform", { ...descriptor, value: platform });
      const count = platform === "darwin" ? 50000 : 25000;
      for (const mode of ["realistic", "adversarial"] as const) {
        const r = random(mode === "realistic" ? 0x71c092 : 0x5eed73);
        const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)]!;
        const prefixes = ["{", "-C", "@", "!", "*", "+", "a.", "(", "#", "-I", "“", "\u200b", "…"];
        const delims = [...":;&|><=,()[]{}\"'`", " ", "\t", "\n", "\u00a0", "\u3000"];
        const prose = ["review", "then", "compare", "naïve", "日本語", "🙂ok", "docs/x/y", "./src/index.ts", "../a/b", "./日本/x", "a-b", "x.y", "C", "file", "https", "~", "…", "100%"];
        const segments = ["src", "Private Docs", "My Secret Folder", "a  b", "x y z", "a", "b", "proj ect", "x.ts", "ü", "日本", "deep", "c"];
        for (let i = 0; i < count; i++) {
          const rootHomes = ["/", "", "C:", "C:\\\\", "C:/", "//"];
          const configured = pick([home, "/PrivacyRootQ7/SeatQ7", "/PrivacyRootQ7/Hôme UserQ7", ...rootHomes]);
          const dotPrefix = pick(["", "./", "discarded/../", "../../"]);
          const markers: string[] = [];
          let pathNumber = 0;
          const segs = (n: number) => {
            const path = Array.from({ length: n + Math.floor(r() * 3) }, () => pick(segments)).concat("tail");
            const number = pathNumber++;
            return path.map((segment, index) => {
              if (index >= path.length - 2) return segment;
              const marker = `Hidden${i.toString(36)}q${number}q${index}`;
              markers.push(marker);
              return segment + marker;
            });
          };
          const piece = (j: number) => {
            const marker = `Root${i.toString(36)}q${j}`;
            const outside = (path: string) => { markers.push(marker); return path; };
            const sep = pick(["/", "\\"]);
            switch (Math.floor(r() * 12)) {
              case 0: case 1: return pick(prose);
              case 2: return configured + "/" + dotPrefix.replaceAll("/", sep) + segs(1).join(sep);
              case 3: return outside("/" + dotPrefix + marker + "/" + segs(2).join("/"));
              case 4: return outside(pick(["C:", "d:", "C:/", "Z:"]) + sep + dotPrefix.replaceAll("/", sep) + marker + sep + segs(2).join(sep));
              case 5: return outside("\\\\" + marker + "\\share\\" + segs(1).join("\\"));
              case 6: return outside(pick(["file://", "FILE://", "vscode://file", "file:", "cursor://file"]) + "/" + marker + "/" + segs(2).join("/"));
              case 7: return pick(["https://host", "http://h.example:8080", "git+ssh://git@h", "vscode://file", "file://"]) + pick(homeForms(configured)) + "/" + segs(1).join("/");
              case 8: return outside(pick(["file:///", "vscode://file/", "file://"]) + pick(["C:/", "c:\\"]) + marker + "/" + segs(2).join("/"));
              case 9: return "~" + configured + "/" + segs(1).join("/");
              case 10: return outside(pick(["C://", "c://"]) + marker + "/" + segs(2).join("/"));
              default: return "prefix" + pick(homeForms(configured));
            }
          };
          let label = "";
          const count = 1 + Math.floor(r() * 4);
          for (let j = 0; j < count; j++) {
            const joiner = mode === "adversarial" ? pick([...delims, ...prefixes, " then "]) : pick(delims) + (r() < 0.3 ? pick(prefixes) : "");
            label += joiner + piece(j);
          }
          // Shrinking lead paths expose partial homes and surrogate boundaries
        // at the input cap. These are independent of the tokenizer's offsets.
        const rootHome = rootHomes.includes(configured);
        if (!rootHome && r() < 0.07) {
          const form = pick(homeForms(configured));
          const cut = 1 + Math.floor(r() * (form.length + 3));
          const marker = `CapHidden${i.toString(36)}`;
          markers.push(marker);
          const lead = "/" + marker + "/" + "a/".repeat(1950);
          const joiner = pick([" ", ";", "=", "/", "\t"]);
          const fill = "b".repeat(4096 - lead.length - joiner.length - cut);
          label = lead + fill + joiner + form + "/x/y";
          if (r() < 0.2) label = label.slice(0, 4095) + "🙂" + label.slice(4095);
        }
        const result = dashboardLabel("runName", label, configured)!;
          const found = labelLeaks(result, rootHome ? [home] : [configured, home], markers, label);
        if ([...result].length > 160) found.push("over 160 code points");
        if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(result)) found.push("lone surrogate");
        if (rootHome && !label.includes("~") && result.includes("~")) found.push("root home mapped");
        if ([...result].length === 160) for (const marker of markers) {
          for (let length = 3; length < marker.length; length++) if (result.endsWith(marker.slice(0, length))) found.push("hidden marker cut by clamp");
        }
        if (label.length > 4096) for (const form of homeForms(configured)) {
          const folded = platform === "linux" ? result : result.toLowerCase();
          const spelling = platform === "linux" ? form : form.toLowerCase();
          for (let length = 8; length < spelling.length; length++) if (folded.endsWith(spelling.slice(0, length))) found.push("cap-cut home prefix");
        }
          // Literal relative prose may contain ..; abbreviated/redacted paths may not.
          if (/[~…]\/(?:[^/\\]*[/\\])?\.\.(?:[/\\]|(?=\s|$))/.test(result)) found.push("redacted parent segment");
          if (found.length) { leaks++; if (examples.length < 6) examples.push(`${label} -> ${result}: ${found.join(", ")}`); }
        }
      }
    }
  } finally { Object.defineProperty(process, "platform", descriptor); }
  const elapsed = performance.now() - start;
  console.info(`seeded fuzzer: 200000 labels (100000 darwin, 50000 linux, 50000 win32), leaks found: ${leaks}, ${elapsed.toFixed(1)} ms`);
  expect(examples).toEqual([]);
  expect(leaks).toBe(0);
  // The separate adversarial tokenizer test pins bounded runtime. Shared-host
  // fuzzer timing is evidence, not a scheduling-sensitive correctness assertion.
  // About 10 s on a developer machine; CI runners are several times slower.
}, 180_000);
