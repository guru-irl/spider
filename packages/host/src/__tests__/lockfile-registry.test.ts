import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const script = join(root, "scripts/check-lockfile-registry.mjs");
const scratch = join(root, "packages/host/.spider/scratch", String(process.pid), "lockfile-registry");
mkdirSync(scratch, { recursive: true });
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let fixture: string;
let bin: string;

beforeEach(() => {
  fixture = mkdtempSync(join(scratch, "fixture-"));
  bin = join(fixture, "bin");
  mkdirSync(bin);
  // Only replace Git's read-only tracked-file listing. No fixture changes a Git index.
  const git = join(bin, "git");
  writeFileSync(git, `#!${process.execPath}
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (!args.includes('ls-files') || !args.includes('-z')) process.exit(2);
const paths = JSON.parse(readFileSync('tracked-npmrc.json', 'utf8'));
process.stdout.write(paths.map(p => p + '\\0').join(''));
`);
  chmodSync(git, 0o755);
  writeFileSync(join(fixture, "tracked-npmrc.json"), "[]");
});

type Entry = { resolved?: string; integrity?: string; link?: boolean; name?: string; version?: string };
function lock(packages: Record<string, Entry>): string {
  const text = JSON.stringify({ name: "fixture", lockfileVersion: 3, packages }, null, 2) + "\n";
  writeFileSync(join(fixture, "package-lock.json"), text);
  return text;
}
function run(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: fixture,
    env: { ...process.env, PATH: bin },
    encoding: "utf8",
  });
}
function contents(): string { return readFileSync(join(fixture, "package-lock.json"), "utf8"); }
function npmrc(path: string, text: string, tracked = true): void {
  mkdirSync(dirname(join(fixture, path)), { recursive: true });
  writeFileSync(join(fixture, path), text);
  writeFileSync(join(fixture, "tracked-npmrc.json"), JSON.stringify(tracked ? [path] : []));
}

const sha1 = "sha1-wFsiG8cEN4R7p1ccHhf/yUIB7Kw=";
const sha512 = "sha512-tGkquRVyKSGx17hbG575VLtf5JYk7MjOcXxRMazBLMIy90/alr3NzLU/3LH75ybQESKP0uJg0Kzjwg6sGUNOyg==";

// Only the external npm download is replaced. The guard must hash the real bytes
// written by this boundary double and verify their SHA-1 before changing integrity.
function packDouble(mode = "ok", name = "example") {
  const npm = join(bin, "npm");
  writeFileSync(npm, `#!${process.execPath}
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
const args = process.argv.slice(2);
writeFileSync('npm-called.json', JSON.stringify(args));
if (${JSON.stringify(mode)} === 'error') {
  console.error('https://feed.example.com/fictional-secret'); process.exit(1);
}
const dest = args[args.indexOf('--pack-destination') + 1];
if (args[0] !== 'pack' || args[1] !== ${JSON.stringify(`${name}@1.0.0`)} || !args.includes('--json') || !args.includes('--ignore-scripts')) process.exit(2);
for (const p of [dest, process.env.npm_config_cache, process.env.npm_config_logs_dir, process.env.TMPDIR]) {
  const r = p && relative(process.cwd(), p);
  if (!p || !r || r.startsWith('..') || isAbsolute(r)) process.exit(3);
}
const bytes = Buffer.from('fixture tarball bytes\\n');
const filename = ${JSON.stringify(mode)} === 'escape' ? '../escape.tgz' : 'example-1.0.0.tgz';
writeFileSync(join(dest, filename), bytes);
const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const shasum = createHash('sha1').update(bytes).digest('hex');
process.stdout.write(JSON.stringify([{name:${JSON.stringify(name)}, version:'1.0.0', filename,
  integrity: ${JSON.stringify(mode)} === 'bad-sha512' ? 'sha512-wrong' : integrity,
  shasum: ${JSON.stringify(mode)} === 'bad-sha1' ? '0000' : shasum}]));
`);
  chmodSync(npm, 0o755);
}

