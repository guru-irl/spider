// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { vi } from 'vitest';
import { registerSetupCleanup } from './setup-fixture.js';
import { registerPublicationCases } from './setup-backup-recovery-publication.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, chmod: vi.fn(actual.chmod), readFile: vi.fn(actual.readFile), rename: vi.fn(actual.rename), link: vi.fn(actual.link), open: vi.fn(actual.open), unlink: vi.fn(actual.unlink) };
});
registerSetupCleanup();
registerPublicationCases('after');
