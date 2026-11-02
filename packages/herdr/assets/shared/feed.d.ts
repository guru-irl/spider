// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { IpcDescriptor, RunViewFrame, SessionFeed, SessionIpcEnvelope, SessionIpcReply, SessionIpcRequest } from '../../src/contracts.js';
export const FEED_DISCONNECT_MS: number;
export const FEED_REFRESH_MS: number;
export function parseFeed(text: string): SessionFeed | null;
export function applyFeedHeartbeat(feed: SessionFeed, text: string | null): SessionFeed;
export function createFeedReader(config: { nodePath: string; cliPath: string; feedRoot: string }, ports: {
  exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  fetch(url: string, options: { method: string; headers: Record<string, string>; body: string }): Promise<{ ok: boolean; json(): Promise<unknown> }>;
  timer: { every(ms: number, callback: () => void): { cancel(): void } };
}): { read(): Promise<{ feeds: SessionFeed[]; errors: { source: string; message: string }[] }>; close(): Promise<void> };
export function panelIpcArgv(nodePath: string, cliPath: string, descriptor: IpcDescriptor, request: SessionIpcRequest): string[];
export function parsePanelIpcArgv(argv: readonly string[]): { nodePath: string; cliPath: string; descriptor: IpcDescriptor; request: SessionIpcRequest } | null;
export function parseSessionIpcRequest(line: string): SessionIpcRequest | null;
export function parseSessionIpcEnvelope(line: string): SessionIpcEnvelope | null;
export function parseSessionIpcReply(line: string): SessionIpcReply | null;
export function parseRunViewFrame(line: string): RunViewFrame | null;
export function middlePath(path: string, max: number): string;
