// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFileSync } from 'node:fs';
import { parseOptions } from '../../../../scripts/herdr-e2e.mjs';

const config = JSON.parse(readFileSync(new URL('./ci-stories.json', import.meta.url), 'utf8'));
const input = process.argv[2] ?? '';
const stories = input.trim() ? input.split(',').map(value => value.trim()) : config.stories;
if (!Array.isArray(stories) || !stories.length || stories.some(id => typeof id !== 'string' || !id)) {
  throw new Error('Story IDs cannot be empty');
}
if (new Set(stories).size !== stories.length) throw new Error('Story IDs must be unique');
parseOptions(['--tier', 'headless', '--story', stories.join(',')], {});
const include = stories.map(story => {
  const timeout = config.timeouts?.[story] ?? 5;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 5) throw new Error(`Invalid timeout for ${story}`);
  return { story, timeout };
});
process.stdout.write(JSON.stringify({ include }));
