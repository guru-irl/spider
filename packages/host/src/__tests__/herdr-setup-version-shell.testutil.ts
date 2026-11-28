// SPDX-License-Identifier: MIT
import { readFile, writeFile } from 'node:fs/promises';

// Tests replace this exact version reply with process.exit(1). Keep the app
// subprocess and its failure status, but avoid starting Node for read-only
// version checks; selections still run the original script.
export async function installFastAppVersion(binary: string, script: string, version: string): Promise<void> {
  const marker = `console.log('herdr-app ${version}')`;
  if (!(await readFile(script, 'utf8')).includes(marker)) throw new Error('Expected the fake app version reply');
  const wrapper = await readFile(binary, 'utf8'), start = '#!/bin/sh\ncase "$1" in\n';
  if (!wrapper.startsWith(start)) throw new Error('Expected the setup fixture app wrapper');
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const versionCase = `  --version) if grep -Fq -- ${quote(marker)} ${quote(script)}; then printf '%s\\n' ${quote(`herdr-app ${version}`)}; exit 0; else exit 1; fi ;;\n`;
  await writeFile(binary, start + versionCase + wrapper.slice(start.length));
}
