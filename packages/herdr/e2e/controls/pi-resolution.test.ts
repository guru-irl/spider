import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installedPiCli } from '../harness/pi.js';
import { checkoutRoot, scratchRoot } from '../harness/environment.js';

const root = join(scratchRoot(), 'e2-tests', `pi-resolution-${process.pid}`);
mkdirSync(root, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));
describe('CI pi binary resolution', () => {
  it('uses the repository dependency and saves its path and version when the Node sibling is absent', async () => {
    const dependency = join(checkoutRoot(), 'node_modules/@earendil-works/pi-coding-agent');
    const manifest = JSON.parse(readFileSync(join(dependency, 'package.json'), 'utf8'));
    const expected = realpathSync(join(dependency, typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.pi));
    const result = await installedPiCli(join(root, 'node'));
    expect(result).toBe(expected);
    const receipt = JSON.parse(readFileSync(join(scratchRoot(), 'e2/_evidence/_pi', `${process.pid}.json`), 'utf8'));
    expect(receipt).toMatchObject({ path: expected, version: manifest.version, source: 'checkout-dependency' });
  });
  it('keeps an installed sibling as its first choice', async () => {
    const bin = join(root, 'bin');
    const dependency = join(root, 'pi-coding-agent');
    const cli = join(dependency, 'dist/bundle/cli.js');
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(dependency, 'dist/bundle'), { recursive: true });
    writeFileSync(join(dependency, 'package.json'), JSON.stringify({
      name: '@earendil-works/pi-coding-agent', version: '1.2.0', bin: { pi: 'dist/bundle/cli.js' },
    }));
    writeFileSync(cli, '// test-owned pi CLI\n');
    symlinkSync(cli, join(bin, 'pi'));
    const expected = realpathSync(cli);
    expect(await installedPiCli(join(bin, 'node'))).toBe(expected);
    const receipt = JSON.parse(readFileSync(join(scratchRoot(), 'e2/_evidence/_pi', `${process.pid}.json`), 'utf8'));
    expect(receipt).toEqual({ path: expected, version: '1.2.0', source: 'node-sibling' });
  });
});
