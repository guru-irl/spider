// SPDX-License-Identifier: MIT
import { afterEach, it, vi } from 'vitest';
import { setGlobalDbPathForTests } from '@spider/db-core';
import { assertViewerRemainsPlaced } from './herdr-viewer-shutdown.testutil.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); setGlobalDbPathForTests(null); });

it.each(['resume', 'fork'] as const)('mounted %s leaves a displayed viewer in its exact pane', assertViewerRemainsPlaced, 30000);
