// SPDX-License-Identifier: MIT
import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';

const entries = {
  cli: 'packages/herdr/src/bin/cli.ts',
  'feed-reader': 'packages/herdr/src/bin/feed-reader.ts',
  viewer: 'packages/herdr/src/bin/viewer.ts',
  'viewer-pi': 'packages/herdr/src/viewers/pi-main.ts',
  'remote-runtime': 'packages/herdr/src/remote/runtime.ts',
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
    // Bundling collapses import.meta.url to the entry URL. This structural
    // marker keeps C's library imports from becoming additional main programs.
    define: { 'import.meta.spiderHerdrRuntimeEntry': mode === 'remote-runtime' ? 'true' : 'false' },
    ssr: { target: 'node', noExternal: true },
    build: {
      target: 'node22', outDir: 'dist/herdr', emptyOutDir: mode === 'cli',
      minify: false, sourcemap: false, ssr: entry,
      rollupOptions: {
        external: id => builtins.has(id) || peers.some(peer => id === peer || id.startsWith(`${peer}/`)),
        output: {
          format: 'es', entryFileNames: `${mode}.mjs`, codeSplitting: false,
          banner: `/*! SPDX-License-Identifier: MIT — Herdr runtime. See NOTICE.md. SPIDER_HERDR_RUNTIME_ENTRY=${mode === 'remote-runtime'} */`,
        },
      },
    },
  };
});
