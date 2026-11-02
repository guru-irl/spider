// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, expect, it } from 'vitest';
import { runtimeArgvMatches } from './processes.js';

describe('owned runtime process selection', () => {
  const runtime = '/owned/spider-remote-runtime-1234.mjs', request = '/owned/runtime/job/request.json';
  it('accepts the exact runtime script and owned request arguments', () => {
    expect(runtimeArgvMatches(['node', runtime, request], request)).toBe(true);
  });
  it('rejects a shell inspector whose source mentions both paths', () => {
    expect(runtimeArgvMatches(['/bin/sh', '-c', `node -e 'inspect ${runtime} ${request}'`], request)).toBe(false);
    expect(runtimeArgvMatches(['node', '--input-type=module', '-e', `inspect ${runtime} ${request}`], request)).toBe(false);
  });
  it('rejects another request and a payload child instead of its wrapper', () => {
    expect(runtimeArgvMatches(['node', runtime, request + '.other'], request)).toBe(false);
    expect(runtimeArgvMatches(['node', '/owned/controlled.mjs', request], request)).toBe(false);
  });
});
