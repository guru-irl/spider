import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RoamConfig } from "./contracts";
import { isMachineId } from "./machine-id";
import { acquireTransferLease, defaultStagingRoot, openOutgoingStaging, openStaging, privateDirectory } from "./staging";
import { sweepBatchFiles, type StoreAdapter } from "./stores";
export interface SweepReferences { now: number; referenced(value: string): boolean; active(value: string): boolean }
/** Startup supplies a complete journal-reference check. An unavailable check fails closed. */
export function sweepStoreArtifacts(stores: StoreAdapter, config: RoamConfig, references: SweepReferences): void {
  const held = (value: string): boolean => {
    const referenced = references.referenced(value), active = references.active(value);
    if (typeof referenced !== "boolean" || typeof active !== "boolean") throw new Error("Artifact references are unavailable");
    return referenced || active;
  };
  const root = defaultStagingRoot();
  sweepBatchFiles(stores.batchDirectories(), { now: references.now, maxAgeMs: config.limits.retentionMs,
    referenced: references.referenced, active: references.active });
  if (existsSync(join(root, "outgoing", "quota.db"))) {
    const outgoing = openOutgoingStaging(root, config.limits, false);
    try { outgoing.sweep(references.now, held); } finally { outgoing.close(); }
  }
  const incoming = join(root, "incoming");
  if (!existsSync(incoming)) return;
  privateDirectory(incoming);
  for (const peer of readdirSync(incoming)) {
    if (!isMachineId(peer) || !lstatSync(join(incoming, peer)).isDirectory() || lstatSync(join(incoming, peer)).isSymbolicLink()) continue;
    const release = acquireTransferLease(root, peer, config.limits.peerConcurrency); if (!release) continue;
    try {
      // Claims are reserved before any incoming bytes, so referenced operations remain protected.
      const file = join(incoming, peer, "quota.db");
      if (!existsSync(file) || lstatSync(file).isSymbolicLink()) continue;
      const staging = openStaging(root, peer, config.limits);
      try { staging.sweep(references.now, held); } finally { staging.close(); }
    } finally { release(); }
  }
}
