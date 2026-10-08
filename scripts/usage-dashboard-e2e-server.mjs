import { build } from "vite";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const raw = process.env.SPIDER_PLAYWRIGHT_PORT ?? "4177";
if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) throw new Error("Invalid Playwright port");
const site = resolve(root, ".spider/scratch/playwright/site");
await build({ configFile: resolve(root, "vite.dashboard.config.mjs"), mode: "e2e", build: { outDir: site } });
const assets = new Map();
for (const file of ["index.html", "states.html", ...(await readdir(join(site, "assets"))).map(n => "assets/" + n)]) assets.set("/" + file, { body: await readFile(join(site, file)), type: file.endsWith(".html") ? "text/html; charset=utf-8" : file.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8" });
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'none'; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'";
const server = createServer((req, res) => {
  res.setHeader("Content-Security-Policy", csp); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return; }
  const path = (req.url ?? "").split("?")[0];
  if (path === "/ready") { res.writeHead(200); res.end(req.method === "HEAD" ? undefined : "ready"); return; }
  const asset = assets.get(path === "/" ? "/index.html" : path);
  if (!asset) { res.writeHead(404); res.end(); return; }
  res.setHeader("Content-Type", asset.type); res.writeHead(200); res.end(req.method === "HEAD" ? undefined : asset.body);
});
server.listen(Number(raw), "127.0.0.1");
server.on("error", error => { console.error(error.message); process.exitCode = 1; });
function stop() { const deadline = setTimeout(() => process.exit(1), 5000); server.closeAllConnections(); server.close(() => { clearTimeout(deadline); }); }
process.once("SIGTERM", stop); process.once("SIGINT", stop);
