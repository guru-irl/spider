import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
export default defineConfig({
  ssr: { target: 'node', noExternal: true },
  build: { ssr: 'packages/intercom/src/broker/broker.ts', target: 'node22', outDir: 'dist/intercom', emptyOutDir: true,
    minify: false, sourcemap: false,
    rolldownOptions: { external: id => builtins.has(id) || id.startsWith('node:'),
      output: { format: 'es', entryFileNames: 'broker.mjs', codeSplitting: false,
        banner: '/*! pi-intercom 0.13.0 fork. Copyright (c) 2026 Nico Bailon. MIT. See packages/intercom/LICENSE. */' } },
  },
});
