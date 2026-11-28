// SPDX-License-Identifier: MIT

// Artifact observations are positive evidence, not proof that a test cannot
// read another bundle. Only reviewed, blob-pinned consumers may narrow the
// blanket. Tarball, package-layout and inventory checks stay on the blanket.
export const reviewedBundleConsumers = new Map();
