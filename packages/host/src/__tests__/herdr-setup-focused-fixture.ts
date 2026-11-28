// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFile, writeFile } from 'node:fs/promises';
import { fixture, type FixtureOptions, type SetupFixture } from './herdr-setup-fixture.js';

// Keep actual app subprocess calls. Static reads need no Node startup, while
// selections still use the same fake that writes settings and checks backups.
// A null version leaves version queries to tests that change the fake's reply.
export async function useStaticSetupApp<T extends SetupFixture>(f: T, version: '0.1.12' | '0.1.13' | '0.1.16' | null = '0.1.12'): Promise<T> {
  const binary = f.request.config.app.binary;
  const wrapper = await readFile(binary, 'utf8');
  const shebang = '#!/bin/sh\n';
  if (!wrapper.startsWith(shebang)) throw new Error('Expected the setup fixture app wrapper');
  const versionReply = version === null ? '' : `  --version) printf '%s\\n' 'herdr-app ${version}'; exit 0 ;;\n`;
  await writeFile(binary, `${shebang}case "$1" in\n${versionReply}  ls|commands) printf '%s\\n' '{"spaces":[]}'; exit 0 ;;\nesac\n${wrapper.slice(shebang.length)}`);
  return f;
}

export async function focusedSetupFixture(options: FixtureOptions = { coreTransport: 'socket', localOnly: true }, requireAppBackup = false): Promise<SetupFixture> {
  return useStaticSetupApp(await fixture('fake', requireAppBackup, options));
}
