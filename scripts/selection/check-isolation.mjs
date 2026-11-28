// SPDX-License-Identifier: MIT
export function isolationProblems(records) {
  const forks = new Map();
  const problems = [];
  for (const [file, { workerPids }] of Object.entries(records)) {
    if (workerPids.length !== 1) {
      problems.push(`Expected one Vitest fork for ${file}, found ${workerPids.length}`);
      continue;
    }
    const [pid] = workerPids;
    if (forks.has(pid)) problems.push(`Vitest fork ${pid} ran both ${forks.get(pid)} and ${file}`);
    else forks.set(pid, file);
  }
  return problems;
}
