// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A deployed fixture entry for tests that replace source actions, not admission. */
export async function writeFixturePaneEndpoint(packageRoot: string): Promise<void> {
  const directory = join(packageRoot, 'dist/herdr');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'pane-endpoint.mjs'), 'export const createProductionPaneEndpointPorts = digest => ({protocol:1,buildDigest:digest}); export const runPaneEndpointCli = async (args, create) => {const p = await create(); return JSON.stringify({version:1,op:"handshake",protocol:p.protocol,buildDigest:p.buildDigest})};');
}
