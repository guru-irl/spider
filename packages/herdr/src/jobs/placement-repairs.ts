// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash } from 'node:crypto';
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicPrivateWrite, readPrivateText } from '../feed/publisher.js';
import type { OwnerPlacement, TerminalAddress } from '../contracts.js';
export interface PlacementRepair { viewer: TerminalAddress; coreId: string; anchor: OwnerPlacement; placed?: OwnerPlacement; app: string; error: string }
type RepairKey = Pick<PlacementRepair, 'app' | 'coreId' | 'viewer'>;
const file = (root: string, key: RepairKey) => join(root, 'repairs', createHash('sha256').update(JSON.stringify([key.app, key.coreId, key.viewer])).digest('hex') + '.json');
export async function writePlacementRepair(root: string, repair: PlacementRepair): Promise<void> {
  await atomicPrivateWrite(file(root, repair), JSON.stringify(repair));
}
export async function clearPlacementRepair(root: string, key: RepairKey): Promise<void> {
  await unlink(file(root, key)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
}
export async function readPlacementRepairs(root: string): Promise<readonly PlacementRepair[]> {
  const directory = join(root, 'repairs');
  const files = await readdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; });
  return Promise.all(files.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(async name => JSON.parse(await readPrivateText(join(directory, name), 16384)) as PlacementRepair));
}
