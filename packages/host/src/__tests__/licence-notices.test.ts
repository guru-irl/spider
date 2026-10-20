import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { DEFAULT_UPSTREAM_REFS } from "../../../superpowers/src/upstream-watch";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
let scratch: string;

beforeAll(() => {
  const base = join(root, ".spider/scratch/licence-tests");
  mkdirSync(base, { recursive: true });
  scratch = mkdtempSync(join(base, "run-"));
});
afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("distributed licence notices", () => {
  it("starts the generated extension with the context-mode and MIT attribution banner", async () => {
    const outDir = join(scratch, "dist");
    await build({
      root,
      configFile: join(root, "vite.config.mjs"),
      logLevel: "silent",
      build: { outDir },
    });
    const code = readFileSync(join(outDir, "extension.js"), "utf8");
    const banner = code.match(/^(?:(?:\/\/[^\n]*\n)|(?:\/\*[\s\S]*?\*\/\s*))+/)?.[0] ?? "";
    expect(banner).toContain("context-mode");
    expect(banner).toContain("Mert Koseoglu");
    expect(banner).toContain("Elastic License 2.0");
    expect(banner).toContain("packages/context/LICENSE");
    expect(banner).toContain("MIT");
    expect(banner).toContain("NOTICE.md");
  }, 60_000);

  it("covers every watched upstream repository, including pstack-claude, in NOTICE.md", () => {
    const path = join(root, "NOTICE.md");
    const notice = existsSync(path) ? readFileSync(path, "utf8") : "";
    const repository = (url: string) => url.toLowerCase().replace(/\.git\/?$/, "").replace(/\/$/, "");
    const documented = new Set(
      [...notice.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+/g)].map(([url]) => repository(url)),
    );
    const upstreams = [
      ...DEFAULT_UPSTREAM_REFS.map(({ upstreamRepo }) => upstreamRepo),
      "https://github.com/michael-denyer/pstack-claude",
    ];
    const missing = upstreams.filter(url => !documented.has(repository(url)));
    expect(missing, "Upstream repositories without a NOTICE entry").toEqual([]);
  });

  it.each([
    ["pstack", "Copyright (c) 2026 Lauren Tan"],
    ["pstack-claude", "Copyright (c) 2026 Lauren Tan\nCopyright (c) 2026 Michael Denyer"],
    ["superpowers", "Copyright (c) 2025 Jesse Vincent"],
    ["pi-hermes-memory", "Copyright (c) 2025 Chandra Teja"],
    ["pi-subagents", "Copyright (c) 2026 Nico Bailon"],
    ["pi-todo-sqlite", "Copyright (c) 2026 guru-irl"],
  ])("includes the copyright and full MIT permission text in the %s entry", (upstream, copyright) => {
    const notice = readFileSync(join(root, "NOTICE.md"), "utf8");
    const entry = notice.split(`## ${upstream}\n`)[1]?.split(/^## /m)[0] ?? "";
    const licence = `${copyright}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
    const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
    expect(normalize(entry)).toContain(normalize(licence));
  });

  it("credits every upstream source named in the scheduler and sleep guard headers", () => {
    const notice = readFileSync(join(root, "NOTICE.md"), "utf8");
    const entry = notice.split("## pstack-claude\n")[1]?.split(/^## /m)[0] ?? "";
    const ports = [
      ...readdirSync(join(root, "packages/host/src/loop")).filter(name => name.endsWith(".ts"))
        .map(name => `packages/host/src/loop/${name}`),
      "packages/host/src/routing/sleep-wait.ts",
    ];
    const sources = new Set<string>();
    for (const port of ports) {
      const header = readFileSync(join(root, port), "utf8").split(/^(?!\/\/)/m)[0];
      for (const [source] of header.matchAll(/plugins\/pstack\/pi\/[\w-]+\.ts/g)) {
        sources.add(source);
        expect(entry, `Missing upstream credit for ${port}`).toContain(source);
      }
    }
    expect([...sources].sort()).toEqual([
      "plugins/pstack/pi/one-shot.ts",
      "plugins/pstack/pi/schedule.ts",
      "plugins/pstack/pi/sleep-wait.ts",
    ]);
    expect(entry).toContain("packages/host/src/loop/");
    expect(entry).toContain("packages/host/src/routing/sleep-wait.ts");
  });

  it("records that the context-mode port postdates the ELv2 change", () => {
    const notice = readFileSync(join(root, "NOTICE.md"), "utf8");
    const entry = notice.split("## context-mode\n")[1]?.split(/^## /m)[0] ?? "";
    const header = readFileSync(join(root, "packages/context/LICENSE"), "utf8").split("Elastic License 2.0 (ELv2)")[0];
    for (const text of [entry, header]) {
      expect(text).toContain("a4829808");
      expect(text).toContain("2026-03-03");
      expect(text).toContain("2026-07-03");
      expect(text).toMatch(/ELv2 applies/);
    }
  });

  it("requires all distributed licence notices in the release tarball verifier", () => {
    const workflow = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
    const verifier = workflow.match(/npm pack --json --ignore-scripts \| node -e "([\s\S]*?)"\s*$/m)?.[1];
    expect(verifier, "Release package verifier must be executable").toBeTruthy();
    const skillFiles = ["packages/superpowers/skills", "packages/pstack/skills"].flatMap(dir =>
      readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
        .filter(file => file === "SKILL.md" || file.endsWith("/SKILL.md")).map(file => `${dir}/${file}`));
    const requiredLicences = ["LICENSE", "NOTICE.md", "packages/context/LICENSE", "packages/pstack/LICENSE"];
    const files = [
      "dist/extension.js", "dist/dashboard/index.html", "README.md",
      "dist/dashboard/assets/index-12345678.js", "dist/dashboard/assets/index-12345678.css",
      ...requiredLicences, ...skillFiles,
    ];
    const verify = (paths: string[]) => spawnSync(process.execPath, ["-e", verifier!], {
      cwd: root,
      encoding: "utf8",
      input: JSON.stringify([{ files: paths.map(path => ({ path })) }]),
    });
    const complete = verify(files);
    expect(complete.status, complete.stderr).toBe(0);
    for (const missing of requiredLicences) {
      const result = verify(files.filter(file => file !== missing));
      expect(result.status, `Release accepted a tarball without ${missing}`).toBe(1);
      expect(result.stderr).toContain(`missing from tarball: ${missing}`);
    }
  });

  it("packs NOTICE.md and both licence files for recipients", () => {
    const args = ["pack", "--dry-run", "--json", "--ignore-scripts"];
    const options = {
      cwd: root,
      encoding: "utf8" as const,
      timeout: 60_000,
      env: {
        ...process.env,
        npm_config_cache: join(scratch, "npm-cache"),
        npm_config_logs_dir: join(scratch, "npm-logs"),
        TMPDIR: scratch,
      },
    };
    const output = process.env.npm_execpath
      ? execFileSync(process.execPath, [process.env.npm_execpath, ...args], options)
      : execFileSync("npm", args, options);
    const [packed] = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
    expect(packed.files.map(({ path }) => path)).toEqual(expect.arrayContaining([
      "LICENSE",
      "NOTICE.md",
      "packages/context/LICENSE",
      "packages/pstack/LICENSE",
    ]));
  }, 60_000);
});
