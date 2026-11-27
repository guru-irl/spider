// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { register } from 'node:module';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const entry = process.env.SPIDER_HERDR_E2E_SYNC_ENTRY;
const log = process.env.SPIDER_HERDR_E2E_SYNC_LOG;
if (!entry || !isAbsolute(entry) || !log || !isAbsolute(log)) throw new Error('Missing fixture sync observation paths');
register(new URL('./roam-sync-observer-loader.mjs', import.meta.url), import.meta.url, {
  data: { entry: pathToFileURL(entry).href },
});
