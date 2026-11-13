import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

const checkout = realpathSync(process.cwd());
const scratch = path.join(checkout, '.spider', 'scratch');
for (const candidate of [path.join(checkout, '.spider'), scratch]) {
  mkdirSync(candidate, { recursive: true, mode: 0o700 });
  if (lstatSync(candidate).isSymbolicLink() || realpathSync(candidate) !== candidate) throw new Error('e2e scratch must not contain symlinks');
}
const root = process.env.SPIDER_HERDR_E2E_RUN_ROOT ?? path.join(scratch, 'e2-tests');
if (!root.startsWith(scratch + path.sep)) throw new Error('e2e run root outside checkout scratch');
mkdirSync(root, { recursive: true, mode: 0o700 });
if (realpathSync(root) !== root || (process.getuid && lstatSync(root).uid !== process.getuid())) throw new Error('e2e root is not owned');
const tmp = path.join(root, 'tmp');
mkdirSync(tmp, { recursive: true, mode: 0o700 });
if (realpathSync(tmp) !== tmp) throw new Error('e2e TMPDIR must not contain symlinks');
const globalRoot = path.join(root, 'vitest-global');
mkdirSync(globalRoot, { recursive: true, mode: 0o700 });
const globalStat = lstatSync(globalRoot);
if (!globalStat.isDirectory() || globalStat.isSymbolicLink() || realpathSync(globalRoot) !== globalRoot ||
    (globalStat.mode & 0o077) !== 0 || (process.getuid && globalStat.uid !== process.getuid())) {
  throw new Error('e2e global root must be private and owned without symlinks');
}
process.env.TMPDIR = tmp;
process.env.SPIDER_GLOBAL_ROOT = globalRoot;
process.env.SPIDER_TEST_FIXTURE_CHECKOUT = checkout;
for (const key of Object.keys(process.env)) {
  if (/^(HC_|HERDR_|PI_SUBAGENT_|PI_SPIDER_|PI_SESSION_)/.test(key)) delete process.env[key];
}
// No binary substitution: createSuite must build each real process environment
// from its own allowlist, supply owned HC identities, and remove Vitest markers.
