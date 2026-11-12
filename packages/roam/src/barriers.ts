import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { isRoamUuid } from "@spider/db-core/roam/codec";
import type { StoreBarrier } from "@spider/db-core/roam/types";
import type { RoamConfig, StorePort } from "./contracts";

export async function barrierWatermarks(stores: StorePort, config: RoamConfig, required: readonly StoreBarrier[]): Promise<StoreBarrier[] | null> {
  const result: StoreBarrier[] = [];
  for (const barrier of required) {
    if (!isRoamUuid(barrier.stream) || !Number.isSafeInteger(barrier.through) || barrier.through < 0) return null;
    let after = 0;
    let localStream: string | null = null;
    for (;;) {
      const batch = await stores.export(barrier.storeKey, after, config.limits.targetBatchBytes, randomUUID());
      try {
        if (batch.header.senderMachine !== config.machineId || batch.header.storeKey !== barrier.storeKey || batch.header.after !== after) return null;
        localStream = batch.header.senderStream;
        if (localStream === barrier.stream) { result.push(barrier); break; }
        // Observe the source cursor before choosing a relay watermark.
        if (after === 0 && !config.peers.some(peer => stores.cursor(barrier.storeKey, peer.machineId, barrier.stream) >= barrier.through)) return null;
        after = batch.header.through;
        if (batch.header.count === 0) { result.push({ storeKey: barrier.storeKey, stream: localStream, through: after }); break; }
      } finally { if (existsSync(batch.file)) unlinkSync(batch.file); }
    }
  }
  return result;
}
