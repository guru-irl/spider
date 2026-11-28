import type { Plugin } from 'vite';
export const fixtureMaps: boolean;
export function archiveFixtureMaps(): Plugin[];
export function registerFixtureMap(compiled: string, text: string, payload: { sources: string[] }): void;
