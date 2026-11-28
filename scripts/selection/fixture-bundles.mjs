// SPDX-License-Identifier: MIT
import { basename } from 'node:path';

// The staged pane endpoint name contains the SHA-256 of a standalone stub.
// These writers inline the same module. It has no imports.
const paneStub = 'pane-endpoint-8926a2faecbd602f6fec0248b87f80e8fea3dde43555c852f2a34ef475148463.mjs';
const paneWriters = [
  'packages/herdr/src/__tests__/endpoint-fixture.ts',
  'packages/host/src/__tests__/herdr-setup-fixture.ts',
  'packages/host/src/__tests__/herdr-wiring-fixture.ts',
];

// Manually checked build recipes. If the builder in the map's Git tree
// changes, its outputs fall back until there is a source map or a new recipe.
const recipes = [
  {
    builder: 'packages/herdr/src/__tests__/production-cutover-fixture.ts',
    blob: '22410c6e6d8cd2ad45964b01b2fa39c938f277b3',
    output: /^cli\.mjs$/,
    directory: /\/dist\/herdr\/[^/]+$/,
    // The builder writes a TypeScript entry with these imports as strings.
    entries: [
      'packages/host/src/herdr/ports.ts',
      'packages/herdr/src/setup/cli.ts',
      'packages/herdr/src/setup/installer.ts',
      'packages/herdr/src/spaces/setup.ts',
      'packages/herdr/src/client/hc.ts',
      'packages/herdr/src/sessions/register.ts',
      'packages/herdr/src/sessions/registry.ts',
      'packages/herdr/src/feed/publisher.ts',
      'packages/subagents/src/process-identity.ts',
    ],
  },
  {
    builder: 'packages/host/src/__tests__/herdr-wiring-fixture.ts',
    blob: 'b209b9382a714bca041da4a50e348a926776e4d6',
    output: /^(?:cli\.mjs|viewer(?:-main)?\.mjs|ports-[\w-]+\.js)$/,
    directory: /\/dist\/herdr\/(?:assets\/)?[^/]+$/,
    // Shared chunks can come from either entry. The viewer wrapper runs the
    // same viewer entry in another process.
    entries: ['packages/herdr/src/bin/cli.ts', 'packages/herdr/src/bin/viewer.ts'],
  },
  {
    builder: 'packages/host/src/__tests__/copy-button-entry.test.ts',
    blob: '76292c563bb1a50fd9a1733d2a6bc2a11f497b71',
    output: /^extension\.js$/,
    directory: /\/case-[^/]+\/dist\/extension\.js$/,
    // This fake extension returns the bridge's ports. The bridge and other
    // runtime code continue to use the normal recorded and resource rules.
    entries: [],
  },
];

export const fixtureBuilders = recipes.map(recipe => recipe.builder);
export const fixtureEntries = [...new Set(recipes.flatMap(recipe => recipe.entries))];

// null is an unknown dependency set. One unknown output makes the test fall
// back even if we can scope every other output it ran.
export function fixtureScope(paths, reads, blobs) {
  const entries = new Set();
  for (const path of paths) {
    if (!path.startsWith('<tmp>/')) return null;
    const name = basename(path);
    // Older maps used just the basename for temporary outputs. For outputs
    // without a digest this still requires a matching recorded builder.
    const legacy = path === `<tmp>/${name}`;
    if (name === paneStub && (legacy || path.endsWith(`/dist/herdr/${name}`))
      && paneWriters.some(writer => reads.has(writer))) continue;
    const candidates = recipes.filter(recipe => reads.has(recipe.builder) && recipe.output.test(name)
      && (legacy || recipe.directory.test(path)));
    if (candidates.length !== 1 || blobs.get(candidates[0].builder) !== candidates[0].blob) return null;
    for (const entry of candidates[0].entries) entries.add(entry);
  }
  return entries;
}
