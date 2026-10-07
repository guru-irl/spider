import { afterEach, expect, it, vi } from "vitest";
import { dashboardLabel } from "../dashboard-identities.js";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const onPlatform = (platform: string, home: string, test: () => void) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: platform });
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    test();
  } finally { Object.defineProperty(process, "platform", descriptor); }
};

it.each([
  [String.raw`run D:\tools\x.exe on C:\Users\X\in.csv now`, "run …/tools/x.exe on ~/in.csv now"],
  [String.raw`copy C:\Users\X\a.txt to C:\Users\X\b.txt`, "copy ~/a.txt to ~/b.txt"],
  [String.raw`open C:\Users\X\proj\a.ts and C:\Users\X\proj\b.ts`, "open ~/proj/a.ts and ~/proj/b.ts"],
  [String.raw`cd C:\Users\X\repo then edit C:\Users\X\repo\a.ts`, "cd ~/repo then edit ~/repo/a.ts"],
  [String.raw`copy "C:\Users\X\a.txt" to "C:\Users\X\b.txt"`, 'copy "~/a.txt" to "~/b.txt"'],
  [String.raw`see D:\Users\X\a.txt and D:\Users\X\b.txt`, "see ~/a.txt and ~/b.txt"],
  [String.raw`C:\Users\X\a <C:\Users\X\b>`, "~/a <~/b>"],
  [String.raw`[C:\Users\X\a] xs,'C:\Users\X'`, "[~/a] xs,'~'"],
  ["see /c/Users/X/a.txt and /c/Users/X/b.txt", "see ~/a.txt and ~/b.txt"],
  [String.raw`see \\srv\share\Users\X\a.txt and \\srv\share\Users\X\b.txt`, "see ~/a.txt and ~/b.txt"],
])("keeps earlier Windows paths and intervening text: %s", (input, expected) => onPlatform("win32", String.raw`C:\Users\X`, () => {
  expect(dashboardLabel("role", input, String.raw`C:\Users\X`)).toBe(expected);
}));
it.each([
  ["darwin", "/Users/someuser", "run /srv/tools/x on /Volumes/Bk/Users/someuser/in.csv now", "run …/tools/x on ~/in.csv now"],
  ["linux", "/home/someuser", "run /srv/tools/x on /mnt/bk/home/someuser/in.csv now", "run …/tools/x on ~/in.csv now"],
  ["linux", "/root", "/srv/a/b/t.txt ok /./root/h/x", "…/b/t.txt ok ~/h/x"],
])("keeps an independent mid-path home on %s", (platform, home, input, expected) => onPlatform(platform, home, () => {
  expect(dashboardLabel("role", input, home)).toBe(expected);
}));
it.each(["cwd:", "word=", 'word:"', 'word,"', "word,", "word:HOME="])("does not bridge an encoded home after %s", prefix => onPlatform("linux", "/home/some user", () => {
  const close = prefix.endsWith('"') ? '"' : "";
  expect(dashboardLabel("role", `-I/home/some user/a ${prefix}%2Fhome%2Fsome%20user%2Fb%2Fc${close}`, "/home/some user"))
    .toBe(`-I~/a ${prefix}~%2Fb%2Fc${close}`);
}));
it.each([
  [String.raw`HOME:\Users\X\x`, "HOME:~/x"],
  [String.raw`USERPROFILE:\Users\X`, "USERPROFILE:~"],
  [String.raw`SRC:\\srv\share\Users\X\x`, "SRC:~/x"],
  ["OUT:/mnt/c/Users/X/x", "OUT:~/x"],
])("keeps a word prefix before a drive-less home: %s", (input, expected) => onPlatform("win32", String.raw`C:\Users\X`, () => {
  expect(dashboardLabel("role", input, String.raw`C:\Users\X`)).toBe(expected);
}));
it.each([
  ["file://server/share/Users/X/x", "file://server~/x"],
  ["file:///Volumes/Backup/Users/X/x", "file://~/x"],
])("does not glue ellipsis to a file URL home: %s", (input, expected) => onPlatform("win32", String.raw`C:\Users\X`, () => {
  expect(dashboardLabel("role", input, String.raw`C:\Users\X`)).toBe(expected);
}));
it.each([
  ['/srv/a/b:"/Users/someuser"', '…/a/b:"~"'],
  ['/srv/a/b:[/Users/someuser]', '…/a/b:[~]'],
  ['{"a":"/srv/x/y","b":"/Users/someuser"}', '{"a":"…/x/y","b":"~"}'],
])("splits quoted or bracketed glued bare homes: %s", (input, expected) => onPlatform("darwin", "/Users/someuser", () => {
  expect(dashboardLabel("role", input, "/Users/someuser")).toBe(expected);
}));
it("keeps the file sentinel outside a compact-flag home substitution", () => onPlatform("linux", "/Users/someuser", () => {
  expect(dashboardLabel("role", "-Ifile:///Users/someuser/x", "/Users/someuser")).toBe("-~/x");
}));
it("decodes a home-named opaque tail for presentation", () => onPlatform("linux", "/Users/someuser", () => {
  expect(dashboardLabel("role", "q=%2FUsers%2Fsomeuser%2FUsers%2Fx", "/Users/someuser")).toBe("q=~/Users/x");
}));
it.each(["a.~/Mac HD/ü-I/HzOneQ5/.", "--prefix=/srv/share/ü-I/HzOneQ5/junk/.."])("hides a one-segment home after a glued compact flag: %s", input => onPlatform("darwin", "/HzOneQ5", () => {
  expect(dashboardLabel("role", input, "/HzOneQ5")).not.toContain("HzOneQ5");
}));
it("normalizes a literal backslash tilde root", () => {
  expect(dashboardLabel("role", String.raw`see ~\x`, "/Users/someuser")).toBe("see ~/x");
});
it("preserves both query home substitutions", () => onPlatform("linux", "/synthetic/first+last", () => {
  vi.stubEnv("HOME", "/other/raw+last");
  expect(dashboardLabel("role", "q=/synthetic/first+last&x=/other/raw+last", "/synthetic/first+last")).toBe("q=~&x=~");
}));
it("does not bridge backward out of a wrapped bare home", () => onPlatform("linux", "/root", () => {
  expect(dashboardLabel("role", "[/root] /root/a/b", "/root")).toBe("[~] ~/a/b");
}));
it("carries a quoted literal home root across later substitutions", () => onPlatform("linux", "/other/raw+last", () => {
  expect(dashboardLabel("role", '/srv/a/b:"/synthetic/first+last":q=/other/raw+last', "/synthetic/first+last"))
    .toBe('…/a/b:"~":q=~');
}));
it("resets an outside bridge at a later mapped home", () => onPlatform("linux", "/home/u", () => {
  expect(dashboardLabel("role", "/tmp/build/out/a /var/log/b/c:/home/u/h/x", "/home/u")).toBe("~/h/x");
}));
it.each([0xa0, 0x1680, ...Array.from({ length: 11 }, (_, i) => 0x2000 + i), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff])("keeps Unicode whitespace as a path boundary: %i", code => onPlatform("linux", "/home/u", () => {
  const space = String.fromCharCode(code);
  expect(dashboardLabel("role", `/srv/a/b${space}then${space}/mnt/home/u/x`, "/home/u"))
    .toBe(`…/a/b${space}then${space}~/x`);
}));
it.skipIf(!!process.env.CI)("skips canonical scanning when the last home component is absent", () => onPlatform("linux", "/guard/private", () => {
  const absent = "/guard/x".repeat(500), present = absent + "/private";
  const time = (input: string) => {
    const start = performance.now();
    for (let i = 0; i < 100; i++) dashboardLabel("role", input, "/guard/private");
    return performance.now() - start;
  };
  time(absent); time(present);
  const ratios = Array.from({ length: 5 }, () => time(absent) / time(present)).sort((a, b) => a - b);
  // Same slash shape and host: only the necessary last-component check differs.
  expect(ratios[2]).toBeLessThan(0.8);
}));
it("keeps two middle segments of a compact-flag home before a bracketed home", () => onPlatform("linux", "/home/u", () => {
  expect(dashboardLabel("role", "copy -I/home/u/a/b v1=[/home/u/c]", "/home/u")).toBe("copy -I~/a/b v1=[~/c]");
}));
// A closing bracket in a folder name above a mid-path home is not a wrapper:
// every segment before the home stays hidden.
it("hides bracketed folder names above a mid-path home", () => {
  onPlatform("darwin", "/Users/someuser", () => {
    expect(dashboardLabel("role", "/Volumes/My Passport (2)/Users/someuser/doc.txt", "/Users/someuser")).toBe("~/doc.txt");
    expect(dashboardLabel("role", "/Volumes/Disk [old]/Users/someuser/doc.txt", "/Users/someuser")).toBe("~/doc.txt");
  });
  onPlatform("win32", String.raw`C:\Users\Some User`, () => {
    expect(dashboardLabel("role", String.raw`E:\Backups\PC (2)\C\Users\Some User\a.txt`, String.raw`C:\Users\Some User`)).toBe("~/a.txt");
  });
});
