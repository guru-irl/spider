// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFile } from 'node:fs/promises';
import { expect } from 'vitest';
import { relocateFixture } from '../fixtures/roam-relocate.js';
import { verifyRelocatedTranscript } from '../fixtures/relocate-transcript.js';
import { assertRelocatedCopy, waitForReplicatedHome } from '../fixtures/relocate-assertions.js';
import { deadline } from '../harness/wait.js';
import { text } from '../fixtures/child-scripts.js';
import { registerScenarios, storyId, type ScenarioDefinition } from '../harness/scenario.js';
import type { Suite } from '../harness/suite.js';

async function roundTrip(suite: Suite): Promise<void> {
  const started = Date.now(), fixture = await relocateFixture(suite);
  const { hub, box, original } = fixture, id = original.sessionId;
  try {
    expect(fixture.home()).toBeNull();
    const source = await fixture.owner(hub, original.terminal, id);
    expect(source).toEqual(original);
    const git = await fixture.gitState(source.cwd);
    expect(git).toMatchObject({ status: 'MM tracked.txt\n?? untracked.txt', staged: 'staged', working: 'working\n', untracked: 'untracked fixture\n' });
    const before = await readFile(source.file);
    await suite.evidence('R18-before.jsonl', before);

    const outward = await fixture.relocate(id, suite.cores!.machine);
    const awayHome = { session_id: id, machine_id: box.id, epoch: 3, state: 'running', destination: null };
    expect(fixture.home()).toMatchObject(awayHome);
    expect(fixture.home(box)).toMatchObject(awayHome);
    const away = await fixture.owner(box, outward.terminal, id, outward);
    expect(away).toMatchObject({ sessionId: id, file: outward.file, cwd: outward.cwd });
    assertRelocatedCopy(source, away, box.repository, box.agent);
    expect(await fixture.gitState(away.cwd)).toEqual(git);
    const arrived = await readFile(away.file);
    await suite.evidence('R18-away.jsonl', arrived);
    const outwardTranscript = verifyRelocatedTranscript(before, arrived, id, source.cwd, away.cwd);
    await fixture.turn(box, away, 'away', 'fixture machine reply');
    const afterAwayTurn = await readFile(away.file);
    await suite.evidence('R18-away-after-turn.jsonl', afterAwayTurn);
    expect(afterAwayTurn.length).toBeGreaterThan(arrived.length);
    expect(afterAwayTurn.subarray(0, arrived.length).equals(arrived)).toBe(true);

    const returning = await fixture.relocate(id, 'mac');
    const finalHome = fixture.home();
    expect(finalHome).toMatchObject({ session_id: id, machine_id: hub.id, epoch: 5, state: 'running', destination: null });
    if (!finalHome) throw new Error('final home is missing');
    await waitForReplicatedHome(() => fixture.home(box), finalHome, deadline(20_000));
    const returned = await fixture.owner(hub, returning.terminal, id, returning);
    expect(returned).toMatchObject({ sessionId: id, file: returning.file, cwd: returning.cwd });
    assertRelocatedCopy(away, returned, hub.repository, hub.agent);
    expect(returned.file).toBe(original.file);
    expect(returned.cwd).toBe(original.cwd);
    expect(await fixture.gitState(returned.cwd)).toEqual(git);
    const homeBytes = await readFile(returned.file);
    await suite.evidence('R18-return.jsonl', homeBytes);
    const returnTranscript = verifyRelocatedTranscript(afterAwayTurn, homeBytes, id, away.cwd, returned.cwd);
    await fixture.turn(hub, returned, 'home', 'returned session reply');
    const afterHomeTurn = await readFile(returned.file);
    await suite.evidence('R18-home-after-turn.jsonl', afterHomeTurn);
    expect(afterHomeTurn.length).toBeGreaterThan(homeBytes.length);
    expect(afterHomeTurn.subarray(0, homeBytes.length).equals(homeBytes)).toBe(true);
    await suite.evidence('R18-relocate.json', { sessionId: id, initialHome: null, outwardTranscript, returnTranscript,
      owners: [source, away, returned], finalHome, boxHome: fixture.home(box), elapsedMs: Date.now() - started,
      coverage: 'Two owned cores with synthetic transport; no native app or SSH.' });
  } finally { await fixture.close(); }
}

export const scenarios: readonly ScenarioDefinition[] = [
  { id: storyId('R18'), title: 'ordinary session relocates to a fixture machine and back', tiers: ['headless'],
    script: { scripts: { birth: [text('ordinary source reply')], away: [text('fixture machine reply')], home: [text('returned session reply')] } },
    run: roundTrip },
];
registerScenarios(scenarios);
