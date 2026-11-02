import { expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { createSuite } from '../suite.js';
import { storyId } from '../scenario.js';
import { spawnOwned } from '../processes.js';
import { waitFor, deadline } from '../wait.js';
import { payloadGate, nativeViewerRuns } from '../../fixtures/panel-inputs.js';
import type { RunSummary, RunId, SessionId, TerminalAddress } from '../../../src/contracts.js';
it('joins only live exact-owner native viewer identities without rewriting the feed', () => {
    const run: RunSummary = { id: 'run-a' as RunId, ownerSessionId: 'owner-session' as SessionId, name: 'Same name', status: 'running', childMode: 'rpc', canSteer: true, startedAt: 1, finishedAt: null, viewer: null, result: null };
    const scope = { sessionId: 'owner-session', coreId: 'core-a', terminal: 't2' };
    const viewer = { address: 't3' as TerminalAddress, state: 'live', labels: { 'spider.kind': 'subagent-viewer', 'spider.run': run.id, 'spider.session': scope.sessionId, 'spider.owner-core': scope.coreId, 'spider.owner-terminal': scope.terminal } };
    const foreign = { ...viewer, address: 't4' as TerminalAddress, labels: { ...viewer.labels, 'spider.session': 'foreign-session' } };
    const wrongCore = { ...viewer, labels: { ...viewer.labels, 'spider.owner-core': 'foreign-core' } };
    const wrongTerminal = { ...viewer, labels: { ...viewer.labels, 'spider.owner-terminal': 't9' } };
    const observer = { ...viewer, labels: { ...viewer.labels, 'spider.kind': 'remote-observer' } };
    expect(nativeViewerRuns(scope, [run], [foreign, wrongCore, wrongTerminal, observer, { ...viewer, state: 'finished' }])).toEqual([]);
    expect(nativeViewerRuns(scope, [run], [foreign, viewer])).toEqual([{ ...run, viewer: 't3' }]);
    expect(run.viewer).toBeNull();
    expect(() => nativeViewerRuns(scope, [run], [viewer, { ...viewer, address: 't5' as TerminalAddress }])).toThrow(/duplicate.*viewer/);
});
it('runs the external gate payload with real output and a real exit 23', async () => {
    const suite = await createSuite({ tier: 'headless', story: storyId('H-panel-input') });
    try {
        const input = await payloadGate(suite, 'input');
        const process = spawnOwned(suite.ledger, { label: 'fixture-payload', command: globalThis.process.execPath, args: ['--input-type=module', '-e', input.code], env: { ...suite.env }, cwd: suite.root, stdio: 'pipe' });
        let stdout = '', stderr = '', exited = false;
        process.child.stdout!.on('data', bytes => { stdout += bytes.toString(); });
        process.child.stderr!.on('data', bytes => { stderr += bytes.toString(); });
        const exit = new Promise<number | null>(resolve => process.child.on('close', code => { exited = true; resolve(code); }));
        await waitFor('fixture payload reached the real file gate', async () => {
            try {
                return await readFile(input.ready, 'utf8');
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw error;
                return null;
            }
        }, value => value === 'ready', deadline(10000), { reconcileMs: 100 });
        expect(exited).toBe(false);
        expect(stdout).toContain('first-input\n');
        expect(stdout).toContain('output-input-149\n');
        expect(stdout).not.toContain('last-input');
        await writeFile(input.releasePath, 'release');
        expect(await exit).toBe(23);
        expect(stderr).toBe('');
        expect(stdout).toContain('last-input\n');
        expect(stdout.trim().split('\n')).toHaveLength(152);
        await suite.evidence('payload-input.json', { input, stdout, stderr, exitCode: 23, classification: 'external fixture input, not product-story acceptance' });
    }
    finally {
        expect((await suite.close()).clean).toBe(true);
    }
});