// Each group names the guard break it catches: skipped sources, leaked errors,
// unsafe npmrc keys, weak or unverified integrity, and unwanted serialization.
describe("lockfile source and integrity regressions", () => {
  it("checks the repository lockfile offline before commit", () => {
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
  it.each([
    "HTTPS://feed.example.com/example.tgz", " https://feed.example.com/example.tgz",
    "git+https://feed.example.com/repo", "git+ssh://git@feed.example.com/repo",
    "ssh://feed.example.com/repo", "file:../local", "packages/not-a-link",
    "https://user:fictional-secret@registry.npmjs.org/example/-/example-1.0.0.tgz",
    "http://registry.npmjs.org/example/-/example-1.0.0.tgz",
    "https://registry.npmjs.org/", "https://registry.npmjs.org/x",
    "https://feed.example.com/example/-/example-1.0.0.tgz",
  ])("rejects non-registry or unsafe source %s without leaking it", resolved => {
    const before = lock({ "node_modules/example": { resolved } });
    for (const args of [[], ["--fix"]]) {
      const result = run(...args);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("node_modules/example");
      expect(result.stderr).toContain("registry.npmjs.org");
      expect(result.stderr).not.toContain("feed.example.com");
      expect(result.stderr).not.toContain("fictional-secret");
      expect(contents()).toBe(before);
    }
  });

  it.each([
    " https://registry.npmjs.org/example/-/example-1.0.0.tgz",
    "https://registry.npmjs.org/example/-/example-1.0.0.tgz ",
    "https://registry.npmjs.org/exam\tple/-/example-1.0.0.tgz",
    "https://registry.npmjs.org/exam\nple/-/example-1.0.0.tgz",
  ])("rejects whitespace in public registry URLs: %s", resolved => {
    const before = lock({ "node_modules/example": { resolved, integrity: sha512 } });
    for (const args of [[], ["--fix"]]) {
      const result = run(...args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("without credentials");
      expect(contents()).toBe(before);
    }
  });

  it("requires integrity for registry tarballs in CHECK and fix mode", () => {
    packDouble();
    const before = lock({ "node_modules/example": { resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz" } });
    for (const args of [[], ["--fix"]]) {
      const result = run(...args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("node_modules/example");
      expect(result.stderr).toContain("integrity");
      expect(contents()).toBe(before);
      expect(existsSync(join(fixture, "npm-called.json"))).toBe(false);
    }
  });

  it("upgrades scoped v1 dependency integrity using the full package name", () => {
    packDouble("ok", "@scope/example");
    writeFileSync(join(fixture, "package-lock.json"), JSON.stringify({ lockfileVersion: 1,
      dependencies: { outer: { dependencies: { "@scope/example": {
        version: "1.0.0", resolved: "https://registry.npmjs.org/@scope/example/-/example-1.0.0.tgz", integrity: sha1,
      } } } },
    }));
    const result = run("--fix");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(contents()).dependencies.outer.dependencies["@scope/example"].integrity).toBe(sha512);
    expect(run().status).toBe(0);
    expect(readdirSync(join(fixture, ".spider/scratch"))).toEqual([]);
  });

  it("fails closed on invalid URLs without echoing the URL", () => {
    lock({ "node_modules/example": { resolved: "https://[invalid/fictional-secret" } });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid resolved URL");
    expect(result.stderr).not.toContain("fictional-secret");
  });

  it("does not map empty mirror paths to the registry root", () => {
    const before = lock({ "node_modules/example": { resolved: "https://feed.example.com/npm/registry/" } });
    const result = run("--fix");
    expect(result.status).toBe(1);
    expect(contents()).toBe(before);
  });

  it.each([1, 2, 3])("scans recursive dependencies in lockfile v%s", lockfileVersion => {
    writeFileSync(join(fixture, "package-lock.json"), JSON.stringify({
      lockfileVersion, ...(lockfileVersion > 1 ? { packages: {} } : {}),
      dependencies: { outer: { dependencies: { example: { version: "1.0.0", resolved: "git+https://feed.example.com/repo" } } } },
    }));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("example");
    expect(result.stderr).not.toContain("feed.example.com");
  });

  it("fixes v1 nested dependency mirror tarballs", () => {
    writeFileSync(join(fixture, "package-lock.json"), JSON.stringify({ lockfileVersion: 1,
      dependencies: { outer: { dependencies: { example: {
        version: "1.0.0", resolved: "https://feed.example.com/npm/registry/example/-/example-1.0.0.tgz", integrity: "sha512-example",
      } } } },
    }));
    const result = run("--fix");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(contents()).dependencies.outer.dependencies.example.resolved).toBe("https://registry.npmjs.org/example/-/example-1.0.0.tgz");
  });

  it("scans resolved values outside packages and dependencies", () => {
    writeFileSync(join(fixture, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {}, metadata: [{ resolved: "https://feed.example.com/x.tgz" }] }));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("metadata");
    expect(result.stderr).not.toContain("feed.example.com");
  });

  it.each(["not-json", "{\"lockfileVersion\":3}", "{\"packages\":[]}"])("fails closed for malformed lockfiles: %s", text => {
    writeFileSync(join(fixture, "package-lock.json"), text);
    expect(run().status).toBe(1);
  });

  it("rejects unknown command options without writing", () => {
    const before = lock({});
    const result = run("--unknown");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage");
    expect(contents()).toBe(before);
  });

  it("writes two-space JSON and a final newline when fixing", () => {
    lock({ "node_modules/example": { resolved: "https://feed.example.com/npm/registry/example/-/example-1.0.0.tgz", integrity: "sha512-example" } });
    expect(run("--fix").status).toBe(0);
    expect(contents()).toBe('{\n  "name": "fixture",\n  "lockfileVersion": 3,\n  "packages": {\n    "node_modules/example": {\n      "resolved": "https://registry.npmjs.org/example/-/example-1.0.0.tgz",\n      "integrity": "sha512-example"\n    }\n  }\n}\n');
  });

  it.each(["proxy", "https-proxy", "noproxy", "ca", "cafile", "replace-registry-host", "unknown"])("rejects tracked npmrc key %s without echoing values", key => {
    lock({});
    npmrc(".npmrc", `${key}=https://feed.example.com/fictional-secret\n`);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(".npmrc:1");
    expect(result.stderr).not.toContain("feed.example.com");
    expect(result.stderr).not.toContain("fictional-secret");
  });

  it("accepts only harmless npmrc settings, case, quotes, arrays and comments", () => {
    lock({});
    npmrc(".npmrc", '# registry=https://feed.example.com\n; proxy=fictional-secret\n"SAVE-EXACT"=true\n\'engine-strict\'=true\nfund[]=false\naudit=false\npackage-lock=true\nlockfile-version=3\n');
    const result = run();
    expect(result.status, result.stderr).toBe(0);
  });

  it("CHECK rejects sha1-only integrity without invoking npm or writing", () => {
    packDouble();
    const before = lock({ "node_modules/example": { version: "1.0.0", integrity: sha1 } });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("sha512");
    expect(result.stderr).toContain("node_modules/example");
    expect(existsSync(join(fixture, "npm-called.json"))).toBe(false);
    expect(contents()).toBe(before);
  });

  it.each(["", "sha256-other", "sha512-"])("CHECK rejects integrity without a sha512 digest: %s", integrity => {
    lock({ "node_modules/example": { integrity } });
    expect(run().status).toBe(1);
  });

  it("CHECK accepts sha512 in a multi-algorithm integrity without npm", () => {
    packDouble();
    lock({ "node_modules/example": { integrity: `${sha1} ${sha512}` } });
    expect(run().status).toBe(0);
    expect(existsSync(join(fixture, "npm-called.json"))).toBe(false);
  });

  it("upgrades integrity from downloaded bytes after checking SHA-1", () => {
    packDouble();
    lock({ "node_modules/example": { version: "1.0.0", resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz", integrity: sha1 } });
    const result = run("--fix");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(contents()).packages["node_modules/example"].integrity).toBe(sha512);
    expect(run().status).toBe(0);
    expect(readdirSync(join(fixture, ".spider/scratch"))).toEqual([]);
  });

  it.each(["error", "bad-sha1", "bad-sha512", "escape"])("refuses unverified npm pack output: %s", mode => {
    packDouble(mode);
    const before = lock({ "node_modules/example": { version: "1.0.0", integrity: sha1 } });
    const result = run("--fix");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("node_modules/example");
    expect(result.stderr).toContain("sha512");
    expect(result.stderr).not.toContain("feed.example.com");
    expect(result.stderr).not.toContain("fictional-secret");
    expect(contents()).toBe(before);
    expect(readdirSync(join(fixture, ".spider/scratch"))).toEqual([]);
  });

  it("refuses to upgrade when the existing SHA-1 does not match tarball bytes", () => {
    packDouble();
    const before = lock({ "node_modules/example": { version: "1.0.0", integrity: "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=" } });
    const result = run("--fix");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SHA-1");
    expect(contents()).toBe(before);
  });

  it("refuses to upgrade without an existing SHA-1 or package version", () => {
    packDouble();
    lock({ "node_modules/example": { version: "1.0.0", integrity: "sha256-other" } });
    expect(run("--fix").status).toBe(1);
    lock({ "node_modules/example": { integrity: sha1 } });
    expect(run("--fix").status).toBe(1);
    expect(existsSync(join(fixture, "npm-called.json"))).toBe(false);
  });
});

describe("lockfile registry guard", () => {
  // These tests catch acceptance of unsafe hosts, wrong tarball mapping, integrity
  // changes, unnecessary writes, and reading npmrcs outside Git's tracked list.
  it("accepts npmjs URLs and leaves the lockfile byte-identical", () => {
    const before = lock({ "node_modules/example": { resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz", integrity: sha512 } });
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(contents()).toBe(before);
  });

  it.each(["https://feed.example.com", "http://feed.example.com", "https://registry.npmjs.org.example.com", "https://registry.npmjs.org:8443"])("rejects %s and reports only the package key without rewriting", host => {
    const before = lock({ "node_modules/example": { resolved: `${host}/example/-/example-1.0.0.tgz` } });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("node_modules/example");
    expect(result.stderr).toContain("host is not registry.npmjs.org");
    expect(result.stderr).not.toContain(new URL(host).host);
    expect(contents()).toBe(before);
  });

  it("reports every offending package, including scoped packages", () => {
    lock({
      "node_modules/example": { resolved: "https://feed.example.com/a.tgz" },
      "node_modules/@scope/example": { resolved: "https://mirror.example.com/@scope/example/-/example-1.0.0.tgz" },
    });
    const result = run();
    expect(result.status).toBe(1);
    for (const text of ["node_modules/example", "node_modules/@scope/example"]) {
      expect(result.stderr).toContain(text);
    }
    expect(result.stderr).not.toContain("feed.example.com");
    expect(result.stderr).not.toContain("mirror.example.com");
  });

  it("accepts non-URL workspace links and missing resolved fields", () => {
    lock({ "": {}, "packages/example": {}, "node_modules/example": { resolved: "packages/example", link: true } });
    for (const args of [[], ["--fix"]]) {
      const result = run(...args);
      expect(result.status, result.stderr).toBe(0);
    }
  });

  it("maps mirror tarballs and scoped packages, preserves integrity, and is idempotent", () => {
    lock({
      "node_modules/example": { resolved: "https://feed.example.com/team/npm/registry/example/-/example-1.0.0.tgz?download=1", integrity: "sha512-example" },
      "node_modules/@scope/example": { resolved: "https://feed.example.com/team/npm/registry/@scope/example/-/example-2.0.0.tgz", integrity: "sha512-scoped" },
    });
    const result = run("--fix");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(contents()).packages).toEqual({
      "node_modules/example": { resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz", integrity: "sha512-example" },
      "node_modules/@scope/example": { resolved: "https://registry.npmjs.org/@scope/example/-/example-2.0.0.tgz", integrity: "sha512-scoped" },
    });
    const fixed = contents();
    expect(run("--fix").status).toBe(0);
    expect(contents()).toBe(fixed);
  });

  it("fix leaves an already valid lockfile byte-identical", () => {
    lock({ "node_modules/example": { resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz", integrity: "sha512-example" } });
    // Nonstandard formatting detects an unnecessary serialize/write even if mtime is coarse.
    const before = contents().replaceAll("  ", "\t").replace(/\n$/, "");
    writeFileSync(join(fixture, "package-lock.json"), before);
    const mtime = statSync(join(fixture, "package-lock.json")).mtimeMs;
    expect(run("--fix").status).toBe(0);
    expect(contents()).toBe(before);
    expect(statSync(join(fixture, "package-lock.json")).mtimeMs).toBe(mtime);
  });

  it("keeps unmappable URLs as failures while fixing mappable entries", () => {
    lock({
      "node_modules/example": { resolved: "https://feed.example.com/npm/registry/example/-/example-1.0.0.tgz", integrity: "sha512-example" },
      "node_modules/manual": { resolved: "https://mirror.example.com/manual/-/manual-1.0.0.tgz", integrity: "sha512-manual" },
    });
    const result = run("--fix");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("node_modules/manual");
    expect(result.stderr).not.toContain("mirror.example.com");
    expect(JSON.parse(contents()).packages).toEqual({
      "node_modules/example": { resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz", integrity: "sha512-example" },
      "node_modules/manual": { resolved: "https://mirror.example.com/manual/-/manual-1.0.0.tgz", integrity: "sha512-manual" },
    });
  });

  it.each([
    "registry=https://feed.example.com\n",
    "registry\n",
    "_authToken\n",
    "@scope:registry = https://feed.example.com\n",
    "//feed.example.com/npm/:_authToken=fictional-secret\n",
    "_auth=fictional-secret\n",
    "username=fictional-user\n",
    "//feed.example.com/:_password=fictional-secret\n",
    "always-auth=true\n",
    "certfile=fixture.pem\n",
    "keyfile=fixture.pem\n",
  ])("rejects tracked nested npmrc registry/auth settings without printing credentials: %s", setting => {
    lock({});
    npmrc("packages/example/.npmrc", setting);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("packages/example/.npmrc");
    expect(result.stderr).not.toContain("fictional-secret");
    expect(result.stderr).not.toContain("fictional-user");
  });

  it("does not fix or suppress tracked npmrc failures", () => {
    lock({});
    npmrc(".npmrc", "registry=https://feed.example.com\n");
    const result = run("--fix");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(".npmrc");
    expect(readFileSync(join(fixture, ".npmrc"), "utf8")).toBe("registry=https://feed.example.com\n");
  });

  it("ignores untracked npmrc files and registry/auth text in comments", () => {
    lock({});
    npmrc(".npmrc", "registry=https://feed.example.com\n", false);
    expect(run().status).toBe(0);
    npmrc(".npmrc", "# registry=https://feed.example.com\n; _authToken=fictional-secret\nsave-exact=true\n");
    expect(run().status).toBe(0);
  });

  it("fails closed when Git cannot list tracked files", () => {
    lock({});
    writeFileSync(join(bin, "git"), `#!${process.execPath}\nprocess.exit(2);\n`);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tracked");
  });
});
