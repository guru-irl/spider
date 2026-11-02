// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { HerdrError } from '../client/parse.js';
import { HERDR_NOTICES, herdrErrorNotice } from '../notices.js';
import shippedPatches from '../../assets/look/patches.json' with { type: 'json' };
import { killTarget } from '../../assets/agents/move.js';

const jargon = /\b(?:lease|capability|adoption|generation|epoch|journal|descriptor|IPC|core identity|token|ancestor)\b/i;

describe('Herdr notices', () => {
  it('uses plain, complete sentences and names the promised actions', () => {
    const messages = Object.values(HERDR_NOTICES);
    expect(messages.length).toBeGreaterThan(10);
    for (const { text, action } of messages) {
      expect(text).toMatch(/^[A-Z]/);
      expect(text).toMatch(/\.$/);
      expect(text).not.toContain('—');
      expect(text).not.toMatch(jargon);
      if (action) expect(text).toContain(action);
    }
  });

  it('names only supported slash commands and the Herdr panel doctor button', () => {
    const allowed = new Set(['/reload', '/herdr-setup', 'Run doctor']);
    const seen = new Set<string>();
    for (const { text } of Object.values(HERDR_NOTICES)) {
      for (const [command] of text.matchAll(/\/[a-z][a-z0-9-]*|\bRun doctor\b/gi)) {
        expect(allowed.has(command), `${command} in ${text}`).toBe(true);
        seen.add(command);
      }
      if (/\bRun doctor\b/.test(text)) expect(text).toContain('spider panel');
      if (text.includes('/herdr-setup')) expect(text).toContain('doctor command');
    }
    expect(seen).toEqual(allowed);
  });

  it('keeps explicit-kill and durable-close confirmation copy free of internal terms', async () => {
    const messages: string[] = [];
    await killTarget({ kind: 'session', ownsSession: true, terminal: 'parent', descriptor: { generation: 'gen' } }, {
      ipc: async () => { throw new Error('No action before confirmation'); }, run() { throw new Error('No native kill'); },
      confirm: spec => { messages.push(String(spec.title), String(spec.detail)); },
    });
    const close = shippedPatches.mods.pane.find(patch => patch.id === 'controlled-session-close')!;
    for (const match of close.replacement.matchAll(/\b(?:title|detail):\s*("(?:[^"\\]|\\.)*")/g)) messages.push(JSON.parse(match[1]));
    expect(messages).toHaveLength(4);
    for (const text of messages) { expect(text).not.toMatch(jargon); expect(text).toMatch(/[.!?]$/); }
  });

  it.each(['unsafe-feed-path', 'feed-too-large', 'invalid-feed'])('gives reader failure %s plain recovery advice', code => {
    const text = herdrErrorNotice(new HerdrError(code, 'private descriptor details'));
    expect(text).toBe(HERDR_NOTICES.feedRefresh.text); expect(text).not.toMatch(jargon);
  });

  it('explains a failed session handoff without exposing internals', () => {
    expect(herdrErrorNotice(new HerdrError('lease-token-invalid', 'Lease adoption requires the launcher capability')))
      .toBe("Spider couldn't register this session with Herdr, so reopening it later may not work. This session still works. Close and reopen the session in Herdr.");
  });

  it.each([
    ['caller-mismatch', "This session isn't running in the Herdr pane it belongs to, so spider's Herdr features are off here. Close this session and open a new session in Herdr."],
    ['unavailable', "Herdr couldn't respond to spider, so some Herdr features may not work. Everything else in spider still works. Run /herdr-setup to print the doctor command for this machine."],
    ['invalid-reply', "Herdr sent a response spider couldn't understand, so the sidebar or panes may be out of date. Run /reload once Herdr is running. If that doesn't help, run /herdr-setup to print the doctor command for this machine."],
    ['pane-timeout', "Herdr couldn't open a pane for this session. The session and other spider features still work. Try opening the pane again, or run /herdr-setup to print the doctor command for this machine."],
    ['session-unavailable', "Spider couldn't open this view because its session is no longer active. Open a session and try again."],
    ['invalid-journal', "Spider couldn't read some saved Herdr session information. Other Herdr features may still work. Use Run doctor in the spider panel, or run /herdr-setup to print the doctor command for this machine."],
    ['core-epoch-unavailable', "Spider couldn't start its Herdr features in this session. Everything else in spider still works. Run /herdr-setup to print the doctor command for this machine."],
    ['remote-home-probe-failed', "Spider couldn't start the remote command. Your session and local commands still work. Use Run doctor in the spider panel, or run /herdr-setup to print the doctor command for this machine."],
  ])('explains %s without exposing its internal error', (code, expected) => {
    expect(herdrErrorNotice(new HerdrError(code, 'private detail'))).toBe(expected);
  });

  it.each([
    ['pane-not-owned', "Herdr couldn't open or move this pane. The session still works. Try again."],
    ['owner-unplaced', "Herdr couldn't find the session pane, so it couldn't open the viewer. The session still works. Open the session pane and try again."],
    ['owner-tab-changed', 'The session moved while Herdr was opening its pane. The session still works. Try opening the pane again.'],
    ['observer-unplaced', "Herdr couldn't open a pane for this command. The command may still be running. Try opening the pane again."],
    ['observer-timeout', "Herdr couldn't open a pane for this command. The command may still be running. Try opening the pane again."],
    ['auxiliary-disabled', 'This tab has no free pane slot. The session still works. Close a pane and try again.'],
    ['agent-pane-protected', "Spider couldn't change this session pane because it is protected. The session still works."],
    ['viewer-closing', 'The live viewer is still closing. The run is finished. Open the saved view again.'],
    ['run-finished', 'This run has already finished. Open its saved view instead.'],
  ])('describes %s accurately', (code, expected) => {
    expect(herdrErrorNotice(new HerdrError(code, 'private detail'))).toBe(expected);
  });

  it('does not catalog the suppressed pane-removal diagnostic', () => {
    expect(HERDR_NOTICES).not.toHaveProperty('paneHideSlow');
    expect(herdrErrorNotice(new HerdrError('pane-removal-timeout', 'private detail')))
      .toBe("Spider's Herdr features hit a problem in this session. Everything else in spider still works. Use Run doctor in the spider panel, or run /herdr-setup to print the doctor command for this machine (pane-removal-timeout).");
  });

  it('describes a missing command viewer launcher as a setup problem', () => {
    expect(herdrErrorNotice(new HerdrError('remote-observer-unavailable', 'missing launcher'))).toBe(HERDR_NOTICES.generic.text);
  });

  it('gives an unknown error code and a concrete next step without exposing raw details', () => {
    expect(herdrErrorNotice(new HerdrError('future-failure', 'secret details')))
      .toBe("Spider's Herdr features hit a problem in this session. Everything else in spider still works. Use Run doctor in the spider panel, or run /herdr-setup to print the doctor command for this machine (future-failure).");
    expect(herdrErrorNotice(new Error('secret details')))
      .toBe("Spider's Herdr features hit a problem in this session. Everything else in spider still works. Use Run doctor in the spider panel, or run /herdr-setup to print the doctor command for this machine.");
    expect(herdrErrorNotice(new HerdrError('constructor', 'secret details')))
      .toBe("Spider's Herdr features hit a problem in this session. Everything else in spider still works. Use Run doctor in the spider panel, or run /herdr-setup to print the doctor command for this machine (constructor).");
  });
});
