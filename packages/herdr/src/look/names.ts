// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { join } from 'node:path';

export const SPIDER_LAYOUT = 'Spider';
export const LEGACY_SPIDER_LAYOUT = 'spider-glass';
export const SPIDER_LAYOUT_KEYS: `layout:${typeof SPIDER_LAYOUT}` = `layout:${SPIDER_LAYOUT}`;
export const LEGACY_SPIDER_LAYOUT_KEYS: `layout:${typeof LEGACY_SPIDER_LAYOUT}` = `layout:${LEGACY_SPIDER_LAYOUT}`;
export const SPIDER_LAYOUT_FILE: `${typeof SPIDER_LAYOUT}.json` = `${SPIDER_LAYOUT}.json`;
export const LEGACY_SPIDER_LAYOUT_FILE: `${typeof LEGACY_SPIDER_LAYOUT}.json` = `${LEGACY_SPIDER_LAYOUT}.json`;
export const spiderLayoutPath = (home: string): string => join(home, 'layouts', SPIDER_LAYOUT_FILE);
export const legacySpiderLayoutPath = (home: string): string => join(home, 'layouts', LEGACY_SPIDER_LAYOUT_FILE);
export const layoutSelectionPath = (home: string): string => join(home, 'shared.json');
