import { afterEach, expect, it, vi } from "vitest";
import { dashboardLabel } from "../dashboard-identities.js";

const home = "/Users/someuser";
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

// Exact-spelling home matching leaves private segments in the displayed suffix.
it.each([
  "/Users//someuser/x", String.raw`/Users\someuser/x`,
  "/Users/./someuser/x", "/Users/junk/../someuser/x",
  "/srv/secret/Users/someuser/x", "/srv/x/../../Users/someuser/x",
  "cp /srv/a /Users/./someuser/x", "cp /srv/a /Users/junk/../someuser/x",
])("canonical home segments hide every preceding segment: %s", input => {
  vi.stubEnv("HOME", home);
  const output = dashboardLabel("role", input, home)!;
  expect(output.endsWith("~/x")).toBe(true);
  for (const segment of ["Users", "someuser", "secret", "junk"]) expect(output).not.toContain(segment);
});
it.each(["role", "project", "repo"] as const)("mapped roots retain absoluteness for bare embedded homes in %s", field => {
  vi.stubEnv("HOME", home);
  expect(dashboardLabel(field, `/srv${home}`, home)).toBe("~");
  expect(dashboardLabel(field, `/srv/secret${home}`, home)).toBe("~");
  expect(dashboardLabel(field, `/srv${home}/x`, home)).toBe("~/x");
});
it("an embedded home also resets a path that already began at home", () => {
  vi.stubEnv("HOME", home);
  expect(dashboardLabel("role", `${home}/private${home}/x`, home)).toBe("~/x");
});
it.each([String.raw`\\?\C:\Users\Some User\x`, String.raw`\\.\C:\Users\Some User\x`,
  String.raw`C:/Users\Some User/x`, String.raw`C:\Users\\Some User\x`,
  "/c/Users/Some User/x", "/cygdrive/c/Users/Some User/x",
  "C:/junk/../Users/Some User/x", "/c/junk/../Users/Some User/x", "/cygdrive/c/junk/../Users/Some User/x"])("canonical drive home: %s", input => {
  const base = String.raw`C:\Users\Some User`;
  vi.stubEnv("HOME", base);
  expect(dashboardLabel("role", input, base)).toBe("~/x");
});
it.each([
  ["/HzSynthQ5/HzHome DirQ5", "/HzSynthQ5/HzHome DirQ5-old", "…/HzHome DirQ5-old"],
  ["/HzRootQ5/HzParentQ5/HzSeatQ5", "/HzRootQ5/./HzParentQ5/HzSeatQ5_old", "…/HzSeatQ5_old"],
  [String.raw`C:\HzUsersQ5\Hz Some UserQ5`, String.raw`C:\HzUsersQ5\Hz Some UserQ5foo`, "…/Hz Some UserQ5foo"],
])("a sibling name may survive but its canonical home parents may not: %s", (base, input, expected) => {
  vi.stubEnv("HOME", base);
  expect(dashboardLabel("role", input, base)).toBe(expected);
});
it.each(["darwin", "win32", "linux"])("canonical segment casing on %s", platform => {
  vi.stubEnv("HOME", home);
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: platform });
    expect(dashboardLabel("role", "/USERS//SOMEUSER/x", home)).toBe(platform === "linux" ? "…/SOMEUSER/x" : "~/x");
  } finally { Object.defineProperty(process, "platform", descriptor); }
});

// A word list cannot distinguish prose from words inside a private segment.
it.each(["/srv/Projects/Q3 Compare Results/data/file.csv", "/srv/Root/My then Folder/data/file.csv",
  "/Users/someuser/Q3 Compare Results/data/file.csv", String.raw`\\srv\share\Q3 Compare Results\data\file.csv`])(
  "connectives do not expose hidden path segments: %s", input => {
    vi.stubEnv("HOME", home);
    expect(dashboardLabel("role", input, home)).toBe(input.startsWith(home) ? "~/data/file.csv" : "…/data/file.csv");
  });
it.each([
  ["edit /srv/a/b/c.ts, run ../tools/x.sh", "edit …/b/c.ts, run ../tools/x.sh"],
  ["ls /srv/a/b and ./src/x.ts", "ls …/a/b and ./src/x.ts"],
  [String.raw`ls /srv/a/b and .\src\x.ts`, String.raw`ls …/a/b and .\src\x.ts`],
  [String.raw`ls /srv/a/b and ..\src\x.ts`, String.raw`ls …/a/b and ..\src\x.ts`],
  ["edit /srv/a/b; run docs/x/y", "edit …/a/b; run docs/x/y"],
])("explicit relatives and sentence punctuation stop continuation: %s", (input, expected) => {
  vi.stubEnv("HOME", home);
  expect(dashboardLabel("role", input, home)).toBe(expected);
});
it.each(["w/o the fix, I/O is slow", "1/2 of the I/O budget", "A/B test then 24/7 rollout",
  "and/or n/a", "/srv/a/b prose w/o the fix", "/srv/Root/My w/o Folder/a/b/c"])(
  "slash abbreviations do not independently start or continue paths: %s", input => {
    vi.stubEnv("HOME", home);
    const expected = input.startsWith("/srv/Root/") ? "…/b/c" : input.startsWith("/srv/a/b") ? "…/b prose w/o the fix" : input;
    expect(dashboardLabel("role", input, home)).toBe(expected);
  });
