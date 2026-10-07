import { afterEach, expect, it, vi } from "vitest";
import { dashboardLabel } from "../dashboard-identities.js";
import { homeSegmentLeaks, labelLeaks } from "./fixtures/label-privacy.js";

const home = "/synthetic/home dir";
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

// Truncating a merged path before replacing home exposes its last segment.
it.each([
  `cp /srv/a ${home}/b`, `--from=/srv/x --to=${home}/b`,
  `sync /data/a/b ${home}/Downloads`, `${home}/a ${home}/b`,
  `PATH=/usr/local/bin:${home}/bin`, `/outside/a;${home}/b`,
])("maps homes before any path suffix is chosen: %s", input => {
  vi.stubEnv("HOME", home);
  const output = dashboardLabel("role", input, home)!;
  expect(labelLeaks(output, [home], [], input)).toEqual([]);
  expect(output).toContain("~");
});

it("the output clamp does not censor words from an unrelated path", () => {
  vi.stubEnv("HOME", home);
  const input = "/outside/" + "x".repeat(149) + "/home dir-extended";
  for (const field of ["role", "project"] as const) {
    const output = dashboardLabel(field, input, home)!;
    expect(output.endsWith("/home dir")).toBe(true);
    expect(labelLeaks(output, [home], [], input)).toEqual([]);
  }
});
it("Windows home spellings remain case-insensitive on a Linux host", () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
    const base = String.raw`c:\users\seat`;
    vi.stubEnv("HOME", base);
    expect(dashboardLabel("role", String.raw`prefixC:\USERS\SEAT\x`, base)).toBe("prefix~/x");
  } finally { Object.defineProperty(process, "platform", descriptor); }
});

it("protects encoded home segments even when a cap cuts before eight units", () => {
  const configured = "/home/first.last";
  vi.stubEnv("HOME", configured);
  const lead = "/" + "a/".repeat(2040);
  const partial = "%2Fhome";
  const input = lead + "b".repeat(4096 - lead.length - 1 - partial.length) + ";" + encodeURIComponent(configured) + "/x";
  expect(labelLeaks(dashboardLabel("role", input, configured)!, [configured], [], input)).toEqual([]);
});
it("an encoded home glued to a scheme is mapped before ambiguous path detection", () => {
  const configured = "/synthetic/hôme ü";
  vi.stubEnv("HOME", configured);
  const form = encodeURIComponent(configured.replaceAll("/", "\\"));
  const input = "prefix" + form + "abcfile:///C:/Private/a/b/c";
  expect(labelLeaks(dashboardLabel("role", input, configured)!, [configured], [], input)).toEqual([]);
});
it("form spaces in an unrelated path do not make its words private", () => {
  const configured = "/synthetic/src/user";
  vi.stubEnv("HOME", configured);
  const input = "/srv/a/src+prefix~";
  expect(dashboardLabel("role", input, configured)).toBe("…/a/src+prefix~");
  expect(labelLeaks(dashboardLabel("role", input, configured)!, [configured], [], input)).toEqual([]);
});

it("trims trailing separators on configured and raw homes", () => {
  for (const raw of [home + "/", home + "///", home.replaceAll("/", "\\") + "\\"]) {
    vi.stubEnv("HOME", raw);
    expect(dashboardLabel("role", `see ${home}/x/y`, home + "/")).toBe("see ~/x/y");
  }
});

// The non-absolute project branch used to bypass both home and URL handling.
it.each(["project", "repo"] as const)("protects homes and URLs in non-absolute %s labels", field => {
  vi.stubEnv("HOME", home);
  expect(dashboardLabel(field, `foo ${home}/x`, home)).toBe("foo ~/x");
  expect(dashboardLabel(field, `file://${home}/repo`, home)).toBe("file://~/repo");
  expect(dashboardLabel(field, "https://host/private/a/b/c", home)).toBe("https://host…/b/c");
  for (const input of ["owner/repo/branch/extra", "a/b/c/d", "../a/b/c", String.raw`..\a\b\c`]) {
    expect(dashboardLabel(field, input, home)).toBe(input);
  }
});

