// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { registerHooks } from 'node:module';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { instrumentOwnerBundle } from './roam-owner-observer.mjs';

const entry = process.env.SPIDER_HERDR_E2E_OWNER_ENTRY;
const directory = process.env.SPIDER_HERDR_E2E_OWNER_DIR;
if (!entry || !isAbsolute(entry) || !directory || !isAbsolute(directory)) throw new Error('Missing fixture owner observation paths');
const target = pathToFileURL(entry).href;
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== target) return loaded;
    if (loaded.format !== 'module' || loaded.source == null) throw new Error('Invalid fixture owner entry');
    const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8');
    return { ...loaded, source: instrumentOwnerBundle(source) };
  },
});
