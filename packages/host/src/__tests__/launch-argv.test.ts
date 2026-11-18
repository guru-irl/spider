// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { explicitExtensionArguments } from '../herdr/ports.js';

it('does not interpret initial prompt arguments after the delimiter as extensions', () => {
  expect(explicitExtensionArguments(['node', 'pi', '--', '--extension', 'not-an-extension.ts'])).toEqual([]);
});
it('does not treat a name or system-prompt value as an extension flag', () => {
  expect(explicitExtensionArguments(['node', 'pi', '--name', '-e', '--system-prompt', '--extension'])).toEqual([]);
});
it('still identifies a real explicit extension beside other process options', () => {
  expect(explicitExtensionArguments(['node', 'pi', '--name', '-e', '--extension', 'extension.ts', '--tools', 'read'])).toEqual(['--extension', resolve('extension.ts')]);
});
