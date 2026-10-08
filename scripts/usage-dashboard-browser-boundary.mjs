import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";

/** Runtime browser imports stay inside the real web root. Type-only imports are erased by Vite. */
export function usageBrowserBoundary(webRoot) {
  const root = realpathSync(webRoot);
  const viteRoot = dirname(createRequire(import.meta.url).resolve("vite/package.json"));
  const viteClient = new Set(["client.mjs", "env.mjs"].map(file => realpathSync(join(viteRoot, "dist/client", file))));
  let developmentServer = false;
  const within = file => { const path = relative(root, file); return path !== ".." && !path.startsWith("../") && !isAbsolute(path); };
  const forbidden = () => { throw new Error("usage-browser-import-forbidden"); };
  return {
    name: "spider-usage-browser-boundary", enforce: "pre",
    configResolved(config) { developmentServer = config.command === "serve"; },
    async resolveId(id, importer, options) {
      if (options?.ssr) return null;
      // Vite's generated HTML proxy/CSS plumbing and dev client are not application imports.
      if (id === "vite/modulepreload-polyfill" || id === "/@vite/client" || id.startsWith("\0")) return null;
      if (!id.startsWith(".") && !id.startsWith("/") && !isAbsolute(id)) forbidden();
      const resolved = await this.resolve(id, importer, { skipSelf: true });
      if (resolved && !resolved.id.startsWith("\0")) {
        const file = resolved.id.split("?")[0];
        let real; try { real = realpathSync(file); } catch { real = resolve(file); }
        if (!within(real) && !(developmentServer && viteClient.has(real))) forbidden();
      }
      return resolved;
    },
  };
}