it.each(["x.yC://Private/x/y/z", "x--flagC://Private/x/y/z", "a+bC://Private Docs/x/y/z",
  "git+sshC://Private/x/y/z", "xD://Private.v2/x/y/z", "docsZ://secret.d/x/y/z",
  "a.ssh://Private/x/y/z", "secret.https://Private/x/y/z", "a.file://Private/x/y/z",
  "wordD:/Private/x/y/z", String.raw`wordZ:\Private\x\y\z`])("glued single-letter drives are paths: %s", input => {
  vi.stubEnv("HOME", home);
  expect(dashboardLabel("role", input, home)).toBe("…/y/z");
});
it("replaces every occurrence of the same encoded home form", () => {
  vi.stubEnv("HOME", home);
  const output = dashboardLabel("role", "q=%2FUsers%2Fsomeuser&x=%2FUsers%2Fsomeuser&z=%2FUsers%2Fsomeuser", home)!;
  expect(output).not.toContain("Users");
  expect(output).not.toContain("someuser");
});
it("overlapping encoded home forms use the complete configured root", () => {
  vi.stubEnv("HOME", "/var/root");
  expect(dashboardLabel("role", "prefix%2Fprivate%2Fvar%2Froot", "/private/var/root")).toBe("prefix~");
});
it.each(["/c/Users//", "/cygdrive/c/Users//"])("the input cap protects canonical drive HOME prefixes: %s", prefix => {
  const windowsHome = String.raw`C:\Users\someuser`;
  vi.stubEnv("HOME", windowsHome);
  const padding = ("/" + "a/".repeat(3000)).slice(0, 4096 - prefix.length);
  const output = dashboardLabel("role", padding + prefix + "someuser/x", windowsHome)!;
  expect(output).not.toContain("Users");
  expect(output).not.toContain("someuser");
  expect(output.endsWith("~…")).toBe(true);
});
it("canonical configured drive aliases recognize namespace casing", () => {
  const aliasHome = "/CYGDRIVE/C/Users/someuser";
  vi.stubEnv("HOME", aliasHome);
  expect(dashboardLabel("role", "C:/Users/someuser/x", aliasHome)).toBe("~/x");
});
it("encoded canonical drive aliases use the same HOME-form cache", () => {
  const windowsHome = String.raw`C:\Users\someuser`;
  vi.stubEnv("HOME", windowsHome);
  expect(dashboardLabel("role", "q=%2Fc%2FUsers%2Fsomeuser", windowsHome)).toBe("q=~");
});
it("trims a raw home slash before generating URL-encoded forms", () => {
  vi.stubEnv("HOME", "/synthetic/home dir/");
  expect(dashboardLabel("role", "q=%2Fsynthetic%2Fhome%20dir%2Fx", "/unrelated/home")).toBe("q=~%2Fx");
  expect(dashboardLabel("role", "file:///synthetic/home%20dir/x", "/unrelated/home")).toBe("file://~/x");
});

it("a parent token before a spaced continuation still resolves traversal", () => {
  vi.stubEnv("HOME", home);
  const output = dashboardLabel("role", `${home}/junk/.. '${home}/x`, home)!;
  expect(output).not.toMatch(/[~…][\/](?:[^/\\\s]*[\/])?\.\.(?:[\/]|\s|$)/);
  expect(output).not.toContain("junk");
});
it("literal NULs and unrelated tildes are not home markers", () => {
  vi.stubEnv("HOME", home);
  expect(dashboardLabel("role", "plain\0notes", home)).toBe("plain\0notes");
  expect(dashboardLabel("role", "/srv/a/src+prefix~", home)).toBe("…/a/src+prefix~");
});

it("a mapped home resets an explicit relative context even before punctuation", () => {
  const base = "/synthetic/hôme ü";
  vi.stubEnv("HOME", base);
  const input = `./src/x\"prefix${encodeURIComponent(base)}'prefix${base}` + String.raw`🙂\Private\middle\a\b`;
  const output = dashboardLabel("role", input, base)!;
  expect(output).not.toContain("Private");
  expect(output).not.toContain("middle");
});
it("short slash tokens inside a multi-word path do not expose its hidden middle", () => {
  vi.stubEnv("HOME", home);
  expect(dashboardLabel("role", "/srv/private/middle/x y z/a", home)).toBe("…/x y z/a");
});

// Repeated whole-input home searches become superlinear if the form count or
// a per-character lookahead grows with input. Medians and paired measurements
// tolerate ambient load; this is a scaling guard, not an absolute time limit.
it("expanding Unicode folds scale linearly when input doubles", () => {
  const base = "/HzSynthQ5/Hzôme ÜQ5";
  vi.stubEnv("HOME", base.normalize("NFD") + "/");
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "darwin" });
    const small = "İ".repeat(2048), large = "İ".repeat(4096);
    for (let i = 0; i < 30; i++) { dashboardLabel("role", small, base); dashboardLabel("role", large, base); }
    const measure = (input: string) => {
      const start = performance.now();
      for (let i = 0; i < 40; i++) dashboardLabel("role", input, base);
      return performance.now() - start;
    };
    const ratios = Array.from({ length: 7 }, (_, i) => {
      if (i % 2) { const big = measure(large); return big / measure(small); }
      const little = measure(small); return measure(large) / little;
    }).sort((a, b) => a - b);
    console.info(`expanding-fold doubling ratios: ${ratios.map(r => r.toFixed(3)).join(", ")}`);
    expect(ratios[3]).toBeLessThan(3);
  } finally { Object.defineProperty(process, "platform", descriptor); }
});
