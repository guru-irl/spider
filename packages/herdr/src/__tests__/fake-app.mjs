#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { HERDR_LABELS } from '../contracts.ts';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = process.env.HERDR_FAKE_ROOT;
if (!root) throw new Error('HERDR_FAKE_ROOT required');
// The real app runs one command at a time, so a reader never sees a half-written state. Replace the file in one step.
const saveDoc = value => { const next = `${root}/app.json.${process.pid}.next`; writeFileSync(next, JSON.stringify(value)); renameSync(next, `${root}/app.json`); };
const argv = process.argv.slice(2);
appendFileSync(`${root}/app-calls.jsonl`, JSON.stringify(argv) + '\n');
const scenarioPath = process.env.HERDR_FAKE_SCENARIO || `${root}/scenario.json`;
const scenario = existsSync(scenarioPath) ? JSON.parse(readFileSync(scenarioPath, 'utf8')) : {};
const step = (scenario.appSteps || []).find(rule => (rule.argvPrefix || []).every((v, i) => argv[i] === v) && (rule.argvIncludes || []).every(v => argv.includes(v)));
if (step) {
  for (const [path, text] of Object.entries(step.writes || {})) { if (!path.startsWith(root + '/')) throw new Error('Unfenced scenario write'); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
  if (step.delayMs) await new Promise(resolve => setTimeout(resolve, step.delayMs));
  if (step.stderr) process.stderr.write(typeof step.stderr === 'string' ? step.stderr : JSON.stringify(step.stderr));
  if (step.exitCode) { if ('reply' in step) console.log(JSON.stringify(step.reply)); process.exit(step.exitCode); }
  if ('reply' in step) { console.log(JSON.stringify(step.reply)); process.exit(0); }
}
const doc = JSON.parse(readFileSync(`${root}/app.json`, 'utf8'));
if (doc.error !== undefined) { console.log(JSON.stringify(doc)); process.exit(0); }
if (argv[0] === 'do' && argv[1] === 'tab.rename') {
  const arg = key => { const at = argv.indexOf(`--${key}`); return at < 0 ? undefined : argv[at + 1]; };
  const id = arg('id') ?? doc.spaces?.find(space => space.active)?.tabs.find(tab => tab.active)?.id;
  const space = doc.spaces?.find(space => space.tabs.some(tab => tab.id === id));
  const tab = space?.tabs.find(tab => tab.id === id);
  const name = arg('name');
  const error = !id ? 'no tab to rename' : name === undefined ? 'tab.rename needs name (empty: its number)' : !tab ? `no tab ${JSON.stringify(id)}` : null;
  if (error) console.log(JSON.stringify({ error }));
  else { tab.name = name.trim() || String(space.tabs.indexOf(tab) + 1); saveDoc(doc); console.log(JSON.stringify({ ok: true })); }
  process.exit(0);
}
if (argv[0] === 'do' && ['terminal.keep', 'pane.focus'].includes(argv[1])) {
  const arg = key => { const at = argv.indexOf(`--${key}`); return at < 0 ? undefined : argv[at + 1]; };
  const terminal = arg('terminal'), place = arg('place') ?? 'tab';
  const fail = error => { console.log(JSON.stringify({ error })); process.exit(0); };
  if (argv[1] === 'terminal.keep' && place !== 'tab') fail('terminal.keep needs place tab');
  if (argv[1] === 'terminal.keep' && arg('pane') !== undefined) fail('terminal.keep: unknown argument(s): pane; valid arguments: terminal, place');
  if (argv[1] === 'terminal.keep' && !terminal) fail(`no running terminal ${JSON.stringify(terminal ?? '')}`);
  if (argv[1] === 'pane.focus' && !terminal && !arg('pane')) fail('no such pane');
  let found;
  for (const space of doc.spaces || []) for (const tab of space.tabs || []) for (const row of tab.terminals || []) {
    if (arg('pane') ? row.pane === arg('pane') : row.terminal === terminal) found = { space, tab, row };
  }
  if (!found && argv[1] === 'pane.focus') fail('no such pane');
  if (!found) {
    const core = JSON.parse(readFileSync(`${root}/core.json`, 'utf8'));
    const running = core.terminals.find(t => t.address === terminal && t.state === 'live');
    if (!running) fail(`no running terminal ${JSON.stringify(terminal)}`);
    if (doc.changingTerminals?.includes(terminal)) fail('This terminal already has a pane change in progress.');
    const space = doc.spaces?.find(space => space.active) ?? doc.spaces?.[0];
    if (!space) fail('no space to keep it in');
    const machine = terminal.includes('/') ? terminal.split('/')[0] : null;
    const spaceMachine = space.machine ?? (space.id.includes('/') ? space.id.split('/')[0] : null);
    if (machine !== spaceMachine) fail("A terminal's pane must stay on its own machine.");
    const id = `kept-tab-${doc.nextKeptTab = (doc.nextKeptTab ?? 0) + 1}`, pane = `pane-${terminal}`;
    try {
      const binary = join(process.env.HERDR_TEST_ROOT || root, 'hc');
      execFileSync(binary, ['label', terminal, `${HERDR_LABELS.space}=${space.id}`, `${HERDR_LABELS.tab}=${id}`, '--json'], { timeout: 10000 });
      execFileSync(binary, ['keep', terminal, '--json'], { timeout: 10000 });
    } catch (error) { fail(String(error)); }
    const tab = { id, name: running.name || terminal, terminals: [{ terminal, pane }] };
    space.tabs.push(tab); found = { space, tab, row: tab.terminals[0] };
    saveDoc(doc);
    console.log(JSON.stringify({ pending: true, terminal, tab: id, pane })); process.exit(0);
  }
  for (const space of doc.spaces || []) { space.active = space === found.space; for (const tab of space.tabs || []) tab.active = tab === found.tab; }
  doc.focusedPane = found.row.pane;
  saveDoc(doc); console.log(JSON.stringify(argv[1] === 'pane.focus' ? { ok: true } : { pane: found.row.pane })); process.exit(0);
}
if (argv[0] === 'do' && argv[1] === 'terminal.park') {
  const index = argv.indexOf('--terminal'), terminal = index >= 0 ? argv[index + 1] : undefined;
  if (!terminal) { console.log(JSON.stringify({ error: 'terminal.park needs terminal' })); process.exit(0); }
  // Native park returns pending, clears placement labels, then disables keep.
  // Only successful core changes remove a pane; neither command kills the terminal.
  try {
    const binary = join(process.env.HERDR_TEST_ROOT || root, 'hc');
    execFileSync(binary, ['label', terminal, `${HERDR_LABELS.space}=`, `${HERDR_LABELS.tab}=`, '--json'], { timeout: 10000 });
    execFileSync(binary, ['keep', terminal, '--off', '--json'], { timeout: 10000 });
    for (const space of doc.spaces || []) {
      for (const tab of space.tabs || []) tab.terminals = tab.terminals.filter(row => row.terminal !== terminal);
      space.tabs = space.tabs.filter(tab => tab.terminals.length);
    }
    doc.spaces = doc.spaces.filter(space => space.tabs.length);
    saveDoc(doc);
  } catch (error) {
    appendFileSync(`${root}/app-change-errors.jsonl`, JSON.stringify({ terminal, message: String(error) }) + '\n');
  }
  console.log(JSON.stringify({ pending: true, terminal })); process.exit(0);
}
if (argv[0] === 'ls' && !scenario.app?.holdAdoption && Array.isArray(doc.spaces)) {
  const core = JSON.parse(readFileSync(`${root}/core.json`, 'utf8'));
  for (const t of core.terminals) {
    if (t.address.includes('/') || t.state !== 'live' || (scenario.app?.adoptionDelayMs && Date.now() - (t.created_ms || Date.now()) < scenario.app.adoptionDelayMs)) continue;
    const space = doc.spaces.find(s => s.id === t.labels?.[HERDR_LABELS.space]);
    const tab = space?.tabs.find(tb => tb.id === t.labels?.[HERDR_LABELS.tab]);
    if (tab && !tab.terminals.some(row => row.terminal === t.address)) tab.terminals.push({ terminal: t.address, pane: `pane-${t.address}`, status: t.status });
  }
  saveDoc(doc);
}
console.log(JSON.stringify(doc.error !== undefined || argv[0] === 'ls' ? doc : {}));
