import { build } from "vite";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DASHBOARD_ASSET_MODULE = "virtual:spider-usage-dashboard";
const virtualId = "\0" + DASHBOARD_ASSET_MODULE;
// The browser app imports theme.css; both are embedded in the packaged page.
const browserEntry = fileURLToPath(new URL("../packages/host/src/usage/web/app.ts", import.meta.url));

/** Browser graphs contain local browser sources only. No runtime Vite, Node, pi or DB dependencies. */
export async function buildUsageDashboard({ entry = browserEntry } = {}) {
  entry = resolve(entry);
  const root = dirname(entry);
  const within = file => { const path = relative(root, file); return path !== ".." && !path.startsWith("../") && !isAbsolute(path); };
  const result = await build({ configFile: false, root, logLevel: "silent", publicDir: false,
    plugins: [{ name: "spider-usage-browser-boundary", enforce: "pre", async resolveId(id, importer) {
      if (id.startsWith("\0")) return null;
      if (!id.startsWith(".") && !isAbsolute(id)) throw new Error("usage-browser-import-forbidden");
      const resolved = await this.resolve(id, importer, { skipSelf: true });
      if (resolved && !within(resolved.id.split("?")[0])) throw new Error("usage-browser-import-forbidden");
      return resolved;
    } }],
    build: { write: false, target: "es2022", minify: true, sourcemap: false, cssCodeSplit: false,
      lib: { entry, name: "SpiderUsageDashboard", formats: ["iife"] },
      rollupOptions: { output: { codeSplitting: false, entryFileNames: "usage.js" } } },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
  const chunks = outputs.filter(item => item.type === "chunk");
  const css = outputs.filter(item => item.type === "asset" && item.fileName.endsWith(".css"));
  if (chunks.length !== 1 || outputs.some(item => item.type === "asset" && !item.fileName.endsWith(".css"))) throw new Error("usage-browser-output-invalid");
  const script = chunks[0].code.replace(/<\/script/gi, match => "<\\/" + match.slice(2));
  const styles = css.map(item => String(item.source)).join("\n").replace(/<\/style/gi, match => "<\\/" + match.slice(2));
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Usage dashboard</title><style>${styles}</style></head><body><div id="usage-app"></div><script>${script}</script></body></html>`;
  if (Buffer.byteLength(html) > 512 * 1024) throw new Error("usage-browser-output-invalid");
  return { html, modules: Object.keys(chunks[0].modules) };
}

/** Rebuild on each SSR/watch cycle, then embed strings rather than emitting separate browser files. */
export function usageDashboardAssetsPlugin(options = {}) {
  let html;
  return { name: "spider-usage-dashboard-assets",
    async buildStart() {
      const assets = await buildUsageDashboard(options); html = assets.html;
      this.addWatchFile(fileURLToPath(import.meta.url));
      for (const file of assets.modules) this.addWatchFile(file);
    },
    resolveId(id) { if (id === DASHBOARD_ASSET_MODULE) return virtualId; },
    load(id) { if (id === virtualId) return `export const DASHBOARD_HTML = ${JSON.stringify(html)};`; },
  };
}
