import { closeSync as irClose, constants as irConstants, fstatSync as irFstat, lstatSync as irLstat, openSync as irOpen, readFileSync as irReadFile, readdirSync as irReaddir, realpathSync as irRealpath } from "node:fs";
import { basename as irBasename, join as irJoin, resolve as irResolve } from "node:path";
import { randomUUID as irUuid } from "node:crypto";
import { connect as irConnect } from "node:net";
import { spawnSync as irSpawn } from "node:child_process";

export interface IntercomReadiness {
  intercomUnique: boolean;
  legacyDrained: boolean;
  federation: boolean;
  intercomEvidence: { settings: string; legacy: string; federation: string; otherExtensions: string[] };
}

function irOwned(info: { uid: number; mode: number }): boolean {
  return (typeof process.getuid !== "function" || info.uid === process.getuid()) && (info.mode & 0o022) === 0;
}
function irDirectory(path: string): void {
  const info = irLstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !irOwned(info) || irRealpath(path) !== irResolve(path)) throw new Error("unsafe-directory");
}
function irReadOwned(path: string): string | null {
  let fd: number;
  try { fd = irOpen(path, irConstants.O_RDONLY | irConstants.O_NOFOLLOW | irConstants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const info = irFstat(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024 || !irOwned(info)) throw new Error("unsafe-file");
    return irReadFile(fd, "utf8");
  } finally { irClose(fd); }
}
function irObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export const INTERCOM_UNIQUENESS_DESCRIPTION = "settings-unique: spider's intercom is the only known intercom implementation declared (global settings only; project-local settings are not checked; known packages: pi-intercom and its scoped variants; other extensions are not classified).";
const irSettingsReasons = new Set(["settings-unique", "settings-unavailable", "settings-resolution-unavailable", "legacy-extension-declared", "settings-spider-invalid", "settings-spider-missing", "settings-spider-duplicate"]);
const irHealthReasons = new Set(["intercom-broker-unavailable", "intercom-broker-not-spider", "intercom-agent-unsafe", "intercom-directory-unsafe", "intercom-socket-unsafe", "federation-feature-missing"]);
/** Reject fabricated or internally inconsistent readiness results. */
export function validIntercomReadiness(value: unknown): value is IntercomReadiness {
  if (!irObject(value) || typeof value.intercomUnique !== "boolean" || typeof value.legacyDrained !== "boolean" || typeof value.federation !== "boolean" ||
      !irObject(value.intercomEvidence) || Object.keys(value.intercomEvidence).length !== 4) return false;
  const { settings, legacy, federation, otherExtensions } = value.intercomEvidence;
  if (!Array.isArray(otherExtensions) || otherExtensions.length > 256 || otherExtensions.some(name => typeof name !== "string" || !/^[A-Za-z0-9@._/-]{1,128}$/.test(name))) return false;
  return typeof settings === "string" && irSettingsReasons.has(settings) && typeof legacy === "string" &&
    (irHealthReasons.has(legacy) || ["legacy-drained-private-agent", "legacy-drained-offline", "legacy-pending-asks", "legacy-pending-asks-unavailable"].includes(legacy)) &&
    typeof federation === "string" && (irHealthReasons.has(federation) || federation === "federation-v1") &&
    value.intercomUnique === (settings === "settings-unique") && value.legacyDrained === (legacy === "legacy-drained-private-agent") &&
    value.federation === (federation === "federation-v1") && (!value.legacyDrained || value.federation);
}
/** Diagnose each prerequisite independently; callers validate the evidence before using it. */
export function intercomReadinessDiagnostics(value: IntercomReadiness): Array<{ severity: "warning" | "block"; reason: string; repairCommand: null }> {
  const result: Array<{ severity: "warning" | "block"; reason: string; repairCommand: null }> = [];
  if (!value.intercomUnique) result.push({ severity: "block", reason: `intercom-settings-unique: ${value.intercomEvidence.settings}; global settings only; project-local settings are not checked.`, repairCommand: null });
  else result.push({ severity: "warning", reason: INTERCOM_UNIQUENESS_DESCRIPTION, repairCommand: null });
  for (const name of value.intercomEvidence.otherExtensions) result.push({ severity: "warning", reason: `intercom-other-extension: ${name} (not classified for intercom).`, repairCommand: null });
  if (!value.legacyDrained) result.push({ severity: "block", reason: `intercom-legacy-drained: ${value.intercomEvidence.legacy} (protocol-validated within the private agent directory).`, repairCommand: null });
  if (!value.federation) result.push({ severity: "block", reason: `intercom-federation: ${value.intercomEvidence.federation}.`, repairCommand: null });
  return result;
}
function irLegacyPath(value: string): boolean {
  return /(?:^|[\\/])(?:pi-)?intercom(?:[\\/]|\.(?:[cm]?[jt]sx?)$)/i.test(value) || /^(?:npm:)?(?:@[^/]+\/)?pi-intercom(?:@|$)/i.test(value);
}
// Pi's package manager runs outside the roaming process and cannot install missing packages.
const irResolveScript = `import{pathToFileURL as u}from'node:url';import{readFileSync as r}from'node:fs';
const[sdk,migration,shim,cwd,agent,roots,bundle]=process.argv.slice(1),raw=r(0,'utf8'),value=JSON.parse(raw);
const p=await import(u(sdk).href),m=await import(u(migration).href),s=await import(u(shim).href);
const q=new p.DefaultPackageManager({cwd,agentDir:agent,settingsManager:p.SettingsManager.inMemory(value)}),v=await q.resolve(async()=> 'error');
process.stdout.write(JSON.stringify({extensions:v.extensions,legacy:JSON.stringify(value)!==JSON.stringify(JSON.parse(m.migrateIntercomSettings(raw,JSON.parse(roots),agent))),shim:s.extensionShim(bundle)}));`;

/** Resolve only global Pi resources. This does not inspect a future destination project's settings. */
async function irSettings(agentDir: string, release: string, sdk: string, cwd: string): Promise<{ settings: string; otherExtensions: string[] }> {
  const names = new Set<string>();
  let declaredLegacy = false;
  const result = (settings: string) => ({ settings, otherExtensions: [...names].sort() });
  try {
    irDirectory(agentDir);
    const raw = irReadOwned(irJoin(agentDir, "settings.json")) ?? "{}", value: unknown = JSON.parse(raw);
    if (!irObject(value)) return result("settings-unavailable");
    const roots = [irJoin(agentDir, "npm", "node_modules", "pi-intercom"), irJoin(agentDir, "node_modules", "pi-intercom")];
    const declarations = [value.packages, value.extensions].flatMap(items => Array.isArray(items) ? items : []);
    declaredLegacy = declarations.some(item => {
      const source = typeof item === "string" ? item : irObject(item) && typeof item.source === "string" ? item.source : "";
      return irLegacyPath(source.replace(/^[+!-]/, ""));
    });
    const shim = irJoin(agentDir, "extensions", "spider.ts"), bundle = irJoin(release, "dist", "extension.js");
    const child = irSpawn(process.execPath, ["--input-type=module", "-e", irResolveScript, sdk, irJoin(release, "scripts", "intercom-switchover.mjs"),
      irJoin(release, "scripts", "extension-shim.mjs"), cwd, agentDir, JSON.stringify(roots), bundle],
      { cwd, env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir }, input: raw, encoding: "utf8", timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
    if (child.status !== 0) return result(declaredLegacy ? "legacy-extension-declared" : "settings-resolution-unavailable");
    const resolved: unknown = JSON.parse(child.stdout);
    if (!irObject(resolved) || !Array.isArray(resolved.extensions) || typeof resolved.legacy !== "boolean" || typeof resolved.shim !== "string")
      return result(declaredLegacy ? "legacy-extension-declared" : "settings-resolution-unavailable");
    declaredLegacy ||= resolved.legacy;
    let spiders = 0, spiderInvalid = false;
    for (const resource of resolved.extensions) {
      if (!irObject(resource) || !irObject(resource.metadata) || typeof resource.path !== "string" || typeof resource.enabled !== "boolean") return result("settings-resolution-unavailable");
      if (!resource.enabled || resource.metadata.scope !== "user") continue;
      const source = typeof resource.metadata.source === "string" ? resource.metadata.source : "";
      let name = irBasename(resource.path);
      if (typeof resource.metadata.packageRoot === "string") {
        const manifest = irReadOwned(irJoin(resource.metadata.packageRoot, "package.json"));
        if (manifest === null) return result(declaredLegacy ? "legacy-extension-declared" : "settings-resolution-unavailable");
        const parsed: unknown = JSON.parse(manifest);
        if (!irObject(parsed) || typeof parsed.name !== "string") return result("settings-resolution-unavailable");
        name = parsed.name;
      }
      if (irLegacyPath(resource.path) || irLegacyPath(source) || irLegacyPath(name)) declaredLegacy = true;
      if (irResolve(resource.path) === irResolve(shim)) {
        if (irReadOwned(shim) !== resolved.shim) spiderInvalid = true;
        spiders++;
      } else if (irResolve(resource.path) === irResolve(bundle)) spiders++;
      else names.add(name.replace(/[^A-Za-z0-9@._/-]/g, "?").slice(0, 128));
      if (names.size > 256 || [...names].some(item => !/^[A-Za-z0-9@._/-]{1,128}$/.test(item))) return result("settings-resolution-unavailable");
    }
    return result(declaredLegacy ? "legacy-extension-declared" : spiderInvalid ? "settings-spider-invalid" : spiders === 1 ? "settings-unique" : spiders === 0 ? "settings-spider-missing" : "settings-spider-duplicate");
  } catch { return result(declaredLegacy ? "legacy-extension-declared" : "settings-resolution-unavailable"); }
}

function irHealth(socketPath: string): Promise<"spider" | "federation-feature-missing" | "intercom-broker-not-spider" | "intercom-broker-unavailable"> {
  return new Promise(resolve => {
    const id = irUuid(), socket = irConnect(socketPath), payload = Buffer.from(JSON.stringify({ type: "health", requestId: id }));
    const frame = Buffer.alloc(4 + payload.length); frame.writeUInt32BE(payload.length); payload.copy(frame, 4);
    let data = Buffer.alloc(0), done = false;
    const finish = (result: "spider" | "federation-feature-missing" | "intercom-broker-not-spider" | "intercom-broker-unavailable") => {
      if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve(result);
    };
    const timer = setTimeout(() => finish("intercom-broker-unavailable"), 2000); timer.unref();
    socket.on("error", () => finish("intercom-broker-unavailable"));
    socket.on("close", () => finish("intercom-broker-unavailable"));
    socket.on("data", chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length < 4) return;
      const length = data.readUInt32BE(0);
      if (length === 0 || length > 16 * 1024 || data.length > 4 + length) return finish("intercom-broker-not-spider");
      if (data.length < 4 + length) return;
      try {
        const value: unknown = JSON.parse(data.subarray(4).toString("utf8"));
        if (!irObject(value) || value.type !== "health_ok" || value.requestId !== id || value.protocol !== "pi-intercom" || value.version !== 1 ||
            value.implementation !== "spider" || !Array.isArray(value.features) || !value.features.every(item => typeof item === "string" && item.length <= 128)) {
          return finish("intercom-broker-not-spider");
        }
        finish(value.features.includes("federation-v1") ? "spider" : "federation-feature-missing");
      } catch { finish("intercom-broker-not-spider"); }
    });
    socket.once("connect", () => socket.write(frame));
  });
}

