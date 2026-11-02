// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import assert from 'node:assert/strict';
import { it } from 'vitest';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createSuite } from '../../harness/suite.js';
import { storyId } from '../../harness/scenario.js';
import { writeScript } from '../../harness/pi.js';
import { deadline } from '../../harness/wait.js';
import { shellQuote } from './index.js';

it('a fresh packed parent refuses absent destination runtime before effects and still runs local tools', async () => {
  const suite = await createSuite({ tier: 'headless', story: storyId('H-fresh-runtime-negative') });
  try {
    await suite.app();
    const cwd = await suite.project('fresh-negative'), effect = join(cwd, 'must-not-exist');
    const herdr = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr'); await mkdir(herdr, { recursive: true });
    const configPath = suite.ownPath(join(herdr, 'config.json'));
    // An explicitly incomplete installation is the known-bad control. No runtime, templates, mods or journal are seeded.
    await writeFile(configPath, JSON.stringify({ enabled: true, app: { binary: suite.appConnection!.binary, home: suite.directories.HERDR_APP_HOME },
      core: { binary: suite.cores!.wrapper, config: join(suite.directories.XDG_CONFIG_HOME, 'herdr-core/config.toml') },
      agentDirectory: suite.directories.PI_CODING_AGENT_DIR, globalRoot: suite.directories.SPIDER_GLOBAL_ROOT,
      shellRc: join(suite.directories.HOME, '.bashrc'), spaces: [], machines: [{ name: suite.cores!.machine, aliases: [], runtime: { directory: join(suite.root, 'absent-runtime'), cwd, commands: {} } }] }), { mode: 0o600 });
    const globalPath = join(suite.directories.SPIDER_GLOBAL_ROOT, 'config.json');
    await writeFile(globalPath, JSON.stringify({ ...JSON.parse(await readFile(globalPath, 'utf8')), 'herdr.enabled': true, 'herdr.config': configPath }));
    await writeScript(suite.pi.scriptPath, { story: suite.story, scripts: {
      absent: [{ steps: [{ tool: { id: 'absent', name: 'spider', arguments: { action: 'exec', language: 'shell', on: suite.cores!.machine, code: `printf forbidden >> ${shellQuote(effect)}` } } }] }, { steps: [{ text: 'Observed missing-runtime refusal' }] }],
      local: [{ steps: [{ tool: { id: 'local', name: 'spider', arguments: { action: 'exec', language: 'shell', code: "printf 'local-positive\\n'; printf 'local-error\\n' >&2; exit 23" } } }] }, { steps: [{ text: 'Observed local result' }] }],
    } });
    const driver = await suite.launchPi({ mode: 'interactive', cwd, args: ['--approve'] }); assert.equal(driver.mode, 'interactive');
    await driver.waitEvent('session_start', () => true, deadline(60000));
    let at = Date.now(); await driver.prompt('[[e2e:absent]]');
    const refused = await driver.toolResult('absent', deadline(60000)); await suite.evidence('fresh-missing-runtime-result.json', refused);
    assert.equal(refused.isError, true); assert.match(JSON.stringify(refused.result), /runtime-not-installed|Remote runtime.*missing|rerun.*setup/i);
    assert.equal(await access(effect).then(() => true, () => false), false);
    await driver.waitEvent('agent_settled', e => e.at >= at, deadline(60000));
    at = Date.now(); await driver.prompt('[[e2e:local]]');
    const local = await driver.toolResult('local', deadline(60000)); await suite.evidence('fresh-local-result.json', local);
    const details = (local.result as { details: { stdout: string; stderr: string; exitCode: number; outcome: string; remote?: unknown } }).details;
    assert.equal(details.stdout, 'local-positive\n'); assert.equal(details.stderr, 'local-error\n'); assert.equal(details.exitCode, 23); assert.equal(details.outcome, 'exited'); assert.equal(details.remote, undefined);
    await driver.waitEvent('agent_settled', e => e.at >= at, deadline(60000));
    const calls = await suite.cores!.records(); await suite.evidence('fresh-hc-calls.json', calls);
    assert.ok(!calls.some(c => c.argv.some(a => a === 'spider.kind=exec' || a === 'spider.kind=remote-console')), 'missing runtime creates no payload or console');
    await suite.evidence('fresh-pi-events.json', await driver.events()); await suite.evidence('fresh-pi.raw', await driver.rawOutput());
  } finally { await suite.close(); }
}, 120000);
