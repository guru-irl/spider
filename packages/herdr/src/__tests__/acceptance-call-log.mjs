// SPDX-License-Identifier: MIT
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

// Preloaded only by acceptance's fake hc launcher, not the daemon or its children.
const { HERDR_TEST_ROOT, HC_SESSION, HC_TERMINAL_ID, HC_TERMINAL_SOCKET, HERDR_ACCEPTANCE_CLIENT } = process.env;
appendFileSync(join(HERDR_TEST_ROOT, 'acceptance-calls.jsonl'), JSON.stringify({
  argv: process.argv.slice(2),
  env: { HC_SESSION, HC_TERMINAL_ID, HC_TERMINAL_SOCKET, HERDR_ACCEPTANCE_CLIENT },
}) + '\n');
