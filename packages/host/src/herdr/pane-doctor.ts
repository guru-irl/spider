// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { DoctorFailure } from '../../../herdr/src/setup/doctor.js';
import { HerdrError } from '../../../herdr/src/client/parse.js';
import { PANE_INSTALLATION_REFUSALS, PaneInstallationPermissionsError } from './pane-installation.js';
export async function inspectPaneInstallation(machine: string, probe: () => Promise<void>): Promise<{ failures: DoctorFailure[]; warnings?: DoctorFailure[] }> {
  try { await probe(); return { failures: [] }; }
  catch (error) {
    const code = error instanceof HerdrError ? error.code : '';
    if (error instanceof PaneInstallationPermissionsError) return { failures: [{ item: 'pane-installation', code, message: `Pane endpoint on ${machine} has writable package permissions.`, repair: error.repair }] };
    if (PANE_INSTALLATION_REFUSALS.includes(code as never)) return { failures: [{ item: 'pane-installation', code, message: `Pane endpoint on ${machine} is unavailable or incompatible.`, repair: `redeploy spider on ${machine}` }] };
    return { failures: [], warnings: [{ item: 'pane-installation', code: 'pane-endpoint-inspection-unavailable', message: `Pane endpoint on ${machine} could not be inspected; compatibility is unknown.`, repair: `redeploy spider on ${machine}` }] };
  }
}
