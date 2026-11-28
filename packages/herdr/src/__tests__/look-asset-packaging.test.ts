// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('packs the native, pane-enabled, and 0.1.18 look assets', () => {
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }));
  const files = pack.files.map((file: { path: string }) => file.path);
  const required = [
    'packages/herdr/assets/look/spaces-a-sidebar/agents-0.1.18.json',
    'packages/herdr/assets/look/spaces-a-sidebar/spaces-0.1.18.json',
    'packages/herdr/assets/look/spaces-a-sidebar/tabs-0.1.18.json',
    'packages/herdr/assets/look/spaces-a-goto/menu-0.1.18.json',
    'packages/herdr/assets/toast/main-0.1.18.js',
    'packages/herdr/assets/look/native-navigation-0.1.16.json',
    'packages/herdr/assets/look/native-panel-0.1.16.json',
    'packages/herdr/assets/look/native-picker-0.1.16.json',
    'packages/herdr/assets/look/pane-navigation-b.json',
    'packages/herdr/assets/look/pane-panel-b.json',
    'packages/herdr/assets/look/pane-picker-b.json',
    'packages/herdr/assets/shared/pane-service-state.js',
  ];
  expect(required.filter(path => !files.includes(path))).toEqual([]);
});
