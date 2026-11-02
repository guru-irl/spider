import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Suite, AppDriver } from '../harness/suite.js';
import { HarnessError, type OwnedPath } from '../harness/environment.js';

export interface InstalledArtifacts {
  appHome: OwnedPath;
  layout: { path: OwnedPath; value: unknown };
  mods: Readonly<Record<string, OwnedPath>>;
  files: readonly { path: OwnedPath; bytes: Buffer }[];
}
export interface FreshInstallation { suite: Suite; app: AppDriver; installed: InstalledArtifacts; result: { exitCode: number; stdout: string; stderr: string } }
export async function installFresh(suite: Suite): Promise<FreshInstallation> {
  if (!existsSync(fileURLToPath(new URL('../fixtures/install-inputs.ts', import.meta.url)))) throw new HarnessError('missing-prerequisite', 'Task 2 installFresh/readInstalled helpers are required for the real first-installed look');
  const specifier = '../fixtures/install-inputs.js';
  const module = await import(/* @vite-ignore */ specifier) as { installFresh?: (suite: Suite) => Promise<FreshInstallation> };
  if (typeof module.installFresh !== 'function') throw new HarnessError('missing-adapter', 'Task 2 must export installFresh(suite)');
  return module.installFresh(suite);
}
