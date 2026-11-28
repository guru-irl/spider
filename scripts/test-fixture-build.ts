// SPDX-License-Identifier: MIT
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { InputOptions, Plugin } from 'rolldown';
import type { InlineConfig } from 'vite';
import { registerFixtureMap } from './selection/build-maps.mjs';

type RecordInputs = (ids: string[]) => string[];

function observeBundleInputs(): Plugin | undefined {
  const record = (globalThis as Record<symbol, RecordInputs | undefined>)[Symbol.for('spider.selection.bundle-inputs')];
  if (!record) return;
  let sources: string[] = [];
  return {
    name: 'selection-observe-test-bundle',
    buildStart() { record([]); },
    buildEnd() { sources = record([...this.getModuleIds()]).map(path => pathToFileURL(path).href); },
    generateBundle({ dir, file }, outputs) {
      for (const chunk of Object.values(outputs)) {
        if (chunk.type !== 'chunk') continue;
        // A test may rename or copy the output. Register the same source list
        // against its bytes without adding a source map to the output tree.
        registerFixtureMap(resolve(dir ?? (file ? dirname(file) : '.'), chunk.fileName), chunk.code, { sources });
      }
    },
  };
}

/** Keep the same build behavior, including write:false and watch builds. */
export async function buildViteFixture(options: InlineConfig = {}): ReturnType<typeof import('vite').build> {
  const { build } = await import('vite');
  const observe = observeBundleInputs();
  return build(observe ? { ...options, plugins: [...(options.plugins ?? []), observe] } : options);
}

export async function rolldownFixture(options: InputOptions): ReturnType<typeof import('rolldown').rolldown> {
  const { rolldown } = await import('rolldown');
  const observe = observeBundleInputs();
  return rolldown(observe ? { ...options, plugins: [options.plugins, observe] } : options);
}
