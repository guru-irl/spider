// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { join } from 'node:path';
import type { OwnerPlacement } from '../../../herdr/src/contracts.js';
import { paneId, parsePaneSlot, parsePaneTarget } from '../../../herdr/src/panes/codec.js';
import { samePaneTarget } from '../../../herdr/src/panes/lifecycle.js';
import type { PanePresentation } from '../../../herdr/src/panes/types.js';
import { privateDirectory, readPrivateJson, writePrivateJson } from '../../../herdr/src/sessions/registry.js';
export async function capturePaneHandoff(root: string, presentation: PanePresentation, source: OwnerPlacement | null, sourceFocused: boolean): Promise<void> {
  const directory = join(root, 'handoffs'); await privateDirectory(directory);
  await writePrivateJson(join(directory, paneId(presentation.id) + '.json'), { version: 1, presentationId: presentation.id, target: presentation.target, source, sourceFocused });
}
export async function readPaneHandoff(root: string, presentation: PanePresentation): Promise<{ source: OwnerPlacement | null; sourceFocused: boolean } | null> {
  try {
    const value = await readPrivateJson(join(root, 'handoffs', paneId(presentation.id) + '.json'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const r = value as Record<string, unknown>;
    if (r.version !== 1 || r.presentationId !== presentation.id || typeof r.sourceFocused !== 'boolean' || !samePaneTarget(parsePaneTarget(r.target), presentation.target)) return null;
    const source = r.source === null ? null : parsePaneSlot(r.source);
    if (source && source.pane === null) return null;
    return { source: source as OwnerPlacement | null, sourceFocused: r.sourceFocused };
  } catch { return null; }
}
