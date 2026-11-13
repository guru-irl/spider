import { posix } from "node:path";
import { HerdrError } from "@spider/herdr/client/parse";
import type { BootstrapPeer } from "./contracts";
import { isMachineId } from "./machine-id";
import type { ConfiguredCli, FileLimit, FileStatus, Inventory } from "./provision-contracts";

function invalid(): never { throw new HerdrError("invalid-bootstrap-reply", "Invalid bootstrap inventory reply"); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) return invalid();
  return result;
}
function bool(value: unknown): value is boolean { return typeof value === "boolean"; }
function nullableBool(value: unknown): boolean { return value === null || bool(value); }
function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function nullableCount(value: unknown): boolean { return value === null || count(value); }
function limit(value: unknown): value is FileLimit { return value === null || value === "unlimited" || count(value); }
function version(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?$/.test(value) && value.length <= 64;
}
function nullableVersion(value: unknown): boolean { return value === null || version(value); }
function file(value: unknown): FileStatus {
  const row = record(value, ["present", "readable", "modeSafe"]);
  if (!bool(row.present) || !bool(row.readable) || !bool(row.modeSafe) || !row.present && (row.readable || row.modeSafe)) return invalid();
  return row as unknown as FileStatus;
}

export function sanitizeBootstrapError(error: unknown): HerdrError {
  const code = error instanceof HerdrError && /^[A-Za-z0-9_.-]{1,80}$/.test(error.code) ? error.code : "bootstrap-probe-failed";
  const details = error instanceof HerdrError && error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : {};
  const exitCode = details.exitCode;
  const safeDetails = code === "cli-exit" && typeof exitCode === "number" && Number.isSafeInteger(exitCode) && exitCode >= 0 && exitCode <= 255 ? { exitCode } : undefined;
  const safe = new HerdrError(code, "Bootstrap inventory failed", safeDetails);
  return error && typeof error === "object" && "retryable" in error && error.retryable === true ? Object.assign(safe, { retryable: true }) : safe;
}

export function normalizeConfiguredClis(value: readonly ConfiguredCli[] | undefined): ConfiguredCli[] {
  const invalidRequest = () => { throw new HerdrError("invalid-bootstrap-request", "Invalid bootstrap probe request"); };
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) return invalidRequest();
  const paths = (item: unknown) => typeof item === "string" && item.length <= 4096 && posix.isAbsolute(item) && !/[\u0000-\u001f\u007f]/.test(item);
  const result = Array.from(value, item => {
    if (!item || typeof item !== "object" || typeof item.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(item.name) ||
        !paths(item.executable) || !(item.authFile === null || paths(item.authFile))) return invalidRequest();
    return { name: item.name, executable: item.executable, authFile: item.authFile };
  });
  if (new Set(result.map(item => item.name)).size !== result.length) return invalidRequest();
  return result;
}

export function normalizeCoreUnit(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*\.service$/.test(value) || value.length > 255) {
    throw new HerdrError("invalid-bootstrap-request", "Invalid bootstrap probe request");
  }
  return value;
}

