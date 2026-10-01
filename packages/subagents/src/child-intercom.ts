import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, DefaultPackageManager, SettingsManager, ProjectTrustStore, getAgentDir } from "@earendil-works/pi-coding-agent";

function readSettings(file: string): string | undefined {
  try { return readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Respect Pi package filters, source identities and trust. Missing packages are skipped. */
export async function resolveChildIntercom(cwd: string): Promise<string[]> {
  const agentDir = getAgentDir();
  const global = readSettings(join(agentDir, "settings.json"));
  const defaultTrust = global ? JSON.parse(global).defaultProjectTrust : undefined;
  // Pi locks trust reads. Probes/tests must isolate PI_CODING_AGENT_DIR, not only
  // SPIDER_GLOBAL_ROOT; no trust decision or settings content is changed here.
  const savedTrust = new ProjectTrustStore(agentDir).get(cwd);
  const projectTrusted = savedTrust ?? defaultTrust === "always";
  // Read-only storage avoids SettingsManager.create's filesystem lock/creation path.
  const settingsManager = SettingsManager.fromStorage({
    withLock(scope, fn) {
      const current = scope === "global" ? global : projectTrusted ? readSettings(join(cwd, CONFIG_DIR_NAME, "settings.json")) : undefined;
      const next = fn(current);
      if (next !== undefined && next !== current) throw new Error("Child package resolution cannot write settings.");
    },
  }, { projectTrusted });
  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const resolved = await manager.resolve(async () => "skip");
  return resolved.extensions.filter(resource => {
    if (!resource.enabled || !resource.metadata.baseDir) return false;
    try { return JSON.parse(readFileSync(join(resource.metadata.baseDir, "package.json"), "utf8")).name === "pi-intercom"; }
    catch { return false; }
  }).map(resource => resource.path);
}
