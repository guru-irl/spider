// SPDX-License-Identifier: MIT
import { expect, test } from 'vitest';
import { prepareRemoteProgram } from '../../../context/src/remote-plan.js';
import type { RuntimeTarget } from '../contracts.js';
import { createJobStore } from '../jobs/store.js';
import { monitorFixture, on } from './herdr-monitor-fixture.js';

const target: RuntimeTarget = { on, cwd: null, directory: '/fixture/programs', commands: {}, environment: {}, nodePath: '/fixture/node', runtimePath: '/fixture/runtime.mjs', runtimeSha256: 'fixture' };
const values = [
  { word: 'fixture-secret-42!', secret: 'fixture-secret-42!' },
  { word: '"fixture secret 42!"', secret: 'fixture secret 42!' },
  { word: "'fixture secret 42!'", secret: 'fixture secret 42!' },
];
const envNames = ['PASSWORD', 'PASSWD', 'TOKEN', 'SECRET', 'API_KEY', 'PGPASSWORD', 'db_passwd_value', 'service_ToKeN_value', 'app_SeCrEt_value', 'service_api_key_value'];
const flags = ['--password', '--passwd', '--token', '--secret', '--api-key'];

// Removing prepare's scrub call must expose this known token before any feed-side second scrub.
test('preparation redacts a known token before the command preview can enter the job journal', async () => {
  const code = 'printf ghp_0123456789abcdefghij';
  const program = await prepareRemoteProgram({ kind: 'code', language: 'shell', code }, target);
  expect(program.commandPreview).toBe('printf [REDACTED:github_personal_token]');
  expect(program.files.some(file => file.bytes.toString() === code)).toBe(true);
});

for (const name of envNames) for (const { word, secret } of values) {
  // Matching only known token formats, or losing quoted tails, exposes the synthetic credential.
  test(`preparation redacts ${name}=${word} without changing ordinary arguments`, async () => {
    const code = `${name}=${word} psql --dbname appdb`;
    const program = await prepareRemoteProgram({ kind: 'code', language: 'shell', code }, target);
    expect(program.commandPreview).not.toContain(secret);
    expect(program.commandPreview).not.toContain('42!');
    expect(program.commandPreview).toContain('[REDACTED:');
    expect(program.commandPreview).toContain('psql --dbname appdb');
    expect(program.files.some(file => file.bytes.toString() === code)).toBe(true);
  });
}

for (const flag of flags) for (const separator of [' ', '=']) for (const { word, secret } of values) {
  test(`preparation redacts ${flag}${separator}${word} without changing ordinary arguments`, async () => {
    const code = `az login ${flag}${separator}${word} --tenant fixture`;
    const program = await prepareRemoteProgram({ kind: 'code', language: 'shell', code }, target);
    expect(program.commandPreview).not.toContain(secret);
    expect(program.commandPreview).not.toContain('42!');
    expect(program.commandPreview).toContain('[REDACTED:');
    expect(program.commandPreview).toContain('--tenant fixture');
    expect(program.files.some(file => file.bytes.toString() === code)).toBe(true);
  });
}

test('preparation leaves ordinary assignments and arguments untouched', async () => {
  const code = 'PGUSER=reader DB_NAME="test data" psql --username reader --password-policy strict --tokenizer ordinary --dbname=appdb';
  const program = await prepareRemoteProgram({ kind: 'code', language: 'shell', code }, target);
  expect(program.commandPreview).toBe(code);
});

test('password assignment and password flag values are absent from saved job previews', async () => {
  const h = await monitorFixture(), jobs = h.monitor();
  const inputs = ['PGPASSWORD=hunter2hunter2 psql --dbname appdb', 'az login --password "S3cr3tP@ssw0rd!"', 'az login --password=S3cr3tP@ssw0rd!'];
  for (const code of inputs) await jobs.start(() => prepareRemoteProgram({ kind: 'code', language: 'shell', code }, target), h.owner, on, {});
  const journal = await createJobStore(h.f.root, h.owner.sessionId).read();
  expect(journal.jobs).toHaveLength(3);
  for (const job of journal.jobs) {
    expect(job.commandPreview).toContain('[REDACTED:');
    expect(job.commandPreview).not.toMatch(/hunter2hunter2|S3cr3tP@ssw0rd!/);
  }
});
