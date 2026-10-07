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

// Losing the mapped-root continuation stop deletes an earlier path and prose.
it.each([
  ["cd /tmp/build/out and then cd /Users/someuser", "cd …/build/out and then cd ~"],
  ["copy /srv/a/b/c.txt into /Users/someuser", "copy …/b/c.txt into ~"],
  ["moved /Users/someuser/src/a.ts to /Users/someuser", "moved ~/src/a.ts to ~"],
  ["diff /srv/a/b.txt /Users/someuser", "diff …/a/b.txt ~"],
  ["/srv/a/b.txt and /Users/someuser and more", "…/a/b.txt and ~ and more"],
  ["moved /srv/a/b.txt (from /Users/someuser)", "moved …/a/b.txt (from ~)"],
  ["/srv/a/b.txt /Users/someuser then prose", "…/a/b.txt ~ then prose"],
])("a bare mapped home starts a new path without deleting earlier text: %s", (input, expected) => {
  vi.stubEnv("HOME", home);
  expect(dashboardLabel("role", input, home)).toBe(expected);
});
it("a bare Windows home also stops continuation", () => onPlatform("win32", () => {
  vi.stubEnv("HOME", windowsHome);
  expect(dashboardLabel("role", String.raw`copy D:\data\a\b.txt into C:\Users\Some User`, windowsHome))
    .toBe("copy …/a/b.txt into ~");
}));
it("a bare Linux home also stops continuation", () => onPlatform("linux", () => {
  vi.stubEnv("HOME", "/home/someuser");
  expect(dashboardLabel("role", "rsync -a /srv/backup/x/ /home/someuser", "/home/someuser"))
    .toBe("rsync -a …/backup/x ~");
}));

// Drive identity must not expose a Windows home copied to another root.
it.each([
  [String.raw`cd \Users\Some User`, "cd ~"],
  [String.raw`open \Users\Some User\notes.txt`, "open ~/notes.txt"],
  ["/Users/Some User/notes.txt", "~/notes.txt"],
  [String.raw`D:\Backup\Users\Some User\notes.txt`, "~/notes.txt"],
  [String.raw`\\server\share\Users\Some User\notes.txt`, "~/notes.txt"],
  [String.raw`\\server\share\Users\Some User`, "~"],
  [String.raw`\\host\c$\Users\Some User`, "~"],
  [String.raw`C:\x\Users\Some User\notes.txt`, "~/notes.txt"],
  [String.raw`D:\Users\.\Some User\notes.txt`, "~/notes.txt"],
  [String.raw`\Users\junk\..\Some User\notes.txt`, "~/notes.txt"],
])("Windows home segments match regardless of drive or namespace: %s", (input, expected) => onPlatform("win32", () => {
  vi.stubEnv("HOME", windowsHome);
  expect(dashboardLabel("role", input, windowsHome)).toBe(expected);
}));

// Stale folded offsets expose the second of two differently encoded homes.
it.each([
  ["prefix%2FHzHomeQ5%2Fhz.first.lastQ5 ../a/b -I%5CHzHomeQ5%5Chz.first.lastQ5", "prefix~ ../a/b -I~"],
  ["q=%2FHzHomeQ5%2Fhz.first.lastQ5&x=%5CHzHomeQ5%5Chz.first.lastQ5", "q=~&x=~"],
])("rebuilds search offsets between different encoded forms: %s", (input, expected) => {
  const base = "/HzHomeQ5/hz.first.lastQ5";
  vi.stubEnv("HOME", base);
  expect(dashboardLabel("role", input, base)).toBe(expected);
});
it.each(["ls /srv/a/b ./src/x.ts", "ls /srv/a/b ../x/y.ts"])("an adjacent explicit relative stops continuation: %s", input => {
  vi.stubEnv("HOME", home);
  expect(dashboardLabel("role", input, home)).toBe(input.replace("/srv/a/b", "…/a/b"));
});

