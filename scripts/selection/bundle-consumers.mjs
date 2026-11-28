// SPDX-License-Identifier: MIT

// Artifact observations are positive evidence, not proof that a test cannot
// read another bundle. Only reviewed, blob-pinned consumers may narrow the
// blanket. Tarball, package-layout and inventory checks stay on the blanket.
export const reviewedBundleConsumers = new Map();
const review = (file, blob, outputs, helpers = {}) => {
  reviewedBundleConsumers.set(file, { outputs, blobs: { [file]: blob, ...helpers } });
};

// These tests launch the broker via startTestBroker. The helper forwards the
// supplied command and args. Its other subprocesses query process identity;
// the fake clock and socket fixtures don't load another shipped program.
const intercom = 'packages/intercom/src/';
const broker = ['dist/intercom/broker.mjs'];
const brokerHelper = { [`${intercom}test-support.ts`]: '39689d028fa4dd7721ac7470d01417db30fb7d35' };
for (const [file, blob] of Object.entries({
  'broker/federation-roam.test.ts': '32c7b04e7c7a0d1256edca1c08f725927585eb0c',
  'broker/federation-socket.test.ts': 'b5651b68d9fdef15a07a76373bb0e2139d14b495',
  'broker/fixture-cleanup.test.ts': 'db5cad7fb39d721f86e61e95b0676c87f4a29ccd',
  'broker/helper-socket.test.ts': 'ce3893d5ab856592656477abedfaee43f9dca6f9',
  'broker/receipt-queue.test.ts': 'e3e44766574499d25a06f5ab337c48e30b25b515',
  'broker/receipt-replay.test.ts': '882af682b55dfe17f272c8abeea0f27166359e66',
  'receipt-replay-integration.test.ts': '362cd5f74dca9d41a451a206b36aa9198886baa6',
  'reconnect.test.ts': '5bc3227cf497dd7ecccfab73d78b4c0ad93130a1',
})) review(`${intercom}${file}`, blob, broker, brokerHelper);

const herdr = 'packages/herdr/src/__tests__/';
// The feed reader's server child re-executes the same entry. The warning
// case passes --bad and never opens a view. The complete viewer exercises
// the alternate path that imports the sibling viewer-pi module.
review(`${herdr}feed-reader-server.test.ts`, 'cc262220d92113b1a38285d6d003212a84e75bdc', ['dist/herdr/feed-reader.mjs']);
review(`${herdr}herdr-viewer-warning.test.ts`, 'a0ee54873782a38a000bfe7c638ae731baf13816', ['dist/herdr/viewer.mjs']);
review(`${herdr}viewer-entry.test.ts`, 'ce6e629b54051fb7f0a23c6f5d156c07a45647b3', ['dist/herdr/viewer.mjs', 'dist/herdr/viewer-pi.mjs']);
