#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { paneTree, paneOrder, splitPane, removePane, navigatePane } from '../../e2e/harness/pane-geometry.ts';
import { HERDR_LABELS } from '../contracts.ts';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = process.env.HERDR_FAKE_ROOT;
if (!root) throw new Error('HERDR_FAKE_ROOT required');
const lockDirectory = join(root, 'app-commands'); mkdirSync(lockDirectory, { recursive: true });
const ticket = join(lockDirectory, `${process.pid}.json`);
const saveTicket = number => { const next = ticket + '.next'; writeFileSync(next, JSON.stringify({ pid: process.pid, number })); renameSync(next, ticket); };
const tickets = () => readdirSync(lockDirectory).filter(name => name.endsWith('.json')).flatMap(name => {
  const path = join(lockDirectory, name); let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  try { process.kill(value.pid, 0); } catch (error) { if (error.code === 'ESRCH') { try { unlinkSync(path); } catch {} return []; } throw error; }
  return [{ name, ...value }];
});
saveTicket(null);
process.on('exit', () => { try { unlinkSync(ticket); } catch {} });
process.on('SIGTERM', () => process.exit(143));
const number = Math.max(0, ...tickets().map(value => value.number ?? 0)) + 1; saveTicket(number);
const lockDeadline = Date.now() + 30000;
while (tickets().some(value => value.pid !== process.pid && (value.number === null || value.number < number || value.number === number && value.name < `${process.pid}.json`))) {
  if (Date.now() >= lockDeadline) throw new Error('Fake app command lock timed out');
  await new Promise(resolve => setTimeout(resolve, 5));
}
// The real app runs one command at a time, so a reader never sees a half-written state. Replace the file in one step.
const saveDoc = value => { const next = `${root}/app.json.${process.pid}.next`; writeFileSync(next, JSON.stringify(value)); renameSync(next, `${root}/app.json`); };
const argv = process.argv.slice(2);
appendFileSync(`${root}/app-calls.jsonl`, JSON.stringify(argv) + '\n');
const scenarioPath = process.env.HERDR_FAKE_SCENARIO || `${root}/scenario.json`;
const scenario = existsSync(scenarioPath) ? JSON.parse(readFileSync(scenarioPath, 'utf8')) : {};
const step = (scenario.appSteps || []).find(rule => (rule.argvPrefix || []).every((v, i) => argv[i] === v) && (rule.argvIncludes || []).every(v => argv.includes(v)));
if (step) {
  for (const [path, text] of Object.entries(step.writes || {})) {
    if (!path.startsWith(root + '/')) throw new Error('Unfenced scenario write');
    mkdirSync(dirname(path), { recursive: true });
    const next = `${path}.${process.pid}.next`;
    writeFileSync(next, text); renameSync(next, path);
  }
  if (step.delayMs) await new Promise(resolve => setTimeout(resolve, step.delayMs));
  if (step.stderr) process.stderr.write(typeof step.stderr === 'string' ? step.stderr : JSON.stringify(step.stderr));
  if (step.exitCode) { if ('reply' in step) console.log(JSON.stringify(step.reply)); process.exit(step.exitCode); }
  if ('reply' in step) { console.log(JSON.stringify(step.reply)); process.exit(0); }
}
const doc = JSON.parse(readFileSync(`${root}/app.json`, 'utf8'));
const tree = tab => tab.geometry ?? paneTree([...tab.terminals.map(row => row.pane), ...(tab.modPane ? [tab.modPane] : [])]);
const erase = (tab, pane) => { if (tab.geometry) tab.geometry = removePane(tab.geometry, pane) ?? paneTree([]); };
const focusPane = pane => { doc.focusedPane = pane; doc.focusHistory ??= {}; doc.focusHistory[pane] = doc.focusSequence = (doc.focusSequence ?? 0) + 1; };
if (doc.error !== undefined) { console.log(JSON.stringify(doc)); process.exit(0); }
if (argv[0] === 'status') {
  const space = doc.spaces?.find(space => space.active) ?? doc.spaces?.[0];
  const tab = space?.tabs.find(tab => tab.active) ?? space?.tabs[0];
  console.log(JSON.stringify({ space: space?.id ?? null, tab: tab?.id ?? null, focused_pane: doc.focusedPane ?? null })); process.exit(0);
}
if (argv[0] === 'do' && ['tab.new', 'tab.move', 'pane.close', 'pane.go'].includes(argv[1])) {
  const arg = key => { const at = argv.indexOf(`--${key}`); return at < 0 ? undefined : argv[at + 1]; };
  if (argv[1] === 'tab.new') {
    const space = doc.spaces?.find(space => space.id === arg('space'));
    if (!space || arg('mod') !== 'pane') { console.log(JSON.stringify({ error: 'no space or mod' })); process.exit(0); }
    const id = `kept-tab-${doc.nextKeptTab = (doc.nextKeptTab ?? 0) + 1}`, pane = `mod-${id}`;
    space.tabs.push({ id, name: arg('name') ?? '', terminals: [], modPane: pane });
    for (const candidate of doc.spaces) { candidate.active = candidate === space; for (const tab of candidate.tabs) tab.active = tab.id === id; }
    focusPane(pane); saveDoc(doc); console.log(JSON.stringify({ space: space.id, tab: id, pane })); process.exit(0);
  }
  if (argv[1] === 'tab.move') {
    const space = doc.spaces?.find(space => space.tabs.some(tab => tab.id === arg('id'))), index = Number(arg('index'));
    if (!space || !Number.isInteger(index) || index < 1 || index > space.tabs.length) { console.log(JSON.stringify({ error: 'no tab or index' })); process.exit(0); }
    const at = space.tabs.findIndex(tab => tab.id === arg('id')); const [tab] = space.tabs.splice(at, 1); space.tabs.splice(index - 1, 0, tab);
    saveDoc(doc); console.log('{}'); process.exit(0);
  }
  if (argv[1] === 'pane.close') {
    const space = doc.spaces?.find(space => space.tabs.some(tab => tab.modPane === arg('pane')));
    const tab = space?.tabs.find(tab => tab.modPane === arg('pane'));
    if (!tab) { console.log(JSON.stringify({ error: 'no mod pane' })); process.exit(0); }
    erase(tab, tab.modPane); delete tab.modPane; if (!tab.terminals.length) space.tabs = space.tabs.filter(item => item !== tab);
    saveDoc(doc); console.log('{}'); process.exit(0);
  }
  const current = doc.spaces.flatMap(space => space.tabs).find(tab => paneOrder(tree(tab)).includes(doc.focusedPane));
  if (current) focusPane(navigatePane(tree(current), doc.focusedPane, arg('direction'), doc.focusHistory ?? {}));
  saveDoc(doc); console.log('{}'); process.exit(0);
}
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
  if (argv[1] === 'terminal.keep' && !['tab', 'right', 'down'].includes(place)) fail('terminal.keep needs place tab, right or down');
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
    const split = place !== 'tab';
    const target = split ? space.tabs.find(tab => tab.terminals.some(row => row.pane === doc.focusedPane)) : null;
    if (split && !target) fail('no focused pane');
    const id = target?.id ?? `kept-tab-${doc.nextKeptTab = (doc.nextKeptTab ?? 0) + 1}`, pane = `pane-${terminal}`;
    try {
      const binary = join(process.env.HERDR_TEST_ROOT || root, 'hc');
      execFileSync(binary, ['label', terminal, `${HERDR_LABELS.space}=${space.id}`, `${HERDR_LABELS.tab}=${id}`, '--json'], { timeout: 10000 });
      execFileSync(binary, ['keep', terminal, '--json'], { timeout: 10000 });
    } catch (error) { fail(String(error)); }
    const row = { terminal, pane };
    const tab = target ?? { id, name: running.name || terminal, terminals: [] };
    if (target) tab.geometry = splitPane(tree(tab), doc.focusedPane, pane, place);
    tab.terminals.push(row); if (!target) space.tabs.push(tab);
    for (const candidate of doc.spaces) { candidate.active = candidate === space; for (const value of candidate.tabs) value.active = value === tab; }
    focusPane(pane); saveDoc(doc);
    console.log(JSON.stringify({ pending: true, terminal, tab: id, pane })); process.exit(0);
  }
  for (const space of doc.spaces || []) { space.active = space === found.space; for (const tab of space.tabs || []) tab.active = tab === found.tab; }
  focusPane(found.row.pane);
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
    const removed = (doc.spaces || []).flatMap(space => space.tabs).flatMap(tab => tab.terminals).find(row => row.terminal === terminal)?.pane;
    if (removed) for (const tab of doc.spaces.flatMap(space => space.tabs)) if (paneOrder(tree(tab)).includes(removed)) erase(tab, removed);
    for (const space of doc.spaces || []) {
      for (const tab of space.tabs || []) tab.terminals = tab.terminals.filter(row => row.terminal !== terminal);
      space.tabs = space.tabs.filter(tab => tab.terminals.length || tab.modPane);
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
    if (tab && !tab.terminals.some(row => row.terminal === t.address)) {
      const pane = `pane-${t.address}`, layout = tree(tab), last = paneOrder(layout).at(-1);
      tab.geometry = last ? splitPane(layout, last, pane, 'right') : paneTree([pane]);
      tab.terminals.push({ terminal: t.address, pane, status: t.status });
    }
  }
  for (const tab of doc.spaces.flatMap(space => space.tabs)) tab.terminals.sort((a, b) => paneOrder(tree(tab)).indexOf(a.pane) - paneOrder(tree(tab)).indexOf(b.pane));
  saveDoc(doc);
}
console.log(JSON.stringify(doc.error !== undefined || argv[0] === 'ls' ? doc : {}));
