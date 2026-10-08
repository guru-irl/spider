import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
export class DashboardAssetsError extends Error {
  constructor(readonly code: "usage-dashboard-missing" | "usage-dashboard-invalid") { super(code); this.name = "DashboardAssetsError"; }
}
export type DashboardAsset = { body: Buffer; contentType: "text/html; charset=utf-8" | "text/javascript; charset=utf-8" | "text/css; charset=utf-8"; cacheControl: string };
const hashed = /^[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(js|css)$/;
const missing = () => new DashboardAssetsError("usage-dashboard-missing");
const invalid = () => new DashboardAssetsError("usage-dashboard-invalid");
export async function loadDashboardAssets(directory: string): Promise<ReadonlyMap<string, DashboardAsset>> {
  try {
    if (!(await lstat(directory)).isDirectory()) throw invalid();
    const entries = (await readdir(directory)).sort();
    if (!entries.includes("index.html") || !entries.includes("assets")) throw missing();
    if (entries.join() !== "assets,index.html" || !(await lstat(join(directory, "assets"))).isDirectory()) throw invalid();
    const names = await readdir(join(directory, "assets"));
    if (names.some(name => !hashed.test(name))) throw invalid();
    if (!names.some(name => name.endsWith(".js")) || !names.some(name => name.endsWith(".css"))) throw missing();
    const files = ["index.html", ...names.map(name => `assets/${name}`)];
    let total = 0;
    // Stat before reading, so a malformed payload cannot allocate unbounded memory.
    for (const file of files) {
      const info = await lstat(join(directory, file));
      if (!info.isFile() || info.isSymbolicLink()) throw invalid();
      total += info.size;
      if (total > 512 * 1024) throw invalid();
    }
    const assets = new Map<string, DashboardAsset>();
    for (const file of files) {
      const fd = await open(join(directory, file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let body: Buffer;
      try {
        const info = await fd.stat();
        if (!info.isFile() || info.size > 512 * 1024) throw invalid();
        // Bounded read even if the file changes after validation.
        const bytes = Buffer.alloc(info.size + 1);
        const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== info.size) throw invalid();
        body = bytes.subarray(0, bytesRead);
      } finally { await fd.close(); }
      assets.set(file === "index.html" ? "/" : `/${file}`, { body,
        contentType: file.endsWith(".html") ? "text/html; charset=utf-8" : file.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8",
        cacheControl: file === "index.html" ? "no-store" : "public, max-age=31536000, immutable" });
    }
    if ([...assets.values()].reduce((n, a) => n + a.body.length, 0) > 512 * 1024) throw invalid();
    const html = assets.get("/")!.body.toString("utf8");
    if (/<style\b|\sstyle\s*=|\son\w+\s*=/i.test(html) || /<script\b(?![^>]*\bsrc\s*=)/i.test(html)) throw invalid();
    if (/\b(?:src|href)\s*=\s*[^"'\s]/i.test(html)) throw invalid();
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)];
    if (scripts.length !== (html.match(/<script\b/gi) ?? []).length || scripts.some(script => script[1]!.trim())) throw invalid();
    for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
      if (!match[1]!.startsWith("/assets/") || /[?#]/.test(match[1]!)) throw invalid();
      if (!assets.has(match[1]!)) throw missing();
    }
    if (!/<script\b[^>]*\bsrc\s*=\s*["']\/assets\/[A-Za-z0-9_-]+\.js["']/i.test(html) || !/<link\b[^>]*\bhref\s*=\s*["']\/assets\/[A-Za-z0-9_-]+\.css["']/i.test(html)) throw invalid();
    return assets;
  } catch (error) {
    if (error instanceof DashboardAssetsError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw missing();
    throw invalid();
  }
}
