import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>() }));
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join, resolve } from "node:path";
import { startUsageHttpServer } from "../server.js";
import { usageSecurityHeaders } from "../server-security.js";
const roots: string[] = [];
const servers: Awaited<ReturnType<typeof startUsageHttpServer>>[] = [];
function assets() {
  const scratch = resolve(".spider/scratch/usage-dashboard-assets/routes"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "fixture-")); roots.push(root); mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), '<link rel="stylesheet" href="/assets/app-12345678.css"><script type="module" src="/assets/app-12345678.js"></script>');
  writeFileSync(join(root, "assets/app-12345678.js"), 'console.log("cached");'); writeFileSync(join(root, "assets/app-12345678.css"), 'body{color:white}');
  return root;
}
function get(port: number, path: string, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, headers, method }, res => { let body = ""; res.on("data", b => body += b); res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body })); }); req.on("error", reject); req.end();
  });
}
afterEach(async () => { vi.restoreAllMocks(); for (const s of servers.splice(0)) await s.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("asset routes require cookies and exact raw paths and retain cached bytes", async () => {
  const directory = assets();
  const reads: string[] = [], open = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const fd = await open(...args), read = fd.read.bind(fd);
    vi.spyOn(fd, "read").mockImplementation(((...readArgs: Parameters<typeof read>) => { reads.push(String(args[0])); return read(...readArgs); }) as typeof fd.read);
    return fd;
  });
  const s = await startUsageHttpServer({ instanceId: "synthetic", serverBuild: "synthetic", secret: "synthetic-secret", reader: undefined, routes: [], dashboardDir: directory }); servers.push(s);
  const nonce = JSON.parse((await get(s.port, "/local/bootstrap-nonce", { Authorization: "Bearer synthetic-secret" })).body).data.nonce;
  const bootstrap = await get(s.port, `/bootstrap?nonce=${nonce}`); const headers = { Cookie: bootstrap.headers["set-cookie"]![0]!.split(";")[0]! };
  for (const path of ["/assets/app-12345678.js", "/assets/../extension.js", "/assets/%2e%2e/extension.js", "/assets/%2Fextension.js", "/assets/%252e%252e/extension.js", "/assets/nested/app-12345678.js", "/assets//absolute.js", "/assets/unknown-12345678.js"]) {
    expect((await get(s.port, path)).status, path).toBe(401);
    if (path !== "/assets/app-12345678.js") expect((await get(s.port, path, headers)).status, path).toBe(404);
  }
  expect((await get(s.port, "/assets/app-12345678.js", { ...headers, Origin: "http://example.invalid" })).status).toBe(403);
  const js = await get(s.port, "/assets/app-12345678.js", headers); expect(js.body).toBe('console.log("cached");');
  expect(js.headers["content-type"]).toBe("text/javascript; charset=utf-8"); expect(js.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  const head = await get(s.port, "/assets/app-12345678.js", headers, "HEAD"); expect(head.body).toBe(""); expect(head.headers["content-length"]).toBe(js.headers["content-length"]);
  rmSync(directory, { recursive: true, force: true }); expect((await get(s.port, "/assets/app-12345678.js", headers)).body).toBe(js.body);
  expect((await get(s.port, "/", headers)).headers["cache-control"]).toBe("no-store");
  expect((await get(s.port, "/%2e%2e/extension.js", headers)).status).toBe(400);
  expect(reads.sort()).toEqual([join(directory, "assets/app-12345678.css"), join(directory, "assets/app-12345678.js"), join(directory, "index.html")].sort());
});
it("external CSP has no inline or remote stylesheet permission", () => {
  expect(usageSecurityHeaders()["Content-Security-Policy"]).toBe("default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'none'; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'");
});
