import type { Readable, Writable } from "node:stream";
export const DEFAULT_COMMAND_TIMEOUT_MS: number;
export const DEFAULT_STARTUP_TIMEOUT_MS: number;
export const DEFAULT_CLOSE_TIMEOUT_MS: number;
export const CLOSE_GRACE_MS: number;
export type CdpMessage = { id?: number; method?: string; sessionId?: string; params?: any };
export type CdpTransport = {
  send(method: string, params?: object, sessionId?: string, commandTimeoutMs?: number): Promise<any>;
  onEvent(listener: (message: CdpMessage) => void): void;
  fail(error?: Error): void;
  close(): void;
};
export function errorDetail(value: unknown): string;
export function createCdpTransport(options: { input: Writable; output: Readable; timeoutMs?: number }): CdpTransport;
export function openCdpBrowser(options: { browser: string; profileDir: string; timeoutMs?: number; startupTimeoutMs?: number; closeTimeoutMs?: number; signal?: AbortSignal }): Promise<{
  pid: number;
  send: CdpTransport["send"];
  onEvent: CdpTransport["onEvent"];
  close(): Promise<void>;
}>;
