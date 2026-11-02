// SPDX-License-Identifier: MIT
import type { AcceptanceScenario } from './testutil.js';
import { acceptanceGuidance } from './acceptance/h.js';
import { acceptanceRoles } from './acceptance/h.js';
import { acceptanceShortcuts } from './acceptance/h.js';

export const scenarioGuidance: AcceptanceScenario = acceptanceGuidance;
export const scenarioRoles: AcceptanceScenario = acceptanceRoles;
export const scenarioShortcuts: AcceptanceScenario = acceptanceShortcuts;