function irOfflineLegacy(directory: string): string {
  try { irDirectory(directory); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "legacy-drained-offline" : "intercom-directory-unsafe"; }
  try {
    const pending = irJoin(directory, "pending-asks");
    try { irDirectory(pending); return irReaddir(pending).length ? "legacy-pending-asks" : "legacy-drained-offline"; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "legacy-drained-offline"; throw error; }
  } catch { return "legacy-pending-asks-unavailable"; }
}

/** Protocol-validated within the user-owned, non-group/world-writable agent directory; not cryptographic authentication. */
export async function inspectIntercomReadiness(input: { agentDir: string; release: string; sdk: string; cwd: string; ensureBroker?: () => Promise<void> }): Promise<IntercomReadiness> {
  const { settings, otherExtensions } = await irSettings(input.agentDir, input.release, input.sdk, input.cwd);
  // Settings resolution can outlive a sessionless broker. Start only when those
  // checks finish, then prove health before returning the startup observation.
  if (settings === "settings-unique") await input.ensureBroker?.();
  let legacy = "intercom-broker-unavailable", federation = "intercom-broker-unavailable";
  try { irDirectory(input.agentDir); }
  catch { legacy = federation = "intercom-agent-unsafe"; return { intercomUnique: settings === "settings-unique", legacyDrained: false, federation: false, intercomEvidence: { settings, legacy, federation, otherExtensions } }; }
  const directory = irJoin(input.agentDir, "intercom"), socket = irJoin(directory, "broker.sock");
  try { irDirectory(directory); }
  catch (error) { legacy = irOfflineLegacy(directory); federation = (error as NodeJS.ErrnoException).code === "ENOENT" ? "intercom-broker-unavailable" : "intercom-directory-unsafe"; return { intercomUnique: settings === "settings-unique", legacyDrained: false, federation: false, intercomEvidence: { settings, legacy, federation, otherExtensions } }; }
  let initial: ReturnType<typeof irLstat>;
  try {
    initial = irLstat(socket);
    if (!initial.isSocket() || initial.isSymbolicLink() || !irOwned(initial)) throw new Error("unsafe-socket");
  } catch (error) {
    federation = (error as NodeJS.ErrnoException).code === "ENOENT" ? "intercom-broker-unavailable" : "intercom-socket-unsafe";
    legacy = federation === "intercom-broker-unavailable" ? irOfflineLegacy(directory) : federation;
    return { intercomUnique: settings === "settings-unique", legacyDrained: false, federation: false, intercomEvidence: { settings, legacy, federation, otherExtensions } };
  }
  const health = await irHealth(socket);
  try {
    irDirectory(input.agentDir); irDirectory(directory);
    const after = irLstat(socket);
    if (!after.isSocket() || !irOwned(after) || after.dev !== initial.dev || after.ino !== initial.ino) throw new Error("socket-changed");
  } catch { legacy = federation = "intercom-socket-unsafe"; return { intercomUnique: settings === "settings-unique", legacyDrained: false, federation: false, intercomEvidence: { settings, legacy, federation, otherExtensions } }; }
  if (health !== "spider") {
    federation = health; legacy = health === "intercom-broker-unavailable" ? irOfflineLegacy(directory) : health;
  } else {
    federation = "federation-v1";
    try {
      const pending = irJoin(directory, "pending-asks");
      try { irDirectory(pending); legacy = irReaddir(pending).length ? "legacy-pending-asks" : "legacy-drained-private-agent"; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") legacy = "legacy-drained-private-agent"; else throw error; }
    } catch { legacy = "legacy-pending-asks-unavailable"; }
  }
  return { intercomUnique: settings === "settings-unique", legacyDrained: legacy === "legacy-drained-private-agent", federation: federation === "federation-v1",
    intercomEvidence: { settings, legacy, federation, otherExtensions } };
}
