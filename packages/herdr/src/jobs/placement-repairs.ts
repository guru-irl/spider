// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash } from 'node:crypto';
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicPrivateWrite, readPrivateText } from '../feed/publisher.js';
import type { OwnerPlacement, TerminalAddress } from '../contracts.js';
export interface PlacementRepair { viewer: TerminalAddress; coreId: string; anchor: OwnerPlacement; placed?: OwnerPlacement; app: string; error: string }
type RepairKey = Pick<PlacementRepair, 'app' | 'coreId' | 'viewer'>;
export const placementRepairPath = (root: string, key: RepairKey): string => join(root, 'repairs', createHash('sha256').update(JSON.stringify([key.app, key.coreId, key.viewer])).digest('hex') + '.json');
export async function writePlacementRepair(root: string, repair: PlacementRepair): Promise<void> {
  await atomicPrivateWrite(placementRepairPath(root, repair), JSON.stringify(repair));
}
export async function clearPlacementRepair(root: string, key: RepairKey): Promise<void> {
  await unlink(placementRepairPath(root, key)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
}
export async function readPlacementRepairs(root: string): Promise<readonly PlacementRepair[]> {
  const directory = join(root, 'repairs');
  const files = await readdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; });
  return Promise.all(files.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(async name => JSON.parse(await readPrivateText(join(directory, name), 16384)) as PlacementRepair));
}

export interface PlacementRepairInspection {
  app: string;
  coreId: string;
  placement(viewer: TerminalAddress): Promise<OwnerPlacement | null>;
}
export async function activePlacementRepairs(root: string, inspection: PlacementRepairInspection): Promise<readonly PlacementRepair[]> {
  const active: PlacementRepair[] = [];
  for (const repair of await readPlacementRepairs(root)) {
    const sameIdentity = repair.app === inspection.app && repair.coreId === inspection.coreId;
    const placed = sameIdentity ? await inspection.placement(repair.viewer) : null;
    if (!placed || repair.placed && (placed.pane !== repair.placed.pane || placed.tab !== repair.placed.tab || placed.space !== repair.placed.space)) await clearPlacementRepair(root, repair);
    else active.push(repair);
  }
  return active;
}
