// SPDX-License-Identifier: MIT
import type { ModApi } from '../../scripts/generate-mod-api.mjs';
export const modApi: ModApi;
export function createUiModules(): Record<string, Record<string, any>>;
export function createHostModule(ports: Record<string, any>): Record<string, (...args: any[]) => any>;
export function initArgument(): Record<string, never>;
export function initView<T extends { init(first: unknown, cx: any): unknown }>(view: T, cx: any): T;
export function strictInit<T extends { init(first: unknown, cx: any): unknown }>(view: T): T;
