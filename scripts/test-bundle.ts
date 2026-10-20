import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { build } from "vite";

/** Test-only Node bundles. Do not depend on pi's private build dependencies. */
export async function buildFixture(options: {
  entryPoints?: string[];
  stdin?: { contents: string; resolveDir: string; sourcefile?: string; loader?: string };
  outfile?: string;
  external?: string[];
  alias?: Record<string, string>;
  packages?: "external";
  // Retained at call sites to make their Node/ESM fixture requirements explicit.
  bundle?: boolean; platform?: "node"; format?: "esm"; target?: string;
  write?: boolean; metafile?: boolean; logLevel?: string;
}): Promise<{ metafile: { inputs: Record<string, object> }; outputFiles: Array<{ text: string }> }> {
  const virtualId = resolve(options.stdin?.resolveDir ?? process.cwd(), options.stdin?.sourcefile ?? "fixture.ts");
  const entry = options.stdin ? virtualId : options.entryPoints![0];
  const aliases = options.alias ?? {};
  const inputs = new Set<string>();
  const external = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`), ...options.external ?? []]);
  const result = await build({
    configFile: false,
    logLevel: "silent",
    resolve: { alias: aliases },
    plugins: [{
      name: "fixture-bundle",
      enforce: "pre",
      resolveId(id) { if (options.stdin && id === virtualId) return virtualId; },
      load(id) { if (options.stdin && id === virtualId) return options.stdin.contents; },
      generateBundle() {
        // Boundary tests must see resolved imports even when tree shaking drops
        // their code. Chunk.modules alone hides such inputs.
        for (const id of this.getModuleIds()) if (this.getModuleInfo(id)?.code != null) inputs.add(id);
      },
    }],
    build: {
      ssr: true,
      target: options.target ?? "node22",
      write: options.write !== false,
      outDir: options.outfile ? dirname(options.outfile) : undefined,
      emptyOutDir: false,
      minify: false,
      rolldownOptions: {
        input: entry,
        external: id => !Object.hasOwn(aliases, id) && (external.has(id) ||
          (options.packages === "external" && !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("\0"))),
        output: { format: "es", entryFileNames: options.outfile ? options.outfile.split(/[\\/]/).at(-1)! : "fixture.mjs",
          codeSplitting: false },
      },
    },
    ssr: { noExternal: true },
  });
  if ("close" in result || Array.isArray(result)) throw new Error("Expected one fixture bundle");
  const chunks = result.output.filter(output => output.type === "chunk");
  return {
    metafile: { inputs: Object.fromEntries([...inputs].map(id => [id, {}])) },
    outputFiles: chunks.map(chunk => ({ text: chunk.code })),
  };
}
