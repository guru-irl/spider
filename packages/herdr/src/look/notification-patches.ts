// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { LookPatch } from './patches.js';

export const notificationAgentPatches: readonly LookPatch[] = [
  {
    id: 'a-notification-import',
    anchor: 'function find(node, id) {',
    replacement: 'import { createNotificationSound } from "./sound.js";\nimport { playSound as spiderPlaySound } from "herdr";\nfunction find(node, id) {',
  },
  {
    id: 'a-notification-arrival',
    anchor: '      this.spiderFeedError = loaded.errors[0]?.message ?? null;',
    replacement: '      this.spiderFeedError = loaded.errors[0]?.message ?? null;\n      this.spiderNotificationSound ??= createNotificationSound({ shared, setShared, playSound: spiderPlaySound, props: spiderProps, report: message => { this.spiderFeedError = message; } });\n      this.spiderNotificationSound.observe(loaded);',
  },
];
