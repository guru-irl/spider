// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan

export type SpaceSnapshot = { machine: string | null; index: number };
export function localSpaces<T extends { machine: string | null }>(spaces: readonly T[]): T[];
export function localSpaceRows<T extends SpaceSnapshot>(spaces: readonly T[]): { space: T; index: number; tree: null }[];
export function localSpaceCreateArgs(): { machine: '' };
