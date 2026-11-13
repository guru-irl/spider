import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RoamConfig } from "./contracts";
import { isMachineId } from "./machine-id";
import { acquireSweepLease, acquireTransferLease, defaultStagingRoot, openOutgoingStaging, openStaging, privateDirectory } from "./staging";
import { sweepBatchFiles, type StoreAdapter } from "./stores";
export interface SweepReferences {
  now: number; root?: string; referenced(value: string): boolean; active(value: string): boolean;
  onProblem?(entry: string, error: unknown): void;
}
/** Startup supplies a complete journal-reference check. An unavailable check fails closed. */
export function sweepStoreArtifacts(stores: StoreAdapter, config: RoamConfig, references: SweepReferences): void {
  const problem = (entry: string, error: unknown) => {
    if (!references.onProblem) throw error;
    references.onProblem(entry, error);
  };
  const held = (value: string): boolean => {
    const referenced = references.referenced(value), active = references.active(value);
    if (typeof referenced !== "boolean" || typeof active !== "boolean") throw new Error("Artifact references are unavailable");
    return referenced || active;
  };
  const root = references.root ?? defaultStagingRoot();
  let releaseSweep: (() => void) | null = null;
  try {
    releaseSweep = acquireSweepLease(root, config.limits.peerConcurrency);
    if (releaseSweep) {
      for (const directory of stores.batchDirectories()) {
        try { sweepBatchFiles([directory], { now: references.now, maxAgeMs: config.limits.retentionMs,
          referenced: references.referenced, active: references.active }); }
        catch (error) { problem(directory, error); }
      }
      const outgoingRoot = join(root, "outgoing");
      try {
        if (existsSync(join(outgoingRoot, "quota.db"))) {
          const outgoing = openOutgoingStaging(root, config.limits, false);
          try { outgoing.sweep(references.now, held); } finally { outgoing.close(); }
        }
      } catch (error) { problem(outgoingRoot, error); }
    }
  } catch (error) { problem(root, error); }
  finally { releaseSweep?.(); }
  const incoming = join(root, "incoming");
  if (!existsSync(incoming)) return;
  privateDirectory(incoming);
  for (const peer of readdirSync(incoming)) {
    if (!isMachineId(peer)) continue;
    const directory = join(incoming, peer);
    let release: (() => void) | null = null;
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe incoming peer directory");
      release = acquireTransferLease(root, peer, config.limits.peerConcurrency); if (!release) continue;
      const file = join(directory, "quota.db");
      if (!existsSync(file)) continue;
      const staging = openStaging(root, peer, config.limits);
      try { staging.sweep(references.now, held); } finally { staging.close(); }
    } catch (error) { problem(directory, error); }
    finally { release?.(); }
  }
}
