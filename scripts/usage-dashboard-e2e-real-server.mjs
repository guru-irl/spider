import { createServer as createViteServer } from "vite";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join, dirname, relative, isAbsolute } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { get } from "node:http";
process.on("uncaughtExceptionMonitor", error => console.error(error.stack));
const checkout = fileURLToPath(new URL("../", import.meta.url));
const scratch = resolve(checkout, ".spider/scratch/playwright");
const root = process.env.SPIDER_E2E_FIXTURE_ROOT, bundle = process.env.SPIDER_E2E_BUNDLE;
if (!root || !isAbsolute(root) || !relative(scratch, root) || relative(scratch, root).startsWith("..") || bundle !== join(scratch, "real-dist/extension.js") || process.env.SPIDER_GLOBAL_ROOT !== root) throw new Error("Invalid owned fixture roots");
const roots = { ledgerFile: join(root, "usage.db"), registryDb: join(root, "registry.db"), sessionsDir: join(root, "sessions"), leaseDir: join(root, "leases"), authPath: join(root, "disabled-auth.json") };
await mkdir(root, { recursive: true, mode: 0o700 }); await mkdir(roots.sessionsDir, { recursive: true }); await mkdir(roots.leaseDir, { recursive: true });
const registry = new Database(roots.registryDb); registry.exec("CREATE TABLE fixture_registry (id TEXT PRIMARY KEY)"); registry.close();
await writeFile(join(roots.sessionsDir, "synthetic.jsonl"), JSON.stringify({ type: "session", id: "session-garden", timestamp: "2030-04-12T09:00:00Z" }) + "\n");
const loader = await createViteServer({ configFile: false, root: checkout, server: { middlewareMode: true, watch: null }, ssr: { noExternal: ["@spider/db-core"] } });
try { const { openUsageLedger } = await loader.ssrLoadModule("/packages/host/src/usage/ledger.ts"); const ledger = openUsageLedger(roots.ledgerFile); ledger.close(); } finally { await loader.close(); }
// Import inertly first. The extension factory and server's collector must never run here.
const moduleUrl = pathToFileURL(bundle).href, extension = await import(moduleUrl);
const privateDir = join(root, "server"); await mkdir(privateDir, { mode: 0o700 });
const lockFile = join(privateDir, "lock.json"), startup = join(privateDir, "startup.json"), instanceId = randomBytes(16).toString("hex"), secret = randomBytes(32).toString("base64url"), createdAt = Date.now();
const options = { bundleUrl: moduleUrl, roots, lockFile, serverBuild: "synthetic", calibrationMode: "off" };
await writeFile(lockFile + ".guard", JSON.stringify({ version: 1, instanceId, pid: process.pid, createdAt }), { mode: 0o600 });
await writeFile(startup, JSON.stringify({ version: 1, instanceId, secret, createdAt, options }), { mode: 0o600 });
process.argv = [process.execPath, bundle, "--spider-usage-server", startup];
await extension.runUsageServerEntry(moduleUrl, { dashboardDir: join(dirname(bundle), "dashboard") });
if (process.exitCode) throw new Error("Real bundle fixture failed to boot");
const record = JSON.parse(await readFile(lockFile, "utf8"));
const origin = `http://127.0.0.1:${record.port}`;
const envelope = await new Promise((resolve, reject) => {
  const request = get(origin + "/local/bootstrap-nonce", { headers: { Authorization: `Bearer ${secret}` } }, response => {
    let body = ""; response.setEncoding("utf8"); response.on("data", chunk => { body += chunk; });
    response.on("end", () => { if (response.statusCode !== 200) { reject(new Error(`Real fixture nonce failed ${response.statusCode}`)); return; } try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
  });
  request.setTimeout(5000, () => request.destroy(new Error("Nonce timed out"))); request.on("error", reject);
});
console.log("SPIDER_E2E_READY " + JSON.stringify({ origin, bootstrapUrl: `${origin}/bootstrap?nonce=${envelope.data.nonce}` }));