it.each(["linux", "darwin", "win32"])("matches mixed percent hex, form spaces and Unicode on %s", platform => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: platform });
    const base = "/synthetic/hôme ü";
    vi.stubEnv("HOME", base);
    for (const spelling of [base.normalize("NFC"), base.normalize("NFD")]) {
      const encoded = encodeURIComponent(spelling);
      for (const form of [spelling, encoded, encoded.replace(/%[0-9A-F]{2}/g, s => s.toLowerCase()),
        encoded.replace(/%20/g, "+"), encoded.replace(/%2F/g, "%2f")]) {
        expect(dashboardLabel("role", "prefix" + form, base)).toBe("prefix~");
        expect(labelLeaks(dashboardLabel("project", "foo " + form + "/x", base)!, [base])).toEqual([]);
      }
    }
  } finally { Object.defineProperty(process, "platform", descriptor); }
});

it("a percent prefix cannot change the case of a Windows home match", () => {
  const base = String.raw`C:\Users\Some User`;
  vi.stubEnv("HOME", base);
  for (const form of [encodeURI(base), encodeURIComponent(base), encodeURIComponent(base.replaceAll("\\", "/"))]) {
    expect(dashboardLabel("role", "%" + form, base)).toBe("%~");
  }
});

// Separator-free words within a segment must not expose the preceding middle.
it.each([
  ["/srv/Root/My Secret Folder/a/b/c", "…/b/c"],
  [String.raw`D:\Shares\Finance Team Q3\Payroll\Employees\list.xlsx`, "…/Employees/list.xlsx"],
  ["/srv/Root/a  b/a/b/c", "…/b/c"],
  ["/srv/Root/My Secret Folder/a/b/c prose after final", "…/b/c prose after final"],
  ["Review /srv/a/b/c then compare docs/x/y", "Review …/x/y"],
  ["/srv/a/b/c prose /other/x/y", "…/b/c prose …/x/y"],
  ["/srv/a/b/c prose https://host/x/y", "…/b/c prose https://host…/x/y"],
])("bridges multi-word segments without consuming trailing prose: %s", (input, expected) => {
  expect(dashboardLabel("role", input, home)).toBe(expected);
});

// The reviewer's four-segment limit, shortest-first and bare-drive mutants.
it("redacts a four-segment word-glued path", () => {
  expect(dashboardLabel("role", "docs/a/b/c", home)).toBe("docs…/b/c");
});
it("replaces overlapping home forms longest first", () => {
  vi.stubEnv("HOME", "/var/root");
  expect(dashboardLabel("role", "prefix/private/var/root", "/private/var/root")).toBe("prefix~");
});
it("does not map bare drive homes", () => {
  vi.stubEnv("HOME", "C:");
  expect(dashboardLabel("role", "q=C:literal", home)).toBe("q=C:literal");
  expect(dashboardLabel("project", "/private/team/project", "C:")).toBe("…/team/project");
});

it.each(["xC://Private/a/b/c", "abcC://Private Docs/a/b/c", "wordC://Private Secret Folder/a/b/c", "abcd://Client Plans 2026/a/b/c", "prefixC://{../a/b]c://Private/a/b/c"])(
  "treats glued drive and URL ambiguity as a path: %s", input => {
    const result = dashboardLabel("role", input, home)!;
    expect(result).toBe("…/b/c");
    expect(result).not.toContain("Private");
  });

it.each([String.raw`..\a\b\c`, String.raw`.\src\x\y`, String.raw`see ..\a\b\c now`])(
  "keeps relative backslash paths literal: %s", input => {
    expect(dashboardLabel("role", input, home)).toBe(input);
  });
it("does not duplicate a literal tilde home marker", () => {
  expect(dashboardLabel("role", "~/synthetic/home dir/a", home)).toBe("~/a");
});
it.each(["project", "repo", "role"] as const)("resolves tilde traversal outside the home for %s", field => {
  expect(dashboardLabel(field, "~/../bob", "/synthetic/home")).toBe("…/bob");
  expect(dashboardLabel(field, "~/a/../../bob", "/synthetic/home")).toBe("…/bob");
});