// A one-segment home must match a root, not any matching stack suffix.
it.each([
  ["/root", "/root/data/a.txt", "~/data/a.txt"],
  ["/root", "/var/lib/root/data/a.txt", "…/data/a.txt"],
  ["/root", "open /var/lib/root/a.txt", "open …/root/a.txt"],
  ["/root", "cp /srv/a/b /root/x", "cp ~/x"],
])("a one-segment POSIX home maps only at a path start: %s %s", (base, input, expected) => onPlatform("linux", () => {
  vi.stubEnv("HOME", base);
  expect(dashboardLabel("role", input, base)).toBe(expected);
}));
it.each([
  [String.raw`C:\root\x`, "~/x"],
  [String.raw`D:\root\x`, "~/x"],
  [String.raw`\root\x`, "~/x"],
  [String.raw`C:\var\root\x`, "…/root/x"],
  [String.raw`D:\var\root\x`, "…/root/x"],
  ["/c/root/x", "~/x"],
  ["/c/junk/../root/x", "~/x"],
  ["/c/root//x", "~//x"],
  ["cp /srv/a /c/junk/../root/x", "cp …/srv/a ~/x"],
])("a one-segment drive home uses only the effective path root: %s", (input, expected) => onPlatform("win32", () => {
  const base = String.raw`C:\root`;
  vi.stubEnv("HOME", base);
  expect(dashboardLabel("role", input, base)).toBe(expected);
}));
it.each(["cp /srv/a /c/junk/../Users/Some User/x", "/c/Users//Some User/x"])("canonical MSYS homes preserve the mapped root: %s", input => {
  vi.stubEnv("HOME", windowsHome);
  expect(dashboardLabel("role", input, windowsHome)).toBe(input.startsWith("cp ") ? "cp …/srv/a ~/x" : "~/x");
});
it.each([
  ["../Users/someuser/x.ts", "…/x.ts"],
  ["./Users/someuser/x.ts", "…/x.ts"],
  ["edit ../Users/someuser/x.ts", "edit …/x.ts"],
  ["./Users/someuser/private/data/x.ts", "…/data/x.ts"],
  ["../Users//someuser/x.ts", "…/x.ts"],
])("a full home inside a relative path stays private without dot-tilde glue: %s", (input, expected) => {
  vi.stubEnv("HOME", home);
  expect(dashboardLabel("role", input, home)).toBe(expected);
});
it.each(["./src/x.ts", "../Users/otheruser/x.ts", "edit ../tools/x.sh"])("an unrelated explicit relative stays untouched: %s", input => {
  vi.stubEnv("HOME", home);
  expect(dashboardLabel("role", input, home)).toBe(input);
});
it("home-relative mixed separators use one display spelling", () => {
  vi.stubEnv("HOME", windowsHome);
  expect(dashboardLabel("role", String.raw`C:\Users\Some User\Documents\x.docx`, windowsHome)).toBe("~/Documents/x.docx");
  expect(dashboardLabel("role", String.raw`~/Documents\x.docx`, windowsHome)).toBe("~/Documents/x.docx");
});

it("a one-segment home in its own tail does not replace an earlier matched range", () => {
  vi.stubEnv("HOME", "/root");
  expect(dashboardLabel("role", "/root/root/x", "/root")).toBe("~/root/x");
});
it("a repeated root after traversal cannot overwrite a prior match or earlier prose", () => {
  vi.stubEnv("HOME", "/root");
  expect(dashboardLabel("role", "cd /tmp/a/b to /root/../root/x", "/root")).toBe("cd …/a/b to ~/x");
});
it("later encoded replacements carry the earlier canonical root offset", () => {
  vi.stubEnv("HOME", "/root");
  expect(dashboardLabel("role", "cd /tmp/a/b to /root q=%2Froot", "/root")).toBe("cd …/a/b to ~ q=~");
});

// Rebuilding all folded offsets for every home form is linear but too costly.
// Calibrate against fixed Unicode offset work on the same input and machine,
// interleaved with real calls. This is a ratio, not a wall-clock deadline.
it("bounds worst-case home searches relative to a Unicode reference workload", () => onPlatform("darwin", () => {
  const base = "/HzSynthQ5/Hzôme ÜQ5", input = "İ".repeat(4096);
  vi.stubEnv("HOME", base.normalize("NFD") + "/");
  const reference = () => {
    let checksum = 0;
    for (let pass = 0; pass < 4; pass++) {
      const offsets: number[] = [];
      let position = 0;
      for (const point of input) {
        const folded = point.toLowerCase();
        for (let j = 0; j < folded.length; j++) offsets.push(position);
        position += point.length;
      }
      checksum += offsets.length + offsets[offsets.length - 1]!;
    }
    return checksum;
  };
  let checksum = 0;
  const measure = (work: () => unknown) => {
    const start = performance.now();
    for (let i = 0; i < 20; i++) work();
    return performance.now() - start;
  };
  const actual = () => dashboardLabel("role", input, base);
  const calibration = () => { checksum += reference(); };
  for (let i = 0; i < 20; i++) { actual(); calibration(); }
  const ratios = Array.from({ length: 7 }, (_, i) => {
    if (i % 2) { const ref = measure(calibration); return measure(actual) / ref; }
    const elapsed = measure(actual); return elapsed / measure(calibration);
  }).sort((a, b) => a - b);
  console.info(`worst-case/reference ratios: ${ratios.map(r => r.toFixed(3)).join(", ")}`);
  expect(checksum).toBeGreaterThan(0);
  expect(ratios[3]).toBeLessThan(6);
}));
