// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { test } from 'vitest';
import { model } from './setup-checkpoint-model.js';

test('N1 minimal: setup → settings → bookkeeping → undo', () => model(['setup', 'settings', 'bookkeeping', 'undo'], false));
test('N2 minimal: setup → remote → undo', () => model(['setup', 'remote', 'undo'], false));
test('N6 minimal: setup → undo → full rollback', () => model(['setup', 'undo', 'rollback'], false));
test('N2 minimal: failed join → killed retry → undo retains the original layout', () => model(['setup', 'cutover-crash', 'batch-crash', 'undo'], false));
test('N4 minimal: setup → shell → interrupted undo → shell → undo', () => model(['setup', 'shell', 'undo-crash', 'shell', 'undo'], false));
test('N1 role templates: setup → pi → bookkeeping → undo', () => model(['setup', 'pi', 'bookkeeping', 'undo'], false));
test('N1 runtime writer: setup → pi → undo', () => model(['setup', 'pi', 'undo'], false));
test('N3 references: setup → layout-reference → undo', () => model(['setup', 'layout-reference', 'undo'], false));
test('N3 unchanged store: setup → undo', () => model(['setup', 'undo'], false));
test('N3 changed store: setup → app → undo', () => model(['setup', 'app', 'undo'], false));
test('N4 verified pi writer: setup → pi-during-undo → undo', () => model(['setup', 'pi-during-undo', 'undo'], false));