it("refreshes home spellings when the raw home changes", () => {
  vi.stubEnv("HOME", "/volatile/home one");
  expect(dashboardLabel("role", "prefix/volatile/home one", home)).toBe("prefix~");
  vi.stubEnv("HOME", "/volatile/home two");
  expect(dashboardLabel("role", "prefix/volatile/home two", home)).toBe("prefix~");
});
it("a cap-cut home cannot continue a preceding dot-normalized path", () => {
  const lead = "/srv/" + "a/".repeat(2000) + "b/..";
  const partial = "/synthetic/ho";
  const input = lead + " ".repeat(4096 - lead.length - partial.length) + home + "/x";
  const result = dashboardLabel("role", input, home)!;
  expect(result.startsWith("…/a/a ")).toBe(true);
  expect(result.endsWith("~…")).toBe(true);
  expect(result).not.toContain("..");
});

it("uses the longest partial home when cap-tail forms overlap", () => {
  vi.stubEnv("HOME", "/long-c/long-d/suffix");
  const configured = "/long-a/long-b/long-c/long-d/other";
  const lead = "/srv/" + "a/".repeat(2000) + "b/..";
  const partial = "/long-a/long-b/long-c/long-d/";
  const spaces = " ".repeat(4096 - lead.length - partial.length);
  expect(dashboardLabel("role", lead + spaces + configured + "/x", configured)).toBe("…/a/a" + spaces + "~…");
});

it("benign prose without paths has zero redaction", () => {
  vi.stubEnv("HOME", home);
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const words = ["review", "compare", "ready", "plain", "notes", "naïve", "日本語", "🙂ok", "100%", "a-b", "x.y", "~", "C", "https", "synthetic", "home dir", "src"];
  const punctuation = [" ", " then ", ": ", "; ", ", ", "! ", " (", " [", "\t", "\n"];
  let changed = 0;
  try {
    for (const platform of ["darwin", "linux", "win32"]) {
      Object.defineProperty(process, "platform", { ...descriptor, value: platform });
      let seed = 0x97f423;
      const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
      for (let i = 0; i < 20000; i++) {
        const label = Array.from({ length: 1 + random() % 8 }, () => words[random() % words.length] + punctuation[random() % punctuation.length]).join("");
        if (dashboardLabel(i % 2 ? "project" : "role", label, home) !== label) changed++;
      }
    }
  } finally { Object.defineProperty(process, "platform", descriptor); }
  console.info(`benign-prose fuzzer: 60000 labels, redacted ${changed}, rate ${(changed / 60000 * 100).toFixed(3)}%`);
  expect(changed).toBe(0);
});

it("keeps unrelated path segments and prose that share words with home", () => {
  expect(dashboardLabel("role", "/srv/synthetic/x", home)).toBe("…/synthetic/x");
  expect(dashboardLabel("project", "/repo/home dir/x", home)).toBe("…/home dir/x");
  expect(dashboardLabel("role", "synthetic notes about home dir", home)).toBe("synthetic notes about home dir");
  expect(dashboardLabel("role", "~/synthetic/x", home)).toBe("~/synthetic/x");
});
it("the positional oracle catches prefix leaks but allows unrelated and relative-tail words", () => {
  for (const output of ["…/synthetic/x", "…/home dir/x", "…%2fhome+dir%2fx", "…/hôme ü/x"]) {
    expect(homeSegmentLeaks(output, [home, "/synthetic/hôme ü"], `${home}/a /synthetic/hôme ü/x`).length).toBeGreaterThan(0);
  }
  expect(homeSegmentLeaks("…/synthetic/x", [home], "/repo/synthetic/x")).toEqual([]);
  expect(homeSegmentLeaks("synthetic notes about home dir", [home], "synthetic notes about home dir")).toEqual([]);
  expect(homeSegmentLeaks("~/synthetic/x", [home], `${home}/synthetic/x`)).toEqual([]);
  expect(homeSegmentLeaks("~/x", [home], `${home}/x`)).toEqual([]);
});
