import { readdirSync } from 'node:fs';
import path from 'node:path';

export const harnessIncludes = [
  'packages/herdr/e2e/harness/**/*.test.ts',
  'packages/herdr/e2e/native/**/*.test.ts',
  'packages/herdr/e2e/controls/**/*.test.ts',
  'packages/herdr/e2e/fixtures/**/*.test.ts',
  'packages/herdr/e2e/scenarios/runner-contract.test.ts',
];
function patternRegex(pattern) {
  const escape = value => value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + pattern.split('/').map((segment, index, all) => segment === '**' ? '(?:[^/]+/)*' : segment.split('*').map(escape).join('[^/]*') + (index === all.length - 1 ? '' : '/')).join('') + '$');
}
export function assertHarnessCoverage(files, includes = harnessIncludes) {
  const patterns = includes.map(patternRegex);
  for (const file of files) {
    const normalized = file.replaceAll(path.sep, '/');
    if (patterns.some(pattern => pattern.test(normalized))) continue;
    throw new Error(`uncovered harness test: ${normalized}; add it to the dedicated configuration`);
  }
}
export function auditHarnessFiles(checkout) {
  const files = [];
  const walk = directory => {
    for (const entry of readdirSync(path.join(checkout, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`symlink e2e test path: ${file}`);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) files.push(file);
    }
  };
  walk('packages/herdr/e2e');
  // Direct scenario modules are loaded centrally, not ordinary harness tests.
  const harnessFiles = files.filter(file => !/^packages\/herdr\/e2e\/scenarios\/[^/]+\.test\.ts$/.test(file) || file === harnessIncludes.at(-1));
  assertHarnessCoverage(harnessFiles);
  return harnessFiles.sort();
}
