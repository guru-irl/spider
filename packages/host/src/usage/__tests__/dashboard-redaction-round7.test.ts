import { afterEach, expect, it, vi } from "vitest";
import { dashboardLabel } from "../dashboard-identities.js";

const home = "/Users/someuser";
const windowsHome = String.raw`C:\Users\Some User`;
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const onPlatform = (platform: string, test: () => void) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: platform });
    test();
  } finally { Object.defineProperty(process, "platform", descriptor); }
};

// A later home's source range must never include earlier tokens or punctuation.
it.each([
  ['cd /srv/a/b/c then cd "/Users/someuser"', 'cd …/b/c then cd "~"'],
  ["copy /srv/a/b/c.txt to '/Users/someuser'", "copy …/b/c.txt to '~'"],
  ["copy /srv/a/b/c.txt to `/Users/someuser`", "copy …/b/c.txt to `~`"],
  ["ls /srv/a/b/c [/Users/someuser]", "ls …/b/c [~]"],
  ["diff /srv/a/b.txt /Users/someuser/", "diff …/a/b.txt ~/"],
  ["/srv/a/b into (/Volumes/Bk/Users/someuser)", "…/a/b into (~)"],
  ["PATH=/usr/local/bin:/Users/someuser", "PATH=…/local/bin:~"],
  ["/srv/a/b,/Users/someuser", "…/a/b,~"],
])("preserves earlier text before a wrapped or glued bare home: %s", (input, expected) => {
  vi.stubEnv("HOME", home);
  expect(dashboardLabel("role", input, home)).toBe(expected);
});
it("keeps shell substitution and a quoted Windows bare home separate", () => {
  vi.stubEnv("HOME", "/home/someuser");
  expect(dashboardLabel("role", "cd /srv/a/b and $(/home/someuser)", "/home/someuser")).toBe("cd …/a/b and $(~)");
  onPlatform("win32", () => {
    vi.stubEnv("HOME", windowsHome);
    expect(dashboardLabel("role", String.raw`copy D:\data\a\b.txt "C:\Users\Some User"`, windowsHome)).toBe('copy …/a/b.txt "~"');
  });
});

// Removing compact-flag starts or expanding tilde would expose a container home.
it.each([
  ["gcc -I/root/inc -o x", "gcc -I~/inc -o x"],
  ["gcc -I/root -o x", "gcc -I~ -o x"],
  ["tar -C/root/x -xf a.tar", "tar -C~/x -xf a.tar"],
  ["q=%2Froot%2Fx -I%2Froot%2Fx", "q=~%2Fx -I~%2Fx"],
  ["gcc -I~/src/../include -o x", "gcc -I~/include -o x"],
  ["see file:///root/x/..", "see file://~/"],
  ["see https://h/a/b /root/x/..", "see https://h…/a/b ~/"],
  ["-I/./root/inc", "-I~/inc"],
  ["//root", "~"],
  ["/srv/a/b to /srv/../root", "…/a/b to ~"],
  ["prefix\\root", "prefix\\root"],
  ["/var/lib/root/data/a.txt", "…/data/a.txt"],
])("maps a one-segment home only at an effective path start: %s", (input, expected) => onPlatform("linux", () => {
  vi.stubEnv("HOME", "/root");
  expect(dashboardLabel("role", input, "/root")).toBe(expected);
}));
it.each(["-I/c/root", "-C/mnt/d/root", "-I/cygdrive/e/root"])('recognizes a compact Windows alias: %s', input => onPlatform("win32", () => {
  vi.stubEnv("HOME", String.raw`C:\root`);
  expect(dashboardLabel("role", input, String.raw`C:\root`)).toBe(input.slice(0, 2) + "~");
}));
it("a word-glued alias is not an effective one-segment root", () => onPlatform("win32", () => {
  vi.stubEnv("HOME", String.raw`C:\root`);
  expect(dashboardLabel("role", "prefix/mnt/d/root/x", String.raw`C:\root`)).toBe("prefix…/root/x");
}));

// The relative prefix is part of the matched path, not dots glued to tilde.
it.each(["../../Users/someuser/x.ts", "./a/../Users/someuser/x.ts", ".%2FUsers%2Fsomeuser/x.ts"])('renders relative home roots without dot-tilde glue: %s', input => {
  vi.stubEnv("HOME", home);
  expect(dashboardLabel("role", input, home)).toBe("…/x.ts");
});
it("handles multiple home depths independently at relative roots", () => onPlatform("win32", () => {
  vi.stubEnv("HOME", String.raw`C:\root`);
  const output = dashboardLabel("role", String.raw`a\Users\Some User:.\root\x`, windowsHome)!;
  expect(output).not.toContain("root");
  expect(output).not.toContain("Users");
  expect(output).not.toContain("Some User");
  expect(output).not.toMatch(/\.~|\.\.~/);
}));
it.each([String.raw`..\..\Users\Some User\x.ts`, String.raw`..\..\Users\Some User`])('handles relative Windows marker chains: %s', input => onPlatform("win32", () => {
  vi.stubEnv("HOME", windowsHome);
  expect(dashboardLabel("role", input, windowsHome)).toBe(input.endsWith("x.ts") ? "…/x.ts" : "…/");
}));

