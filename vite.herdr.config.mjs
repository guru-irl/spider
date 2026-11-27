// SPDX-License-Identifier: MIT
import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';
import { archiveMaps, sourcemap } from './scripts/tia/build-maps.mjs';

const entries = {
  cli: 'packages/herdr/src/bin/cli.ts',
  'pane-endpoint': 'packages/host/src/herdr/bin/pane-endpoint-main.ts',
  'feed-reader': 'packages/herdr/src/bin/feed-reader.ts',
  viewer: 'packages/herdr/src/bin/viewer.ts',
  'viewer-pi': 'packages/herdr/src/viewers/pi-main.ts',
  'remote-runtime': 'packages/herdr/src/remote/runtime-entry.ts',
  'subagent-supervisor': 'packages/subagents/src/supervisor-main.ts',
};
const peers = [
  'better-sqlite3', 'sqlite-vec', 'onnxruntime-node', 'onnxruntime-web', 'fastembed',
  '@huggingface/transformers', '@xenova/transformers', 'turndown',
  '@earendil-works/pi-ai', '@earendil-works/pi-agent-core', '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-tui', 'typebox',
];
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
export default defineConfig(({ mode }) => {
  const entry = entries[mode];
  if (!entry) throw new Error(`Unknown Herdr build entry: ${mode}`);
  return {
    plugins: archiveMaps('herdr'),
    ssr: { target: 'node', noExternal: true },
    build: {
      target: 'node22', outDir: 'dist/herdr', emptyOutDir: mode === 'cli',
      minify: false, sourcemap, ssr: entry,
      rollupOptions: {
        external: id => builtins.has(id) || peers.some(peer => id === peer || id.startsWith(`${peer}/`)),
        output: {
          format: 'es', entryFileNames: `${mode}.mjs`, codeSplitting: false,
          banner: `/*! SPDX-License-Identifier: MIT — Herdr runtime. See NOTICE.md. SPIDER_HERDR_RUNTIME_ENTRY=${mode === 'remote-runtime'} SPIDER_PANE_ENDPOINT_ENTRY=${mode === 'pane-endpoint'} */`,
        },
      },
    },
  };
});
