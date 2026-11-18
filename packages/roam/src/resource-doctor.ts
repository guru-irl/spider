import type { BootstrapPeer, Diagnostic } from "./contracts";
import { InventoryError, inventory, prerequisiteDiagnostics } from "./inventory";
import { normalizeConfiguredClis } from "./bootstrap-reply";
import type { ConfiguredCli, DoctorPorts, FileLimit, FileStatus, IntercomDoctorState, Inventory, ProvisionVerification } from "./provision-contracts";
import { intercomReadinessDiagnostics, validIntercomReadiness } from "./intercom-readiness";

function fileReady(file: FileStatus): boolean { return file.present && file.readable && file.modeSafe; }
function low(value: FileLimit, floor: number): boolean { return typeof value === "number" && value < floor; }
function failure(error: unknown): Diagnostic {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(error.code)
    ? error.code : "bootstrap-probe-failed";
  return { reason: `Peer inventory failed (${code}).`, severity: "block", repairCommand: null };
}

const cleanupReasons = new Set(["intercom-revocation-unconfirmed", "intercom-revocation-peer-unreachable", "intercom-revocation-identity-mismatch", "intercom-revocation-shared-jobs",
  "intercom-revocation-access-open", "intercom-revocation-verification-pending", "intercom-revocation-remote-fence-pending", "intercom-revocation-cleanup-pending"]);
/** Convert read-only observations, including pending cleanup, to stable diagnostic reasons. */
export function intercomDiagnostics(value: IntercomDoctorState): Diagnostic[] {
  const allowed: Record<string, readonly string[]> = { connector: ["ready", "missing", "unknown"], login: ["ready", "required", "unknown"],
    tunnel: ["hosted", "unhosted", "unknown"], peerPort: ["reachable", "unreachable", "unknown"], hostKey: ["match", "changed", "unknown"],
    key: ["ready", "missing", "unsafe", "unknown"], route: ["ready", "missing", "unknown"], extension: ["ready", "missing", "duplicate", "unknown"],
    broker: ["ready", "legacy", "unknown"], feature: ["ready", "missing", "unknown"], link: ["live", "down", "unknown"] };
  if (!value || typeof value !== "object" || Object.entries(allowed).some(([key, choices]) => !choices.includes((value as unknown as Record<string, string>)[key])) ||
      !Array.isArray(value.pendingRevocations) || value.pendingRevocations.some(item => !item || typeof item.pairId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.pairId) || !cleanupReasons.has(item.reason))) throw new Error("intercom-diagnostics-invalid");
  const diagnostics: Diagnostic[] = [];
  const add = (reason: string, detail: string, severity: "warning" | "block" = "block") => diagnostics.push({ reason: `${reason}: ${detail}`, severity, repairCommand: null });
  if (value.connector === "missing") add("intercom-connector-missing", "Install the connector yourself and retry enrollment.");
  if (value.login === "required") add("intercom-connector-sign-in-required", "Sign in to the connector using its device-code flow and retry.");
  if (value.tunnel === "unhosted") add("intercom-tunnel-unhosted", "Start hosting the tunnel and retry.");
  if (value.peerPort === "unreachable") add("intercom-peer-port-unreachable", "Make the peer's SSH port reachable through the tunnel and retry.");
  if (value.hostKey === "changed") add("host-key-changed", "Verify the peer identity and re-enroll the pair to pin the new host key.");
  if (value.key === "missing") add("intercom-key-missing", "The pair key is unavailable.");
  if (value.key === "unsafe") add("intercom-key-unsafe", "The pair key has unsafe ownership or mode.");
  if (value.route === "missing") add("intercom-route-missing", "The pair route is unavailable.");
  if (value.extension === "missing") add("intercom-extension-missing", "The bundled extension is unavailable.");
  if (value.extension === "duplicate") add("intercom-extension-duplicate", "Multiple intercom extensions are configured.");
  if (value.broker === "legacy") add("intercom-legacy-broker", "The old broker has not drained.");
  if (value.feature === "missing") add("intercom-feature-missing", "The broker does not offer federation.");
  if (value.link === "down") add("intercom-link-down", "The enrolled pair is unreachable.", "warning");
  for (const pending of value.pendingRevocations) add(pending.reason, pending.reason === "intercom-revocation-unconfirmed"
    ? `Box A may still reach box B for ${pending.pairId} until B is back and its pair host is stopped.` : `Remote cleanup is pending for ${pending.pairId}.`,
    pending.reason === "intercom-revocation-unconfirmed" ? "block" : "warning");
  return diagnostics;
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
  const diagnostics = prerequisiteDiagnostics(value);
  const warning = (reason: string, repairCommand: string | null = null) => diagnostics.push({ reason, severity: "warning", repairCommand });
  const block = (reason: string) => diagnostics.push({ reason, severity: "block", repairCommand: null });
  const keys = ["piSignedIn", "nativeSqlite", "extensionLoaded", "exactSession", "privateModes",
    "bundledIntercom", "intercomUnique", "legacyDrained", "federation"] as const;
  let verified: ProvisionVerification | null = null;
  if (ports.verifyPeer) try {
    const result = await ports.verifyPeer();
    if (result && typeof result === "object" && Object.keys(result).length === keys.length + 1 &&
        keys.every(key => typeof result[key] === "boolean") && validIntercomReadiness(result)) verified = result;
  } catch { /* An unavailable verification is not readiness. */ }

  if (value.core.unit) warning(`Herdr core unit ${value.core.unit} (${value.core.transient ? "transient" : "persistent"}; diagnostic only).`);
  if (ports.coreUnit && (value.core.unit !== ports.coreUnit || !value.core.unitOwned)) warning(`Recorded core unit ${ports.coreUnit} is missing or not owned; startup uses the enrolled core pin.`);
  else if (!value.core.unit) warning("The core unit is unavailable (diagnostic only).");
  if (value.linger === false) warning("User lingering is disabled and may require administrative permission.", "loginctl enable-linger");
  if (value.linger === null) warning("User lingering could not be verified.");
  if (value.softNofile === null) warning("The soft open-file limit is unknown.");
  else if (low(value.softNofile, 65_536)) warning("The soft open-file limit is below 65536. The launcher can raise it only up to the hard limit.");
  if (value.hardNofile === null) warning("The hard open-file limit is unknown.");
  else if (low(value.hardNofile, 65_536)) warning(
    value.core.transient ? "The hard open-file limit is below 65536. Configure the limit at core startup. A core restart kills its terminals." :
      "The hard open-file limit is below 65536. Set LimitNOFILE=65536 for the core service. A core restart kills its terminals.",
    value.core.unit && value.core.unitOwned && value.core.transient === false ? `systemctl --user edit ${value.core.unit}` : null,
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
    if (!verified.bundledIntercom) block("intercom-bundle-missing: The bundled intercom is unavailable.");
    diagnostics.push(...intercomReadinessDiagnostics(verified));
  }
  if (ports.inspectIntercom) {
    try { diagnostics.push(...intercomDiagnostics(await ports.inspectIntercom())); }
    catch { block("intercom-diagnostics-unavailable: Intercom readiness could not be inspected."); }
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
