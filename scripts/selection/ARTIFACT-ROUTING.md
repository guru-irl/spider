# Artifact routing in the test selector

Selection maps can carry an optional `bundleRouting` section. The recorder keeps writing the same v2 test records. `bundleRouting` adds two lists of facts:

- An artifact record names a `dist/` file, its entry, its SHA-256, and the repository files in its build. A single-entry build reports its resolved module IDs before tree shaking and its Vite config dependencies. The build archives the manifest beside the sourcemap, outside `dist/`.
- A test observation lists the hashes of shipped artifacts it used. It joins checkout reads and copy sources by exact `dist/` path, and joins executed copies by SHA-256. A directory inventory or an unidentified artifact keeps the observation ambiguous.

The selector adds observed readers when an artifact's old build inputs or its entry change, or when the head import graph reaches its entry. It still selects static importers, explicit resource consumers, and unresolved fixtures independently.

A passed test can lose the blanket bundle-reader reason only if all of these conditions hold:

1. The recording is complete and has no unidentified or unresolved artifact.
2. The observation matches every output in `bundle-consumers.mjs` for that test. The test and audited launch helper blobs match the recording and have not changed.
3. No affected artifact matches those outputs. The head checkout has each output at the recorded SHA-256.
4. The only changes are modifications to package code. Additions, deletions, resources, and build changes cannot remove the blanket. Toolchain and selector changes still select the full inventory.

The audit matters because a recording cannot observe paths a test did not take, or every native read. When adding a contract, inspect every path that reads, copies, hashes, or launches shipped bytes, including helpers and subprocesses. List all possible outputs. Leave package-layout checks and tests with unknown branches on the blanket. A change to a reviewed test or launcher invalidates its contract without blocking CI.

Run `node --test scripts/selection/test-bundles.test.mjs` for a real build and recorder check. Run `node --test scripts/selection/select.test.mjs` for selector behavior. A map without the optional section still uses the original policy.
