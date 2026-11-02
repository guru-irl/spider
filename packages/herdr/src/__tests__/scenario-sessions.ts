// SPDX-License-Identifier: MIT
import type { AcceptanceScenario } from './testutil.js';
import { acceptanceResume } from './acceptance/g.js';
import { acceptanceSpaces } from './acceptance/g.js';

export const scenarioResume: AcceptanceScenario = acceptanceResume;
export const scenarioSpaces: AcceptanceScenario = acceptanceSpaces;
