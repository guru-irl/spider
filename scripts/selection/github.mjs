// SPDX-License-Identifier: MIT
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const options = { timeout: 45_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
const gh = (...args) => execFileSync('gh', args, options);
export function github(repo) {
  const api = (...args) => gh('api', `repos/${repo}/${args[0]}`, ...args.slice(1));
  const get = path => JSON.parse(api(path));
  const pages = path => JSON.parse(api(path, '--paginate', '--slurp'));
  return {
    get, pages,
    async artifact(runId, name, filename) {
      const artifacts = pages(`actions/runs/${runId}/artifacts?name=${name}&per_page=100`).flatMap(page => page.artifacts);
      const artifact = artifacts.find(item => item.name === name && !item.expired) ?? artifacts.find(item => item.name === name);
      if (!artifact) return null;
      return { expired: artifact.expired, publishedAt: artifact.created_at, read() {
        const dir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'selection-artifact-'));
        try {
          const archive = join(dir, 'artifact.zip');
          writeFileSync(archive, api(`actions/artifacts/${artifact.id}/zip`));
          // Read only the expected member, without extracting paths from the archive.
          return JSON.parse(execFileSync('unzip', ['-p', archive, filename], options));
        } finally { rmSync(dir, { recursive: true, force: true }); }
      } };
    },
  };
}
