import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { assertTestConfigPath, openDb, type Db } from "@spider/db-core";
import { readMachineIdentity } from "@spider/db-core/roam/machine";
import { createAgentPorts } from "./agent";
import { loadConfig } from "./config";
import type { AgentPorts, RoamConfig } from "./contracts";
import { openJournal, type ArtifactJournal } from "./journal";
import { createStorePort, type StoreAdapter } from "./stores";

export interface LocalCore { root: string; config: RoamConfig; db: Db; close(): void }
export interface LocalRuntime extends LocalCore { journal: ArtifactJournal; stores: StoreAdapter; agent: AgentPorts }

function existingFile(file: string, optional = false): void {
  let stat;
  try { stat = lstatSync(file); }
  catch (error) { if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || typeof process.getuid === "function" && stat.uid !== process.getuid())
    throw new Error("Unsafe roaming file");
}

/** Observe the configured machine without repairing permissions or creating files. */
export function readLocalIdentity(root: string): RoamConfig {
  if (!isAbsolute(root) || resolve(root) !== realpathSync(root)) throw new Error("Unsafe roaming root");
  const directory = join(root, "roam"), configFile = join(directory, "config.json"), identityFile = join(directory, "machine.json");
  assertTestConfigPath(configFile); assertTestConfigPath(identityFile);
  const dir = lstatSync(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || realpathSync(directory) !== directory ||
      typeof process.getuid === "function" && dir.uid !== process.getuid() ||
      process.platform !== "win32" && (dir.mode & 0o777) !== 0o700) throw new Error("Unsafe roaming directory");
  existingFile(configFile);
  const config = loadConfig(configFile);
  const fd = openSync(identityFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096 ||
        typeof process.getuid === "function" && stat.uid !== process.getuid() ||
        process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) throw new Error("Unsafe machine identity");
    const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value) || (value as { machineId?: unknown }).machineId !== config.machineId)
      throw new Error("Machine identity does not match configuration");
  } finally { closeSync(fd); }
  return config;
}

/** This never creates a replacement identity or migrates an existing store. */
export function openLocalCore(root: string): LocalCore {
  if (!isAbsolute(root) || resolve(root) !== realpathSync(root)) throw new Error("Unsafe roaming root");
  const configFile = join(root, "roam", "config.json"), file = join(root, "spider.db");
  assertTestConfigPath(configFile); assertTestConfigPath(file);
  existingFile(configFile); existingFile(file); existingFile(`${file}-wal`, true); existingFile(`${file}-shm`, true);
  const config = loadConfig(configFile);
  if (readMachineIdentity(root) !== config.machineId) throw new Error("Machine identity does not match configuration");
  const db = openDb(file, { fileMustExist: true, checkpointOnClose: false, maxCoreSchemaVersion: 14 });
  try {
    if (Number(db.pragma("user_version")) !== 14) throw new Error("Unsupported global store schema");
    const meta = db.prepare("SELECT machine_id FROM roam_meta WHERE id=1").get() as { machine_id?: unknown } | undefined;
    if (!meta || meta.machine_id !== config.machineId) throw new Error("Global store identity does not match configuration");
    return { root, config, db, close() { db.close(); } };
  } catch (error) { db.close(); throw error; }
}

export function openLocalRuntime(root: string): LocalRuntime {
  const core = openLocalCore(root);
  try {
    const stores = createStorePort(core.config, core.db, { allowUnassignedGlobal: true });
    try {
      const journal = openJournal(join(root, "roam", "journal.db"));
      const agent = createAgentPorts({ config: core.config, journal, openStore: stores.openStore, root: join(root, "roam", "staging") });
      return { ...core, journal, stores, agent, close() { stores.close(); core.close(); } };
    } catch (error) { stores.close(); throw error; }
  } catch (error) { core.close(); throw error; }
}
