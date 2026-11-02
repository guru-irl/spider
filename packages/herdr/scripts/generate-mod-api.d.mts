// SPDX-License-Identifier: MIT
export interface ModApi { modules: Record<string, string[]>; elements: Record<string, string[]>; }
export function generateModApi(herdr: string, gpui: string): ModApi;
export function assertApiMatches(actual: ModApi, expected: ModApi): void;
