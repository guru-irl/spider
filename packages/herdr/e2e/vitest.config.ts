import { defineConfig, type ViteUserConfig } from 'vitest/config';
// @ts-ignore Configuration-time JavaScript helper is exercised by focused tests.
import { harnessIncludes, auditHarnessFiles } from './controls/harness-discovery.mjs';

auditHarnessFiles(process.cwd());
const invocation = Boolean(process.env.SPIDER_HERDR_E2E_RUN_ROOT);
const options = JSON.parse(process.env.SPIDER_HERDR_E2E_OPTIONS ?? '{}') as { harness?: boolean; tier?: string };
const config: ViteUserConfig = defineConfig({
  test: {
    setupFiles: ['./packages/herdr/e2e/setup.ts'],
    include: invocation
      ? ['packages/herdr/e2e/scenarios/runner-stories.test.ts', ...(options.harness ? harnessIncludes : [])]
      : harnessIncludes,
    pool: 'forks',
    maxWorkers: 2,
    fileParallelism: options.tier !== 'app',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    teardownTimeout: 15_000,
    retry: 0,
  },
});
export default config;
