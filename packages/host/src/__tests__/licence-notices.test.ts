import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    ]));
  }, 60_000);
});