/** Parse only the fields the fixed remote probe is permitted to return. */
export function parseBootstrapInventory(bytes: Buffer, peer: BootstrapPeer, expectedChecks: number, expectedCoreUnit: string | null): Inventory {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return invalid(); }
  if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "error")) {
    const failure = record(value, ["version", "kind", "error"]);
    if (failure.version !== 1 || failure.kind !== "inventory" || failure.error !== "bootstrap-probe-failed") return invalid();
    throw new HerdrError("bootstrap-probe-failed", "Remote bootstrap probe failed");
  }
  const envelope = record(value, ["version", "kind", "value"]);
  if (envelope.version !== 1 || envelope.kind !== "inventory") return invalid();
  const row = record(envelope.value, ["platform", "kernel", "nodeVersion", "nodeAbi", "gitVersion", "roaming", "systemdUser", "linger", "core",
    "pi", "piVersion", "softNofile", "hardNofile", "inotifyInstances", "inotifyWatches", "diskFreeBytes", "spider", "cli", "auth"]);
  if (typeof row.platform !== "string" || !/^[a-z0-9]{1,24}$/.test(row.platform) ||
      typeof row.kernel !== "string" || !/^[A-Za-z0-9_.+-]{1,128}$/.test(row.kernel) ||
      !version(row.nodeVersion) || typeof row.nodeAbi !== "string" || !/^\d{1,8}$/.test(row.nodeAbi) ||
      !nullableVersion(row.gitVersion) || !bool(row.systemdUser) || !nullableBool(row.linger) ||
      !(row.pi === null || typeof row.pi === "string" && row.pi === peer.pi && posix.isAbsolute(row.pi) && !/[\u0000-\u001f\u007f]/.test(row.pi)) ||
      !nullableVersion(row.piVersion) || row.pi === null && row.piVersion !== null ||
      !limit(row.softNofile) || !limit(row.hardNofile) ||
      !nullableCount(row.inotifyInstances) || !nullableCount(row.inotifyWatches) || !nullableCount(row.diskFreeBytes)) return invalid();
  if (typeof row.hardNofile === "number" && (row.softNofile === "unlimited" || typeof row.softNofile === "number" && row.softNofile > row.hardNofile)) return invalid();
  const roaming = record(row.roaming, ["rootExists", "rootSafe", "identityExists", "machineId"]);
  const unknown = roaming.rootExists === null && roaming.rootSafe === false && roaming.identityExists === null && roaming.machineId === null;
  const absent = roaming.rootExists === false && roaming.rootSafe === true && roaming.identityExists === false && roaming.machineId === null;
  const unsafe = roaming.rootExists === true && roaming.rootSafe === false && (roaming.identityExists === true || roaming.identityExists === null) && roaming.machineId === null;
  const existing = roaming.rootExists === true && roaming.rootSafe === true &&
    (roaming.identityExists === false && roaming.machineId === null || roaming.identityExists === true && (roaming.machineId === null || isMachineId(roaming.machineId)));
  if (!unknown && !absent && !unsafe && !existing) return invalid();
  const core = record(row.core, ["unit", "unitExists", "unitOwned", "socketExists", "socketOwned"]);
  if (!(core.unit === null || typeof core.unit === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*\.service$/.test(core.unit)) ||
      !bool(core.unitExists) || !bool(core.unitOwned) || !bool(core.socketExists) || !bool(core.socketOwned) ||
      !core.unitExists && (core.unit !== null || core.unitOwned) || core.unitOwned && core.unit === null || !core.socketExists && core.socketOwned ||
      expectedCoreUnit !== null && (core.unit !== null && core.unit !== expectedCoreUnit || core.unitExists && core.unit === null)) return invalid();
  const spider = record(row.spider, ["installed", "version", "nativeModuleReady"]);
  if (!bool(spider.installed) || !nullableVersion(spider.version) || !bool(spider.nativeModuleReady) ||
      !spider.installed && (spider.version !== null || spider.nativeModuleReady) || spider.installed && spider.version === null) return invalid();
  const cli = record(row.cli, ["gh", "gitIdentity", "configured"]);
  if (!bool(cli.gh) || !bool(cli.gitIdentity) || !Array.isArray(cli.configured) || cli.configured.length !== expectedChecks) return invalid();
  for (const item of cli.configured) {
    const check = record(item, ["executable", "auth"]);
    if (check.executable !== null) {
      const executable = record(check.executable, ["present", "readable", "modeSafe", "executable"]);
      if (!bool(executable.present) || !bool(executable.readable) || !bool(executable.modeSafe) || !bool(executable.executable) ||
          !executable.present && (executable.readable || executable.modeSafe || executable.executable)) return invalid();
    }
    if (check.auth !== null) file(check.auth);
  }
  const auth = record(row.auth, ["pi", "gh", "ghSignedIn"]);
  file(auth.pi); file(auth.gh);
  if (!nullableBool(auth.ghSignedIn) || !cli.gh && auth.ghSignedIn !== null) return invalid();
  return row as unknown as Inventory;
}
