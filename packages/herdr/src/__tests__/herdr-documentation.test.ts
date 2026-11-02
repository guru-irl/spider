// SPDX-License-Identifier: MIT
import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';

const guide = () => readFile(new URL('../../../../docs/guide/herdr.md', import.meta.url), 'utf8');
test('the guide lists the supported app and core releases', async () => {
  const doc = await guide();
  expect(doc).toContain('`hc` `0.1.16` and `0.1.17`');
  expect(doc).toContain('`herdr-app` `0.1.12`');
  expect(doc).toContain('string-only target ids');
  expect(doc).toContain('`watch()` root-path batches');
});
test('the guide describes actionable cards without promising feed toasts', async () => {
  const doc = await guide();
  expect(doc).toContain('The panel does not post Herdr toasts for feed notices.');
  expect(doc).toContain('The panel never polls machines.');
  expect(doc).toContain('blocked or failed');
  expect(doc).toContain('dismissible cards');
  expect(doc).toContain('memory review in the panel');
  expect(doc).toContain('no budget, subagent-result, escalation or job-result toasts');
  expect(doc).not.toContain('a remote command failed in the last 24 hours');
  expect(doc).not.toContain('memory review in pi');
  expect(doc).not.toContain('opens spider\'s todos view in that session');
  expect(doc).not.toContain('The panel also posts a Herdr notice once');
  expect(doc).toContain('`workspace-chrome`');
});

test('the guide separates subagent pills from session and console paths', async () => {
  const doc = await guide();
  expect(doc).toContain('A subagent viewer has a bot icon, a run-name pill and a parent pill.');
  expect(doc).not.toContain("A viewer's header also shows");
  expect(doc).toContain('Named pi sessions show the program logo, a session-name pill and the path.');
});
