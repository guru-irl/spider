// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test, vi } from 'vitest';
import { HerdrError } from '../../../herdr/src/client/parse.js';
import { inspectPaneInstallation } from '../herdr/pane-doctor.js';
for (const code of ['pane-installation-missing', 'pane-installation-unsafe', 'pane-endpoint-build-mismatch', 'pane-endpoint-protocol-mismatch']) test(`doctor reports ${code} with redeploy guidance only`, async () => {
  const probe = vi.fn(async () => { throw new HerdrError(code, 'private-source-cwd/private-session-file'); });
  const report = await inspectPaneInstallation('box.invalid', probe);
  expect(report.failures).toEqual([{ item: 'pane-installation', code, message: 'Pane endpoint on box.invalid is unavailable or incompatible.', repair: 'redeploy spider on box.invalid' }]);
  expect(probe).toHaveBeenCalledTimes(1); expect(JSON.stringify(report)).not.toContain('private-source');
});
test('an unavailable diagnostic probe does not pretend compatibility or expose source details', async () => {
  const report = await inspectPaneInstallation('box.invalid', async () => { throw new Error('private-source-cwd'); });
  expect(report.failures).toEqual([]); expect(report.warnings?.[0].code).toBe('pane-endpoint-inspection-unavailable'); expect(JSON.stringify(report)).not.toContain('private-source');
});
