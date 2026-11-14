import type { BootstrapPeer, Diagnostic } from "./contracts";
import { InventoryError, inventory, prerequisiteDiagnostics } from "./inventory";
import { normalizeConfiguredClis } from "./bootstrap-reply";
import type { ConfiguredCli, DoctorPorts, FileLimit, FileStatus, Inventory, ProvisionVerification } from "./provision-contracts";

function fileReady(file: FileStatus): boolean { return file.present && file.readable && file.modeSafe; }
function low(value: FileLimit, floor: number): boolean { return typeof value === "number" && value < floor; }
function failure(error: unknown): Diagnostic {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(error.code)
    ? error.code : "bootstrap-probe-failed";
  return { reason: `Peer inventory failed (${code}).`, severity: "block", repairCommand: null };
}

/** Report suggested repairs without invoking a service manager or modifying limits. */
export async function doctorPeer(peer: BootstrapPeer, ports: DoctorPorts): Promise<readonly Diagnostic[]> {
  let value: Inventory;
  let configuredClis: ConfiguredCli[] = [];
  try {
    configuredClis = normalizeConfiguredClis(ports.configuredClis);
    value = await inventory(peer, ports.transport, { timeoutMs: ports.limits.controlMs, maxBytes: ports.limits.replyBytes, configuredClis, ...(ports.coreUnit ? { coreUnit: ports.coreUnit } : {}) });
  }
  catch (error) {
    if (!(error instanceof InventoryError)) return [failure(error)];
    value = error.observation;
  }
  const diagnostics = prerequisiteDiagnostics(value, ports.coreUnit);
  const warning = (reason: string, repairCommand: string | null = null) => diagnostics.push({ reason, severity: "warning", repairCommand });
  const block = (reason: string) => diagnostics.push({ reason, severity: "block", repairCommand: null });
  const keys: readonly (keyof ProvisionVerification)[] = ["piSignedIn", "nativeSqlite", "extensionLoaded", "exactSession", "privateModes",
    "bundledIntercom", "intercomUnique", "legacyDrained", "federation"];
  let verified: ProvisionVerification | null = null;
  if (ports.verifyPeer) try {
    const result = await ports.verifyPeer();
    if (result && typeof result === "object" && Object.keys(result).length === keys.length && keys.every(key => typeof result[key] === "boolean")) verified = result;
  } catch { /* An unavailable verification is not readiness. */ }

  if (value.linger === false) warning("User lingering is disabled and may require administrative permission.", "loginctl enable-linger");
  if (value.linger === null) warning("User lingering could not be verified.");
  if (value.softNofile === null) warning("The soft open-file limit is unknown.");
  else if (low(value.softNofile, 65_536)) warning("The soft open-file limit is below 65536. The launcher can raise it only up to the hard limit.");
  if (value.hardNofile === null) warning("The hard open-file limit is unknown.");
  else if (low(value.hardNofile, 65_536)) warning(
    "The hard open-file limit is below 65536. Set LimitNOFILE=65536 for the core service. A core restart kills its terminals.",
    value.core.unit && value.core.unitOwned ? `systemctl --user edit ${value.core.unit}` : null,
  );
  if (value.inotifyInstances === null) warning("The inotify instances limit is unknown.");
  else if (value.inotifyInstances < 1024) warning("The inotify instances limit is below 1024.", "sudo sysctl -w fs.inotify.max_user_instances=1024");
  if (value.inotifyWatches === null) warning("The inotify watches limit is unknown.");
  else if (value.inotifyWatches < 524_288) warning("The inotify watches limit is below 524288.", "sudo sysctl -w fs.inotify.max_user_watches=524288");
  if (value.diskFreeBytes === null) warning("Free disk space at the install root is unknown.");

  if (value.pi === null) block("The pi executable is unavailable on the box.");
  else if (value.piVersion !== ports.release.pi) block("The pi executable does not report the required version 1.2.0.");
  if (!value.spider.installed) block("The spider release is not installed on the box.");
  else if (!value.spider.nativeModuleReady) block("The spider native SQLite module is unavailable.");
  if (!fileReady(value.auth.pi)) block("The pi auth file is missing, unreadable, or has unsafe ownership or mode.");
  else if (!verified?.piSignedIn) block("Pi sign-in is unverified. Auth-file metadata alone does not establish a signed-in provider.");
  if (!verified) block("Extension, exact-session, and intercom readiness are unverified.");
  else {
    if (!verified.nativeSqlite) block("The installed native SQLite module failed its readiness check.");
    if (!verified.extensionLoaded) block("The spider extension did not load.");
    if (!verified.exactSession) block("Exact-session launch was not verified.");
    if (!verified.privateModes) block("Installed file ownership or modes are unsafe.");
    if (!verified.bundledIntercom || !verified.intercomUnique) block("The bundled intercom is missing or duplicated.");
    if (!verified.legacyDrained) block("The legacy intercom broker has not drained.");
    if (!verified.federation) block("Intercom federation is not ready.");
  }
  if (!value.cli.gitIdentity) warning("Git identity is not configured on the box.");
  if (!value.cli.gh) warning("The gh CLI is unavailable on the box.");
  else if (!fileReady(value.auth.gh) || value.auth.ghSignedIn !== true) warning("The gh CLI authentication is missing or could not be verified.");
  for (const [index, configured] of configuredClis.entries()) {
    const result = value.cli.configured[index];
    if (!result) { block("The configured CLI inventory was incomplete."); break; }
    if (!result.executable || !fileReady(result.executable) || !result.executable.executable) warning(`Configured ${configured.name} CLI is unavailable or unsafe.`);
    if (configured.authFile !== null && (!result.auth || !fileReady(result.auth))) warning(`Configured ${configured.name} auth file is missing or unsafe.`);
  }
  return diagnostics;
}
