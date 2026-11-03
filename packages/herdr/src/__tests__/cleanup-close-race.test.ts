// SPDX-License-Identifier: MIT
import { expect, it } from 'vitest';
import { createHerdrHarness } from './isolated.js';
import { HerdrError } from '../client/parse.js';

it.each(['kill', 'rm'])('close tolerates a terminal removed between inventory and %s', async operation => {
  const h = await createHerdrHarness('fake'); await h.start();
  const terminal = await h.hc.run({ argv: [h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: h.root, labels: { 'spider.kind': 'subagent-viewer' }, background: true, outliveParent: true, noNotify: true });
  if (operation === 'rm') await h.hc.kill(terminal.address);
  const cli = h.cli; let raced = false;
  h.cli = async (argv, side) => {
    if (!raced && side !== 'remote' && argv[0] === operation && argv[1] === terminal.address) {
      raced = true; await cli(['rm', terminal.address, '--json']);
    }
    return cli(argv, side);
  };
  await expect(h.close()).resolves.toBeUndefined();
  expect(raced).toBe(true);
  expect(h.cleanupProof).toMatchObject({ remaining: [], defaultCoreUnchanged: true });
});

it('close still reports failures other than an already removed terminal', async () => {
  const h = await createHerdrHarness('fake'); await h.start();
  const cli = h.cli; let failed = false;
  h.cli = async (argv, side) => {
    if (!failed && argv[0] === 'kill') { failed = true; throw new HerdrError('permission-denied', 'denied'); }
    return cli(argv, side);
  };
  await expect(h.close()).rejects.toMatchObject({ code: 'permission-denied' });
  expect(failed).toBe(true);
});
