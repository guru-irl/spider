// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { IpcDescriptor, RunViewFrame, SessionFeed, SessionIpcEnvelope, SessionIpcReply, SessionIpcRequest } from '../../src/contracts.js';
export function parseFeed(text: string): SessionFeed | null;
export function panelIpcArgv(nodePath: string, cliPath: string, descriptor: IpcDescriptor, request: SessionIpcRequest): string[];
export function parsePanelIpcArgv(argv: readonly string[]): { nodePath: string; cliPath: string; descriptor: IpcDescriptor; request: SessionIpcRequest } | null;
export function parseSessionIpcRequest(line: string): SessionIpcRequest | null;
export function parseSessionIpcEnvelope(line: string): SessionIpcEnvelope | null;
export function parseSessionIpcReply(line: string): SessionIpcReply | null;
export function parseRunViewFrame(line: string): RunViewFrame | null;
export function middlePath(path: string, max: number): string;
