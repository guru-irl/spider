import { isRoamUuid } from "@spider/db-core/roam/codec";
import type { StoreBarrier } from "@spider/db-core/roam/types";
import type { RoamConfig, StorePort } from "./contracts";
import type { StoreAdapter } from "./stores";

export async function barrierWatermarks(stores: StorePort, config: RoamConfig, required: readonly StoreBarrier[]): Promise<StoreBarrier[] | null> {
  const adapter = stores as Partial<StoreAdapter>;
  if (!adapter.head) return null;
  const result: StoreBarrier[] = [];
  for (const barrier of required) {
    if (!isRoamUuid(barrier.stream) || !Number.isSafeInteger(barrier.through) || barrier.through < 0) return null;
    const head = adapter.head(barrier.storeKey);
    if (head.stream === barrier.stream) { result.push(barrier); continue; }
    if (!config.peers.some(peer => stores.cursor(barrier.storeKey, peer.machineId, barrier.stream) >= barrier.through)) return null;
    result.push(head);
  }
  return result;
}
