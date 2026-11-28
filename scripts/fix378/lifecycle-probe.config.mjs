export default {
  root: process.env.WPKG_PROBE_ROOT,
  test: { include: ['lifecycle.test.ts'], exclude: [], environment: 'node' },
};