// Decode for matching, not rendering, across drives and UNC file authorities.
it.each([
  "file:///D:/Users/Some%20User/x", "file://server/share/Users/Some%20User/x",
  "file:///E:/Users/Some+User/x", "file://server/share/Users/Some%20User/./x",
])('hides encoded file URL home segments: %s', input => onPlatform("win32", () => {
  vi.stubEnv("HOME", windowsHome);
  const output = dashboardLabel("role", input, windowsHome)!;
  expect(output).not.toMatch(/Users|Some|User/i);
  expect(output.endsWith("~/x")).toBe(true);
}));
it("hides every mid-path home occurrence without reusing an old drive root", () => onPlatform("win32", () => {
  vi.stubEnv("HOME", windowsHome);
  expect(dashboardLabel("role", String.raw`C:\Users\Some User\x\Users\Some User\y`, windowsHome)).toBe("~/y");
}));
it("preserves compact lowercase drive flags and glued bare-home boundaries", () => onPlatform("win32", () => {
  vi.stubEnv("HOME", windowsHome);
  expect(dashboardLabel("role", String.raw`copy D:\data\a\b.txt into -Ic:\users\some user`, windowsHome)).toBe("copy …/a/b.txt into -I~");
}));
it("keeps encoded non-root one-segment names as ordinary path tails", () => onPlatform("linux", () => {
  vi.stubEnv("HOME", "/root dir");
  expect(dashboardLabel("role", "../a/bprefix/root%20dir@c://private/a/b", "/root dir")).toBe("../a/bprefix…/a/b");
}));
it("does not reinterpret a one-segment name after ellipsis as a home root", () => {
  vi.stubEnv("HOME", "/root");
  expect(dashboardLabel("role", "…/root/x", "/root")).not.toContain("~");
});
it("bounds relative marker scanning without changing relative text", () => {
  const input = "../".repeat(1365);
  vi.stubEnv("HOME", home);
  const times = Array.from({ length: 5 }, () => {
    const start = performance.now();
    expect(dashboardLabel("role", input, home)).toBe(input.slice(0, 160));
    return performance.now() - start;
  }).sort((a, b) => a - b);
  expect(times[2]).toBeLessThan(50);
});
it("resets the canonical stack at a punctuation-rooted one-segment home", () => onPlatform("linux", () => {
  vi.stubEnv("HOME", "/root");
  expect(dashboardLabel("role", "/srv/a:/./root", "/root")).toBe("…/srv/a:~");
  expect(dashboardLabel("role", "/srv/a,/./root", "/root")).toBe("…/srv/a,~");
}));
it("the literal home pass consumes a relative marker before a literal plus", () => {
  const base = "/synthetic/first+last";
  vi.stubEnv("HOME", base);
  expect(dashboardLabel("role", "./synthetic/first+last/x", base)).toBe("…/x");
});
it("literal substitutions carry earlier roots and refresh differently spelled home offsets", () => {
  const base = "/synthetic/first+last", raw = "/other/raw";
  vi.stubEnv("HOME", raw);
  expect(dashboardLabel("role", `cd /srv/a/b to ${raw} then /outside/x/y q=${base}`, base)).toBe("cd …/a/b to ~ then …/x/y q=~");
  vi.stubEnv("HOME", "/other/raw+last");
  expect(dashboardLabel("role", `q=${base}&x=/other/raw+last`, base)).toBe("q=~&x=~");
  expect(dashboardLabel("role", `q=${base} alpha x=/other/raw+last omega`, base)).toBe("q=~ alpha x=~ omega");
});
it("matches fully encoded first points without losing Unicode source offsets", () => {
  const base = "/İstanbul/hôme ü";
  vi.stubEnv("HOME", base);
  for (const platform of ["linux", "darwin", "win32"]) onPlatform(platform, () => {
    for (const spelling of [base.normalize("NFC"), base.normalize("NFD")]) {
      const encoded = [...Buffer.from(spelling)].map(byte => "%" + byte.toString(16).padStart(2, "0")).join("");
      expect(dashboardLabel("role", "x=" + encoded + "/x", base)).toBe("x=~/x");
    }
  });
});
it("keeps tilde while truncating deep tails, never expands it", () => {
  vi.stubEnv("HOME", home);
  expect(dashboardLabel("role", "~/private/deep/a/b", home)).toBe("~/a/b");
  expect(dashboardLabel("role", "-I~/a/../b/c/d", home)).toBe("-I~/c/d");
});
