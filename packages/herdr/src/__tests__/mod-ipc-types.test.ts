// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { test } from 'vitest';
import type * as Shared from '../../assets/shared/feed.js';
import type * as Contracts from '../contracts.js';

type Signatures = {
  panelIpcArgv: (nodePath: string, cliPath: string, descriptor: Contracts.IpcDescriptor, request: Contracts.SessionIpcRequest) => string[];
  parsePanelIpcArgv: (argv: readonly string[]) => { nodePath: string; cliPath: string; descriptor: Contracts.IpcDescriptor; request: Contracts.SessionIpcRequest } | null;
  parseSessionIpcRequest: (line: string) => Contracts.SessionIpcRequest | null;
  parseSessionIpcEnvelope: (line: string) => Contracts.SessionIpcEnvelope | null;
  parseSessionIpcReply: (line: string) => Contracts.SessionIpcReply | null;
  parseRunViewFrame: (line: string) => Contracts.RunViewFrame | null;
};
type Declared = Pick<typeof Shared, keyof Signatures>;
type Exported = Pick<typeof Contracts, keyof Signatures>;
type Assert<T extends true> = T;
export type ModIpcSignatureChecks = [
  Assert<Declared extends Signatures ? true : false>,
  Assert<Signatures extends Declared ? true : false>,
  Assert<Exported extends Signatures ? true : false>,
  Assert<Signatures extends Exported ? true : false>,
];

test('installed asset declarations agree with canonical IPC types in both directions', () => {});
