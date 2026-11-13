// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { invokeBytes } from '../client/bytes.js';
import { createArgvClient } from '../client/argv-client.js';
import { invokeCli as invokeHc } from '../client/hc.js';
import { createTransport } from '../../../roam/src/transport.js';
import { posix, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { migrate, openDb } from '@spider/db-core';
import { buildRoamEntries } from '../../../../scripts/build-roam.mjs';
import { openJournal } from '../../../roam/src/journal.js';
import { createByteDaemonFixture, createClientFixture } from './testutil.js';

const machine = { id: 'remote-core-1', name: 'box-1.invalid', host: 'box-1.invalid', target: 'box-1.invalid', session: 'remote', via: false };
const peer = { machineId: '00000000-0000-4000-8000-000000000001', alias: machine.name, node: '/fixture/node', pi: '/fixture/pi', cli: '/fixture/cli', core: '/fixture/hc', globalRoot: '/fixture/global' };
const identityPath = posix.join(peer.globalRoot, 'roam', 'machine.json');

function nativeDeadline(argv: readonly string[], budgetMs: number, elapsedMs: number): string {
  const index = argv.indexOf('--timeout');
  expect(index).toBeGreaterThanOrEqual(0);
  const value = argv[index + 1];
  expect(value).toMatch(/^[1-9][0-9]*$/);
  expect(Number(value)).toBeLessThanOrEqual(Math.max(1, Math.floor(budgetMs / 1000)));
  expect(Number(value)).toBeGreaterThanOrEqual(Math.max(1, Math.floor((budgetMs - elapsedMs) / 1000)));
  return value;
}

test('workspace transport subpaths resolve in bundled fixtures', async () => {
  const { buildFixture } = await import('../../../../scripts/test-bundle.js');
  const bundle = await buildFixture({
    stdin: { contents: "export { createTransport } from '@spider/roam/transport';", resolveDir: process.cwd() },
    write: false,
  });
  const inputs = Object.keys(bundle.metafile.inputs);
  expect(inputs.some(path => path.endsWith('/packages/roam/src/transport.ts'))).toBe(true);
  expect(inputs.some(path => path.endsWith('/packages/herdr/src/client/argv-client.ts'))).toBe(true);
}, 5000);

test('roaming transport refuses an implicit default core before any invocation', async () => {
  const fixture = await createClientFixture();
  try {
    const env = { ...fixture.localEnv };
    delete env.HC_SOCKET; delete env.HC_TERMINAL_SOCKET; delete env.HC_SESSION; delete env.XDG_STATE_HOME; delete env.XDG_RUNTIME_DIR;
    expect(() => createTransport({ binary: fixture.hcBinary, env, enrolled: [peer] })).toThrow(/Tests must use a socket/);
    expect(await fixture.calls()).toEqual([]);
  } finally { await fixture.close(); }
}, 5000);

test('binary read never passes through JSON or UTF8', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ rawReplyBase64: 'AP8KgA==' });
    const received = await invokeBytes(fixture.hcBinary, ['fixture-bytes'], fixture.localEnv, { timeoutMs: 1000, maxBytes: 4 });
    expect(received).toEqual(Buffer.from([0, 255, 10, 128]));
  } finally {
    await fixture.close();
  }
}, 5000);

test('raw stdin is captured before the caller can reuse its buffer', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: { execEchoStdin: true } });
    const input = Buffer.alloc(512 * 1024, 0xa5);
    const expected = Buffer.from(input);
    const pending = invokeBytes(fixture.hcBinary, ['exec', '--on', machine.name, '--timeout', '2', '--stdin', '--', '/fixture/node'], fixture.localEnv,
      { timeoutMs: 2000, maxBytes: input.length, stdin: input });
    input.fill(0x5a);
    const received = await pending;
    expect(received.equals(expected)).toBe(true);
  } finally {
    await fixture.close();
  }
}, 5000);

test('raw stdin failure is not reported as a successful byte transfer', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ rawReplyBase64: '' });
    await expect(invokeBytes(fixture.hcBinary, ['fixture-bytes'], fixture.localEnv, {
      timeoutMs: 2000, maxBytes: 16, stdin: Buffer.alloc(1024 * 1024, 0x5a),
    })).rejects.toMatchObject({ code: 'stdin-error' });
  } finally {
    await fixture.close();
  }
}, 5000);

test.each([
  [1, ['roam', 'agent', '{}']],
  [2, ['roam', 'observe', 'doctor']],
  [3, ['roam', 'artifact', 'receive', '{}']],
])('private command rejects exit %s even with a complete-looking reply', async (exitCode, argv) => {
  const fixture = await createClientFixture();
  try {
    const reply = Buffer.from(JSON.stringify({ code: 0, reason: 'complete' }));
    await fixture.configure({ machines: [machine], roamFixture: { execReplyBase64: reply.toString('base64'), execExitCode: exitCode } });
    await fixture.writeRoamFile(peer.alias, identityPath, Buffer.from(JSON.stringify({ machineId: peer.machineId })));
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    const resolved = await transport.resolve(peer);
    await expect(transport.exec(resolved, argv, { timeoutMs: 1000, maxBytes: 1024 }))
      .rejects.toMatchObject({ code: 'cli-exit', details: { exitCode } });
  } finally { await fixture.close(); }
}, 5000);

test.each(['needs_login', 'spawn_failed'])('raw hc failure preserves its %s kind without exposing its message', async kind => {
  const fixture = await createClientFixture();
  try {
    const stderr = JSON.stringify({ error: { kind, message: 'private fixture value' } });
    const script = `process.stdout.write('{"code":0}'); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 3;`;
    const error = await invokeBytes(process.execPath, ['-e', script], fixture.localEnv, { timeoutMs: 1000, maxBytes: 128 }).catch(value => value);
    expect(error).toMatchObject({ code: kind, details: { exitCode: 3 } });
    expect(JSON.stringify(error)).not.toContain('private fixture value');
  } finally { await fixture.close(); }
}, 5000);

test('raw program failure keeps bounded stderr and never accepts its stdout', async () => {
  const fixture = await createClientFixture();
  try {
    const script = `process.stdout.write('{"code":0}'); process.stderr.write('missing bundle: ' + 'x'.repeat(5000)); process.exitCode = 1;`;
    const error = await invokeBytes(process.execPath, ['-e', script], fixture.localEnv, { timeoutMs: 1000, maxBytes: 128 }).catch(value => value);
    expect(error).toMatchObject({ code: 'cli-exit', details: { exitCode: 1, stderr: expect.stringContaining('missing bundle: ') } });
    expect(Buffer.byteLength(error.details.stderr)).toBeLessThanOrEqual(4096);
    expect(JSON.stringify(error)).not.toContain('{\\"code\\":0}');
  } finally { await fixture.close(); }
}, 5000);

test('raw errors do not expose output or consume the reply budget', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ failure: { kind: 'blocked', message: 'private fixture value' }, failureExitCode: 7 });
    const error = await invokeBytes(fixture.hcBinary, ['fixture-bytes'], fixture.localEnv, { timeoutMs: 1000, maxBytes: 0 }).catch(value => value);
    expect(error).toMatchObject({ code: 'blocked', details: { exitCode: 7 } });
    expect(JSON.stringify(error)).not.toContain('private fixture value');
  } finally {
    await fixture.close();
  }
}, 5000);

test('remote exec sends its remaining deadline before the payload without stdin', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: { execReplyBase64: 'AP8KgA==' } });
    const client = createArgvClient({ binary: fixture.hcBinary, env: fixture.localEnv });
    const remoteArgs = ['/fixture/node', '/fixture/cli', 'inspect', "x'; literal"];
    const started = performance.now();
    const reply = await client.exec(machine.name, remoteArgs, { timeoutMs: 120_001, maxBytes: 4 });
    const elapsed = performance.now() - started;
    expect(reply).toEqual(Buffer.from([0, 255, 10, 128]));
    const calls = await fixture.calls();
    const argv = calls.find(call => call.argv[0] === 'exec')?.argv ?? [];
    const seconds = nativeDeadline(argv, 120_001, elapsed);
    expect(argv).toEqual(['exec', '--on', machine.name, '--timeout', seconds, '--', ...remoteArgs]);
  } finally {
    await fixture.close();
  }
}, 5000);

test('remote exec forwards binary stdin only with the native stdin flag', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: { execEchoStdin: true } });
    const client = createArgvClient({ binary: fixture.hcBinary, env: fixture.localEnv });
    const input = Buffer.from([255, 0, 128, 10]);
    const started = performance.now();
    const reply = await client.exec(machine.name, ['/fixture/node', '/fixture/cli', 'import'], {
      timeoutMs: 600_000, maxBytes: 4, stdin: input,
    });
    const elapsed = performance.now() - started;
    expect(reply).toEqual(input);
    const calls = await fixture.calls();
    const argv = calls.find(call => call.argv[0] === 'exec')?.argv ?? [];
    const seconds = nativeDeadline(argv, 600_000, elapsed);
    expect(argv).toEqual(['exec', '--on', machine.name, '--timeout', seconds, '--stdin', '--', '/fixture/node', '/fixture/cli', 'import']);
  } finally {
    await fixture.close();
  }
}, 5000);

test('the argv client snapshots per-call limits and stdin before probing the core', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: { execEchoStdin: true } });
    const client = createArgvClient({ binary: fixture.hcBinary, env: fixture.localEnv });
    const input = Buffer.from([255, 0, 128, 10]);
    const options = { timeoutMs: 120_001, maxBytes: 4, stdin: input };
    const started = performance.now();
    const pending = client.exec(machine.name, ['/fixture/node'], options);
    input.fill(0); options.timeoutMs = 1; options.maxBytes = 1;
    expect(await pending).toEqual(Buffer.from([255, 0, 128, 10]));
    const elapsed = performance.now() - started;
    nativeDeadline((await fixture.calls()).find(call => call.argv[0] === 'exec')?.argv ?? [], 120_001, elapsed);
  } finally {
    await fixture.close();
  }
}, 5000);

test('the argv client snapshots its binary and core environment', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: { execReplyBase64: 'AQ==' } });
    const options = { binary: fixture.hcBinary, env: { ...fixture.localEnv } };
    const client = createArgvClient(options);
    options.binary = join(fixture.root, 'missing-hc');
    options.env.HC_SOCKET = fixture.foreignSocket;
    expect(await client.exec(machine.name, ['/fixture/node'], { timeoutMs: 1000, maxBytes: 1 })).toEqual(Buffer.from([1]));
    expect((await fixture.calls()).find(call => call.argv[0] === 'exec')?.env.HC_SOCKET).toBe(fixture.localSocket);
  } finally {
    await fixture.close();
  }
}, 5000);

test('remote argv cannot fall back locally', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [], roamFixture: {} });
    const marker = join(fixture.root, 'local-payload');
    const script = join(fixture.root, 'payload.mjs');
    await writeFile(script, "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], 'executed');\n");
    const client = createArgvClient({ binary: fixture.hcBinary, env: fixture.localEnv });
    await expect(client.exec('unknown.invalid', [process.execPath, script, marker], { timeoutMs: 1000, maxBytes: 1024 })).rejects.toMatchObject({ code: 'machine_not_found' });
    expect(existsSync(marker)).toBe(false);
    const calls = (await fixture.calls()).filter(call => call.argv[0] === 'exec');
    expect(calls).toHaveLength(1);
    expect(calls[0].argv.slice(0, 3)).toEqual(['exec', '--on', 'unknown.invalid']);
  } finally {
    await fixture.close();
  }
}, 5000);

test.each([['--on=other.invalid'], ['--on', 'other.invalid']])('ordinary fake runs do not interpret payload flags %s as routing options', async (...args) => {
  const fixture = await createClientFixture();
  try {
    const result = await invokeHc(fixture.hcBinary, ['run', '--json', '--bg', '--', '/fixture/program', ...args], fixture.localEnv);
    expect(result).toMatchObject({ address: 't2' });
  } finally {
    await fixture.close();
  }
}, 5000);

test('leading-dash aliases with punctuation remain one remote routing argument', async () => {
  const fixture = await createClientFixture();
  try {
    const alias = '--odd;name.invalid';
    await fixture.configure({ machines: [{ ...machine, name: alias }], roamFixture: { execReplyBase64: 'AQ==' } });
    const client = createArgvClient({ binary: fixture.hcBinary, env: fixture.localEnv });
    expect(await client.exec(alias, ['/fixture/node', '; literal'], { timeoutMs: 1000, maxBytes: 1 })).toEqual(Buffer.from([1]));
    expect((await fixture.calls()).find(call => call.argv[0] === 'exec')?.argv).toEqual([
      'exec', `--on=${alias}`, '--timeout', '1', '--', '/fixture/node', '; literal',
    ]);
  } finally {
    await fixture.close();
  }
}, 5000);

test('direct execution above 600 seconds refuses instead of starting a payload', async () => {
  const fixture = await createClientFixture();
  try {
    const client = createArgvClient({ binary: fixture.hcBinary, env: fixture.localEnv });
    await expect(client.exec(machine.name, ['/fixture/node'], { timeoutMs: 600_001, maxBytes: 16 }))
      .rejects.toMatchObject({ code: 'invalid-cli-deadline' });
    expect(await fixture.calls()).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 5000);

test('background launch errors preserve their code without leaking hc output', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ failure: { kind: 'blocked', message: 'private fixture value', hint: 'private fixture value' } });
    const client = createArgvClient({ binary: fixture.hcBinary, env: fixture.localEnv });
    const error = await client.run(machine.name, ['/fixture/node'], { 'spider.operation': 'operation-7' }).catch(value => value);
    expect(error).toMatchObject({ code: 'blocked' });
    expect(error.message).not.toContain('private fixture value');
    expect(JSON.stringify(error)).not.toContain('private fixture value');
  } finally {
    await fixture.close();
  }
}, 5000);

test('background launch receipt is not completion', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: {} });
    const client = createArgvClient({ binary: fixture.hcBinary, env: fixture.localEnv });
    const receipt = await client.run(machine.name, ['/fixture/node', '/fixture/cli', 'import'], { 'spider.operation': 'operation-7' });
    expect(receipt).toEqual({ terminal: 'box-1.invalid/t2' });
    const calls = await fixture.calls();
    const runArgv = calls.find(call => call.argv[0] === 'run')?.argv;
    expect(runArgv).toEqual(expect.arrayContaining(['--bg', '--no-notify', '--outlive-parent', '--no-parent']));
    expect(runArgv).toEqual([
      'run', '--json', '--bg', '--no-notify', '--outlive-parent', '--no-parent', '--on', machine.name,
      '--label', 'spider.operation=operation-7', '--', '/fixture/node', '/fixture/cli', 'import',
    ]);
    expect(calls.filter(call => ['get', 'read', 'events'].includes(call.argv[0]))).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 5000);

test('roaming launch tags the operation and machine without polling for completion', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: {} });
    await fixture.writeRoamFile(peer.alias, identityPath, Buffer.from(JSON.stringify({ machineId: peer.machineId })));
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    const resolved = await transport.resolve(peer);
    expect(await transport.run(resolved, ['import'], 'operation-7')).toEqual({ terminal: 'box-1.invalid/t2' });
    const calls = await fixture.calls();
    const run = calls.find(call => call.argv[0] === 'run')?.argv;
    expect(run).toEqual(expect.arrayContaining(['--bg', '--no-notify', '--outlive-parent', '--no-parent',
      'spider.operation=operation-7', `spider.machine=${peer.machineId}`, peer.node, peer.cli, 'import']));
    expect(calls.filter(call => ['get', 'read', 'events'].includes(call.argv[0]))).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 5000);

test('daemon-backed fake hc routes binary transfers without text conversion', async () => {
  const fixture = await createByteDaemonFixture();
  try {
    await fixture.writeRemoteFile(identityPath, Buffer.from(JSON.stringify({ machineId: peer.machineId })));
    const transport = createTransport({ binary: fixture.binary, env: fixture.env, enrolled: [peer] });
    const resolved = await transport.resolve(peer);
    const input = Buffer.from([0, 255, 10, 128]);
    await transport.write(resolved, '/fixture/artifact', input, 30_000);
    expect(await transport.read(resolved, '/fixture/artifact', { timeoutMs: 30_000, maxBytes: 4 })).toEqual(input);
    expect(await fixture.readRemoteFile('/fixture/artifact')).toEqual(input);
    expect((await fixture.calls()).filter(call => call.argv[0] === 'exec').every(call => call.argv.includes('--on'))).toBe(true);
  } finally {
    await fixture.close();
  }
}, 5000);

test('daemon-backed fake exec forwards binary stdin without executing the payload locally', async () => {
  const fixture = await createByteDaemonFixture();
  try {
    await fixture.configureRemote({ execEchoStdin: true });
    const client = createArgvClient({ binary: fixture.binary, env: fixture.env });
    const input = Buffer.from([255, 0, 128, 10]);
    expect(await client.exec(peer.alias, ['/fixture/node', '/fixture/cli', 'inspect'], { timeoutMs: 1000, maxBytes: 4, stdin: input })).toEqual(input);
    expect(await client.exec(peer.alias, ['/fixture/node', '/fixture/cli', 'inspect'], { timeoutMs: 1000, maxBytes: 4 })).toEqual(Buffer.alloc(0));
  } finally {
    await fixture.close();
  }
}, 5000);

test.each([
  ['host', 'HOST.EXAMPLE.INVALID.'],
  ['target', 'TARGET.EXAMPLE.INVALID.'],
])('resolves an hc %s alias using the machine-list normalization rules', async (_kind, alias) => {
  const fixture = await createClientFixture();
  try {
    const configured = { ...machine, name: 'configured.invalid', host: 'Host.Example.Invalid.', target: 'user@Target.Example.Invalid', via: true };
    const enrolled = { ...peer, alias };
    await fixture.configure({ machines: [configured], roamFixture: { execReplyBase64: 'AQ==' } });
    await fixture.writeRoamFile(alias, identityPath, Buffer.from(JSON.stringify({ machineId: peer.machineId })));
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [enrolled] });
    const resolved = await transport.resolve(enrolled);
    expect(await transport.exec(resolved, ['inspect'], { timeoutMs: 30_000, maxBytes: 16 })).toEqual(Buffer.from([1]));
    expect((await fixture.calls()).find(call => call.argv.includes('inspect'))?.argv).toContain(alias);
  } finally { await fixture.close(); }
}, 5000);

test('an opaque via target is not accepted as a machine alias', async () => {
  const fixture = await createClientFixture();
  try {
    const alias = 'target.example.invalid:22';
    const enrolled = { ...peer, alias };
    await fixture.configure({ machines: [{ ...machine, name: 'configured.invalid', host: 'host.invalid', target: `user@${alias}`, via: true }], roamFixture: {} });
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [enrolled] });
    await expect(transport.resolve(enrolled)).rejects.toMatchObject({ code: 'machine-not-found' });
    expect((await fixture.calls()).some(call => call.argv[0] === 'exec')).toBe(false);
  } finally { await fixture.close(); }
}, 5000);

test('an unknown enrolled alias reports machine-not-found before executing a payload', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [], roamFixture: {} });
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    await expect(transport.resolve(peer)).rejects.toMatchObject({ code: 'machine-not-found', retryable: true });
    expect((await fixture.calls()).some(call => call.argv[0] === 'exec')).toBe(false);
  } finally { await fixture.close(); }
}, 5000);

test('an exact machine name wins over another machine host alias', async () => {
  const fixture = await createClientFixture();
  try {
    const named = { ...machine, id: 'named-core', host: 'named.invalid', target: 'named.invalid' };
    const other = { ...machine, id: 'other-core', name: 'other.invalid', host: peer.alias, target: 'other.invalid' };
    await fixture.configure({ machines: [other, named], roamFixture: { execReplyBase64: 'AQ==' } });
    await fixture.writeRoamFile(peer.alias, identityPath, Buffer.from(JSON.stringify({ machineId: peer.machineId })));
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    const resolved = await transport.resolve(peer);
    await fixture.configure({ machines: [{ ...other, id: 'replaced-other-core' }, named] });
    expect(await transport.exec(resolved, ['inspect'], { timeoutMs: 30_000, maxBytes: 16 })).toEqual(Buffer.from([1]));
    await fixture.configure({ machines: [other, { ...named, id: 'replaced-named-core' }] });
    await expect(transport.exec(resolved, ['inspect'], { timeoutMs: 30_000, maxBytes: 16 })).rejects.toMatchObject({ code: 'core-changed' });
  } finally { await fixture.close(); }
}, 5000);

test('an ambiguous host alias refuses before executing a payload', async () => {
  const fixture = await createClientFixture();
  try {
    const entries = [{ ...machine, name: 'first.invalid', host: peer.alias }, { ...machine, id: 'other-core', name: 'second.invalid', host: peer.alias }];
    await fixture.configure({ machines: entries, roamFixture: {} });
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    await expect(transport.resolve(peer)).rejects.toMatchObject({ code: 'machine-ambiguous' });
    expect((await fixture.calls()).some(call => call.argv[0] === 'exec')).toBe(false);
  } finally { await fixture.close(); }
}, 5000);

test('a stopped core reports core-unavailable and invalidates the old handle without calling hc', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: {} });
    await fixture.writeRoamFile(peer.alias, identityPath, Buffer.from(JSON.stringify({ machineId: peer.machineId })));
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    const resolved = await transport.resolve(peer);
    const before = (await fixture.calls()).length;
    await fixture.stopCore();
    await expect(transport.exec(resolved, ['inspect'], { timeoutMs: 30_000, maxBytes: 16 }))
      .rejects.toMatchObject({ code: 'core-unavailable', retryable: true });
    await expect(transport.exec(resolved, ['inspect'], { timeoutMs: 30_000, maxBytes: 16 }))
      .rejects.toMatchObject({ code: 'peer-invalidated', retryable: true });
    expect((await fixture.calls()).length).toBe(before);
  } finally { await fixture.close(); }
}, 5000);

test('a foreign terminal socket stays core-mismatch instead of core-changed', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: {} });
    const env = { ...fixture.localEnv, HC_TERMINAL_SOCKET: fixture.foreignSocket };
    const transport = createTransport({ binary: fixture.hcBinary, env, enrolled: [peer] });
    await expect(transport.resolve(peer)).rejects.toMatchObject({ code: 'core-mismatch' });
    expect(await fixture.calls()).toEqual([]);
  } finally { await fixture.close(); }
}, 5000);

test('resolves one machine identity per transfer', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: { execReplyBase64: 'AQID' } });
    await fixture.writeRoamFile(peer.alias, identityPath, Buffer.from(JSON.stringify({ machineId: peer.machineId })));
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    const resolved = await transport.resolve(peer);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(resolved).toEqual(peer);
    const input = Buffer.from([0, 255, 10, 128]);
    await transport.write(resolved, '/fixture/artifact', input, 30_000);
    expect(await transport.read(resolved, '/fixture/artifact', { timeoutMs: 30_000, maxBytes: 4 })).toEqual(input);
    const started = performance.now();
    expect(await transport.exec(resolved, ['inspect', "x'; literal"], { timeoutMs: 60_000, maxBytes: 3 })).toEqual(Buffer.from([1, 2, 3]));
    const elapsed = performance.now() - started;
    const calls = await fixture.calls();
    expect(calls.filter(call => call.argv[0] === 'exec' && call.argv.includes(identityPath))).toHaveLength(1);
    const argv = calls.find(call => call.argv.includes('inspect'))?.argv ?? [];
    const seconds = nativeDeadline(argv, 60_000, elapsed);
    expect(argv).toEqual(['exec', '--on', peer.alias, '--timeout', seconds, '--', peer.node, peer.cli, 'inspect', "x'; literal"]);
  } finally {
    await fixture.close();
  }
}, 5000);

test('agent refusal retains its bounded JSON reply on exit zero and uses the enrolled root', async () => {
  const fixture = await createClientFixture();
  try {
    const reply = Buffer.from(JSON.stringify({ code: 1, operationId: 'refused', reason: 'unsafe' }));
    await fixture.configure({ machines: [machine], roamFixture: { execReplyBase64: reply.toString('base64') } });
    await fixture.writeRoamFile(peer.alias, identityPath, Buffer.from(JSON.stringify({ machineId: peer.machineId })));
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    const resolved = await transport.resolve(peer);
    expect(await transport.exec(resolved, ['roam', 'agent', '{}'], { timeoutMs: 1000, maxBytes: 1024 })).toEqual(reply);
    const call = (await fixture.calls()).find(entry => entry.argv.includes('agent'));
    expect(call?.argv).toEqual(['exec', '--on', peer.alias, '--timeout', '1', '--', peer.node, peer.cli,
      '--global-root', peer.globalRoot, 'roam', 'agent', '{}']);
    await fixture.configure({ roamFixture: { execReplyBase64: reply.toString('base64'), execExitCode: 1 } });
    await expect(transport.exec(resolved, ['inspect'], { timeoutMs: 1000, maxBytes: 1024 })).rejects.toMatchObject({ code: 'cli-exit' });
  } finally { await fixture.close(); }
}, 5000);

test('file control export and import use their distinct native deadlines', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: { execReplyBase64: 'AQ==' } });
    await fixture.writeRoamFile(peer.alias, identityPath, Buffer.from(JSON.stringify({ machineId: peer.machineId })));
    await fixture.writeRoamFile(peer.alias, '/fixture/artifact', Buffer.from([1]));
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    const resolved = await transport.resolve(peer);
    const elapsed: number[] = [];
    const measure = async (call: () => Promise<Buffer>) => { const started = performance.now(); await call(); elapsed.push(performance.now() - started); };
    await measure(() => transport.read(resolved, '/fixture/artifact', { timeoutMs: 30_000, maxBytes: 16 }));
    await measure(() => transport.exec(resolved, ['control'], { timeoutMs: 60_000, maxBytes: 16 }));
    await measure(() => transport.exec(resolved, ['export'], { timeoutMs: 120_000, maxBytes: 16 }));
    await measure(() => transport.exec(resolved, ['import'], { timeoutMs: 600_000, maxBytes: 16 }));
    const calls = (await fixture.calls()).filter(call => call.argv[0] === 'exec' && !call.argv.includes(identityPath));
    expect(calls).toHaveLength(4);
    const deadlines = calls.map((call, index) => Number(nativeDeadline(call.argv, [30_000, 60_000, 120_000, 600_000][index], elapsed[index])));
    expect(deadlines[0]).toBeLessThan(deadlines[1]);
    expect(deadlines[1]).toBeLessThan(deadlines[2]);
    expect(deadlines[2]).toBeLessThan(deadlines[3]);
  } finally {
    await fixture.close();
  }
}, 5000);

test.each(['exec', 'read'] as const)('snapshots %s call limits before waiting for core observations', async kind => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: { execReplyBase64: 'AQIDBA==' } });
    await fixture.writeRoamFile(peer.alias, identityPath, Buffer.from(JSON.stringify({ machineId: peer.machineId })));
    await fixture.writeRoamFile(peer.alias, '/fixture/artifact', Buffer.from([1, 2, 3, 4]));
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    const resolved = await transport.resolve(peer);
    const options = { timeoutMs: 30_000, maxBytes: 4 };
    const started = performance.now();
    const pending = kind === 'exec' ? transport.exec(resolved, ['inspect'], options) : transport.read(resolved, '/fixture/artifact', options);
    options.maxBytes = 1;
    options.timeoutMs = 1;
    expect(await pending).toEqual(Buffer.from([1, 2, 3, 4]));
    const elapsed = performance.now() - started;
    const call = (await fixture.calls()).find(entry => entry.argv.includes(kind === 'exec' ? 'inspect' : '/fixture/artifact'));
    nativeDeadline(call?.argv ?? [], 30_000, elapsed);
  } finally {
    await fixture.close();
  }
}, 5000);

test.each(['', 'operation\n7'])('background launch refuses invalid operation ID %j before execution', async id => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: {} });
    await fixture.writeRoamFile(peer.alias, identityPath, Buffer.from(JSON.stringify({ machineId: peer.machineId })));
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    const resolved = await transport.resolve(peer);
    await expect(transport.run(resolved, ['import'], id)).rejects.toMatchObject({ code: 'invalid-operation' });
    expect((await fixture.calls()).filter(call => call.argv[0] === 'run')).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 5000);

test.each(['before', 'during'] as const)('a remote restart %s execution fails the call and keeps core identity', async when => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: { execReplyBase64: 'AQID' } });
    await fixture.writeRoamFile(peer.alias, identityPath, Buffer.from(JSON.stringify({ machineId: peer.machineId })));
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    const resolved = await transport.resolve(peer);
    await fixture.configure({ roamFixture: { execReplyBase64: 'AQID', restart: { when, command: 'exec', target: 'remote' } } });
    await expect(transport.exec(resolved, ['inspect'], { timeoutMs: 60_000, maxBytes: 16 }))
      .rejects.toMatchObject({ code: 'server_stopped', details: { exitCode: 3 } });
    const state = JSON.parse(await readFile(join(fixture.root, 'core.json'), 'utf8'));
    expect(state.coreId).toBe('local-core');
    expect(state.machines[0].id).toBe(machine.id);
    expect(state.roamRestarts).toEqual([{ target: 'remote', on: peer.alias }]);
    expect(await transport.exec(resolved, ['inspect'], { timeoutMs: 60_000, maxBytes: 16 })).toEqual(Buffer.from([1, 2, 3]));
  } finally { await fixture.close(); }
}, 5000);

test.each(['read', 'write', 'run'] as const)('a restart during %s fails the call without rotating IDs', async kind => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: {} });
    await fixture.writeRoamFile(peer.alias, identityPath, Buffer.from(JSON.stringify({ machineId: peer.machineId })));
    await fixture.writeRoamFile(peer.alias, '/fixture/artifact', Buffer.from([1, 2, 3]));
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    const resolved = await transport.resolve(peer);
    const command = kind === 'read' ? 'exec' : kind === 'write' ? 'file' : 'run';
    const target = kind === 'run' ? 'local' : 'remote';
    await fixture.configure({ roamFixture: { restart: { when: 'during', command, target } } });
    const result = kind === 'read' ? transport.read(resolved, '/fixture/artifact', { timeoutMs: 30_000, maxBytes: 16 })
      : kind === 'write' ? transport.write(resolved, '/fixture/written', Buffer.from([0, 255]), 30_000)
      : transport.run(resolved, ['import'], 'operation-7');
    await expect(result).rejects.toMatchObject({ code: 'server_stopped' });
    const state = JSON.parse(await readFile(join(fixture.root, 'core.json'), 'utf8'));
    expect(state.coreId).toBe('local-core');
    expect(state.machines[0].id).toBe(machine.id);
    expect(state.roamRestarts).toEqual([{ target, on: peer.alias }]);
    if (kind === 'read') expect(await transport.read(resolved, '/fixture/artifact', { timeoutMs: 30_000, maxBytes: 16 })).toEqual(Buffer.from([1, 2, 3]));
    if (kind === 'write') {
      expect(await fixture.readRoamFile(peer.alias, '/fixture/written')).toEqual(Buffer.from([0, 255]));
      await transport.write(resolved, '/fixture/written', Buffer.from([0, 255]), 30_000);
      expect(await fixture.readRoamFile(peer.alias, '/fixture/written')).toEqual(Buffer.from([0, 255]));
    }
    if (kind === 'run') expect(state.terminals.find((terminal: { address: string }) => terminal.address === 'box-1.invalid/t2'))
      .toMatchObject({ state: 'live', labels: { 'spider.operation': 'operation-7' } });
  } finally { await fixture.close(); }
}, 5000);

test('a removed machine after a call reports machine-not-found and discards the result', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: {} });
    await fixture.writeRoamFile(peer.alias, identityPath, Buffer.from(JSON.stringify({ machineId: peer.machineId })));
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    const resolved = await transport.resolve(peer);
    await fixture.configure({ roamFixture: { execReplyBase64: 'AQ==', identityChange: { when: 'during', command: 'exec', remove: true } } });
    await expect(transport.exec(resolved, ['inspect'], { timeoutMs: 60_000, maxBytes: 16 }))
      .rejects.toMatchObject({ code: 'machine-not-found', retryable: true });
    const state = JSON.parse(await readFile(join(fixture.root, 'core.json'), 'utf8'));
    expect(state.machines).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 5000);

test('a local core restart fails the call but leaves its permanent identity intact', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: {} });
    await fixture.writeRoamFile(peer.alias, identityPath, Buffer.from(JSON.stringify({ machineId: peer.machineId })));
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    const resolved = await transport.resolve(peer);
    const before = await invokeHc(fixture.hcBinary, ['server', 'status', '--json'], fixture.localEnv) as { core: { id: string }; pid: number };
    await fixture.configure({ roamFixture: { execReplyBase64: 'AQ==', restart: { when: 'during', command: 'exec', target: 'local' } } });
    await expect(transport.exec(resolved, ['inspect'], { timeoutMs: 60_000, maxBytes: 16 })).rejects.toMatchObject({ code: 'server_stopped' });
    const after = await invokeHc(fixture.hcBinary, ['server', 'status', '--json'], fixture.localEnv) as { core: { id: string }; pid: number; uptime_ms: number };
    expect(after.core.id).toBe(before.core.id);
    expect(after.pid).not.toBe(before.pid);
    expect(after.uptime_ms).toBe(0);
    expect(await transport.exec(resolved, ['inspect'], { timeoutMs: 60_000, maxBytes: 16 })).toEqual(Buffer.from([1]));
  } finally { await fixture.close(); }
}, 5000);

test.each([
  ['local core state wipe', 'local'],
  ['remote machine re-add', 'remote'],
] as const)('a %s during a call discards its result', async (_scenario, target) => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: {} });
    await fixture.writeRoamFile(peer.alias, identityPath, Buffer.from(JSON.stringify({ machineId: peer.machineId })));
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    const resolved = await transport.resolve(peer);
    await fixture.configure({ roamFixture: { execReplyBase64: 'AQ==', identityChange: { when: 'during', command: 'exec', target, nextCore: 'replacement-core' } } });
    await expect(transport.exec(resolved, ['inspect'], { timeoutMs: 60_000, maxBytes: 16 }))
      .rejects.toMatchObject({ code: 'core-changed', retryable: true });
    const state = JSON.parse(await readFile(join(fixture.root, 'core.json'), 'utf8'));
    expect(target === 'local' ? state.coreId : state.machines[0].id).toBe('replacement-core');
    const before = (await fixture.calls()).length;
    await expect(transport.exec(resolved, ['inspect'], { timeoutMs: 60_000, maxBytes: 16 })).rejects.toMatchObject({ code: 'core-changed' });
    expect((await fixture.calls()).length).toBe(before);
    const renewed = await transport.resolve(peer);
    expect(await transport.exec(renewed, ['inspect'], { timeoutMs: 60_000, maxBytes: 16 })).toEqual(Buffer.from([1]));
  } finally { await fixture.close(); }
}, 5000);

test.each([
  ['before dispatch', 'before'],
  ['after a committed result is lost', 'during'],
] as const)('a restart %s retries the journalled operation without repeating its effect', async (_phase, when) => {
  const fixture = await createClientFixture();
  let db: ReturnType<typeof openDb> | undefined;
  try {
    const remoteRoot = join(fixture.root, 'remote');
    const bundle = join(fixture.root, 'agent-dist');
    await mkdir(join(remoteRoot, 'roam'), { recursive: true });
    await buildRoamEntries(bundle);
    const remotePeer = { ...peer, node: process.execPath, cli: join(bundle, 'cli.mjs'), globalRoot: remoteRoot };
    const identity = JSON.stringify({ machineId: peer.machineId });
    await writeFile(join(remoteRoot, 'roam', 'machine.json'), identity);
    await writeFile(join(remoteRoot, 'roam', 'config.json'), JSON.stringify({ enabled: false, role: 'box', machineId: peer.machineId,
      hubMachineId: '00000000-0000-4000-8000-000000000002', peers: [], discoveryRoots: [], coreUnit: 'fixture' }));
    db = openDb(join(remoteRoot, 'spider.db'));
    migrate(db, 'global', { machineId: peer.machineId, globalRoot: remoteRoot });
    db.prepare("UPDATE roam_meta SET store_key='global'").run();
    db.prepare("INSERT INTO global_memory(uuid,category,content,created_at) VALUES ('memory-a','insight','portable',1)").run();
    await fixture.configure({ machines: [machine], roamFixture: { executeAgentFixture: true } });
    await fixture.writeRoamFile(peer.alias, posix.join(remoteRoot, 'roam', 'machine.json'), Buffer.from(identity));
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [remotePeer] });
    const resolved = await transport.resolve(remotePeer);
    const operation = { id: 'restart-operation', machineId: peer.machineId, expectedEpoch: null, kind: 'enable-capture', args: { storeKey: 'global' } };
    const argv = ['roam', 'agent', JSON.stringify(operation)];
    await fixture.configure({ roamFixture: { executeAgentFixture: true, restart: { when, command: 'exec', target: 'local' } } });
    await expect(transport.exec(resolved, argv, { timeoutMs: 30_000, maxBytes: 4096 })).rejects.toMatchObject({ code: 'server_stopped' });
    const journalPath = join(remoteRoot, 'roam', 'journal.db');
    if (when === 'before') {
      expect(existsSync(journalPath)).toBe(false);
      expect(db.prepare('SELECT capture_enabled FROM roam_meta').get()).toEqual({ capture_enabled: 0 });
      expect(db.prepare('SELECT count(*) AS count FROM roam_changes').get()).toEqual({ count: 0 });
    } else {
      const committed = openJournal(journalPath).read(operation.id).filter(row => row.action === 'done');
      expect(committed).toHaveLength(1);
      expect(committed[0].result.value).toEqual({ storeKey: 'global', enabled: true });
      expect(db.prepare('SELECT capture_enabled FROM roam_meta').get()).toEqual({ capture_enabled: 1 });
      expect(db.prepare('SELECT count(*) AS count FROM roam_changes').get()).toEqual({ count: 1 });
      db.exec("CREATE TRIGGER capture_once BEFORE UPDATE OF capture_enabled ON roam_meta BEGIN SELECT RAISE(FAIL,'capture repeated'); END");
    }
    const reply = JSON.parse((await transport.exec(resolved, argv, { timeoutMs: 30_000, maxBytes: 4096 })).toString('utf8'));
    expect(reply).toMatchObject({ code: 0, operationId: operation.id, value: { storeKey: 'global', enabled: true } });
    expect(openJournal(journalPath).read(operation.id).filter(row => row.action === 'done')).toHaveLength(1);
    expect(db.prepare('SELECT count(*) AS count FROM roam_changes').get()).toEqual({ count: 1 });
    expect((await fixture.calls()).filter(call => call.argv.includes('agent'))).toHaveLength(2);
    const state = JSON.parse(await readFile(join(fixture.root, 'core.json'), 'utf8'));
    expect(state.coreId).toBe('local-core');
    expect(state.machines[0].id).toBe(machine.id);
  } finally { db?.close(); await fixture.close(); }
}, 5000);

test('file write refuses a success reply when stdin closes early', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: {} });
    await fixture.writeRoamFile(peer.alias, identityPath, Buffer.from(JSON.stringify({ machineId: peer.machineId })));
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    const resolved = await transport.resolve(peer);
    await fixture.configure({ roamFixture: { fileEarlySuccess: true } });
    await expect(transport.write(resolved, '/fixture/artifact', Buffer.alloc(1024 * 1024, 0x5a), 30_000))
      .rejects.toMatchObject({ code: 'stdin-error' });
    await expect(fixture.readRoamFile(peer.alias, '/fixture/artifact')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await fixture.close();
  }
}, 5000);

test('file write errors preserve their code without leaking hc output', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: {} });
    await fixture.writeRoamFile(peer.alias, identityPath, Buffer.from(JSON.stringify({ machineId: peer.machineId })));
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    const resolved = await transport.resolve(peer);
    await fixture.configure({ roamFixture: { fileFailure: { kind: 'permission_denied', message: 'private fixture value', hint: 'private fixture value' } } });
    const error = await transport.write(resolved, '/fixture/artifact', Buffer.from([1]), 30_000).catch(value => value);
    expect(error).toMatchObject({ code: 'permission_denied' });
    expect(error.message).not.toContain('private fixture value');
    expect(JSON.stringify(error)).not.toContain('private fixture value');
  } finally {
    await fixture.close();
  }
}, 5000);

test('a mismatched machine UUID refuses before launching the remote CLI', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: {} });
    await fixture.writeRoamFile(peer.alias, identityPath, Buffer.from(JSON.stringify({ machineId: '00000000-0000-4000-8000-000000000002' })));
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    await expect(transport.resolve(peer)).rejects.toMatchObject({ code: 'machine-mismatch' });
    expect((await fixture.calls()).filter(call => call.argv.includes(peer.cli))).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 5000);

test.each([
  ['malformed JSON', Buffer.from('{')],
  ['invalid UTF-8', Buffer.concat([Buffer.from(`{"machineId":"${peer.machineId}","ignored":"`), Buffer.from([255]), Buffer.from('"}')])],
  ['missing UUID', Buffer.from('{}')],
])('rejects %s in the remote identity before payload execution', async (_label, contents) => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: {} });
    await fixture.writeRoamFile(peer.alias, identityPath, contents);
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    await expect(transport.resolve(peer)).rejects.toMatchObject({ code: 'machine-mismatch' });
    expect((await fixture.calls()).some(call => call.argv.includes(peer.cli))).toBe(false);
  } finally {
    await fixture.close();
  }
}, 5000);

test('an unreadable identity invalidates an earlier handle', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: { execReplyBase64: 'AQ==' } });
    await fixture.writeRoamFile(peer.alias, identityPath, Buffer.from(JSON.stringify({ machineId: peer.machineId })));
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    const resolved = await transport.resolve(peer);
    await fixture.removeRoamFile(peer.alias, identityPath);
    await expect(transport.resolve(peer)).rejects.toMatchObject({ code: 'cli-exit' });
    const calls = (await fixture.calls()).length;
    await expect(transport.exec(resolved, ['inspect'], { timeoutMs: 60_000, maxBytes: 16 })).rejects.toMatchObject({ code: 'peer-invalidated', retryable: true });
    expect((await fixture.calls()).length).toBe(calls);
  } finally {
    await fixture.close();
  }
}, 5000);

test('a peer without a resolved handle cannot launch a payload', async () => {
  const fixture = await createClientFixture();
  try {
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    await expect(transport.exec(peer, ['inspect'], { timeoutMs: 60_000, maxBytes: 16 })).rejects.toMatchObject({ code: 'unresolved-peer' });
    expect(await fixture.calls()).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 5000);

test('a copied peer cannot impersonate an existing resolved handle', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: { execReplyBase64: 'AQ==' } });
    await fixture.writeRoamFile(peer.alias, identityPath, Buffer.from(JSON.stringify({ machineId: peer.machineId })));
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    const resolved = await transport.resolve(peer);
    await expect(transport.exec({ ...resolved }, ['inspect'], { timeoutMs: 60_000, maxBytes: 16 })).rejects.toMatchObject({ code: 'unresolved-peer' });
    expect((await fixture.calls()).some(call => call.argv.includes('inspect'))).toBe(false);
  } finally {
    await fixture.close();
  }
}, 5000);

test('unknown or revoked aliases refuse before payload launch', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: {} });
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    await expect(transport.resolve({ ...peer, alias: 'unknown.invalid' })).rejects.toMatchObject({ code: 'machine-not-enrolled' });
    const revoked = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [] });
    await expect(revoked.resolve(peer)).rejects.toMatchObject({ code: 'machine-not-enrolled' });
    expect(await fixture.calls()).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 5000);

test('revoking an enrolled peer refuses existing handles and future handshakes', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: { execReplyBase64: 'AQID' } });
    await fixture.writeRoamFile(peer.alias, identityPath, Buffer.from(JSON.stringify({ machineId: peer.machineId })));
    const enrolled = [{ ...peer }];
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled });
    const resolved = await transport.resolve(peer);
    enrolled.splice(0, 1);
    await expect(transport.exec(resolved, ['inspect'], { timeoutMs: 60_000, maxBytes: 16 }))
      .rejects.toMatchObject({ code: 'machine-not-enrolled' });
    await expect(transport.resolve(peer)).rejects.toMatchObject({ code: 'machine-not-enrolled' });
    expect((await fixture.calls()).some(call => call.argv.includes('inspect'))).toBe(false);
  } finally {
    await fixture.close();
  }
}, 5000);

test('revocation during the first core observation prevents payload launch', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: {} });
    await fixture.writeRoamFile(peer.alias, identityPath, Buffer.from(JSON.stringify({ machineId: peer.machineId })));
    const enrolled = [{ ...peer }];
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled });
    const resolved = await transport.resolve(peer);
    const pending = transport.exec(resolved, ['inspect'], { timeoutMs: 60_000, maxBytes: 16 });
    enrolled.splice(0, 1);
    await expect(pending).rejects.toMatchObject({ code: 'machine-not-enrolled' });
    expect((await fixture.calls()).some(call => call.argv.includes('inspect'))).toBe(false);
  } finally {
    await fixture.close();
  }
}, 5000);

test('a restart during re-resolution invalidates earlier handles without another hc call', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: {} });
    await fixture.writeRoamFile(peer.alias, identityPath, Buffer.from(JSON.stringify({ machineId: peer.machineId })));
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    const first = await transport.resolve(peer);
    await fixture.configure({ roamFixture: { restart: { when: 'during', command: 'exec', target: 'remote' } } });
    await expect(transport.resolve(peer)).rejects.toMatchObject({ code: 'server_stopped' });
    const before = (await fixture.calls()).length;
    await expect(transport.exec(first, ['inspect'], { timeoutMs: 60_000, maxBytes: 16 }))
      .rejects.toMatchObject({ code: 'peer-invalidated', retryable: true });
    expect((await fixture.calls()).length).toBe(before);
    const state = JSON.parse(await readFile(join(fixture.root, 'core.json'), 'utf8'));
    expect(state.machines[0].id).toBe(machine.id);
    expect((await transport.resolve(peer)).machineId).toBe(peer.machineId);
  } finally { await fixture.close(); }
}, 5000);

test('re-enrollment replaces old paths even when the core has not changed', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: { execReplyBase64: 'AQ==' } });
    await fixture.writeRoamFile(peer.alias, identityPath, Buffer.from(JSON.stringify({ machineId: peer.machineId })));
    const enrolled = [peer];
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled });
    const first = await transport.resolve(peer);
    const updated = { ...peer, node: '/fixture/updated-node', cli: '/fixture/updated-cli' };
    enrolled.splice(0, 1, updated);
    const second = await transport.resolve(updated);
    expect(await transport.exec(second, ['inspect'], { timeoutMs: 60_000, maxBytes: 16 })).toEqual(Buffer.from([1]));
    expect((await fixture.calls()).some(call => call.argv.includes(updated.node) && call.argv.includes(updated.cli))).toBe(true);
    await expect(transport.exec(first, ['inspect'], { timeoutMs: 60_000, maxBytes: 16 })).rejects.toMatchObject({ code: 'peer-invalidated', retryable: true });
  } finally {
    await fixture.close();
  }
}, 5000);

test('changed core invalidates the old handle without changing enrollment', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: { execReplyBase64: 'AQID' } });
    await fixture.writeRoamFile(peer.alias, identityPath, Buffer.from(JSON.stringify({ machineId: peer.machineId })));
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    const first = await transport.resolve(peer);
    await fixture.configure({ machines: [{ ...machine, id: 'remote-core-2' }] });
    await expect(transport.exec(first, ['inspect'], { timeoutMs: 60_000, maxBytes: 16 }))
      .rejects.toMatchObject({ code: 'core-changed', retryable: true });
    expect((await fixture.calls()).some(call => call.argv.includes('inspect'))).toBe(false);
    const second = await transport.resolve(peer);
    expect(second.machineId).toBe(peer.machineId);
    expect(await transport.exec(second, ['inspect'], { timeoutMs: 60_000, maxBytes: 16 })).toEqual(Buffer.from([1, 2, 3]));
    await expect(transport.exec(first, ['inspect'], { timeoutMs: 60_000, maxBytes: 16 })).rejects.toMatchObject({ code: 'core-changed' });
  } finally {
    await fixture.close();
  }
}, 5000);

test.each(['', '\n', ' box-1.invalid '])('refuses invalid remote destination %j before execution', async on => {
  const fixture = await createClientFixture();
  try {
    const client = createArgvClient({ binary: fixture.hcBinary, env: fixture.localEnv });
    await expect(client.exec(on, ['/fixture/node'], { timeoutMs: 1000, maxBytes: 16 }))
      .rejects.toMatchObject({ code: 'invalid-destination' });
    expect(await fixture.calls()).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 5000);

test('a one-MiB reply is accepted and a larger reply is refused', async () => {
  const fixture = await createClientFixture();
  try {
    const payload = Buffer.alloc(1024 * 1024, 0xa5);
    await fixture.configure({ rawReplyBase64: payload.toString('base64') });
    expect(await invokeBytes(fixture.hcBinary, ['fixture-bytes'], fixture.localEnv, { timeoutMs: 3000, maxBytes: payload.length })).toEqual(payload);
    await fixture.configure({ rawReplyBase64: Buffer.concat([payload, Buffer.from([1])]).toString('base64') });
    await expect(invokeBytes(fixture.hcBinary, ['fixture-bytes'], fixture.localEnv, { timeoutMs: 3000, maxBytes: payload.length }))
      .rejects.toMatchObject({ code: 'reply-too-large', details: { limit: 1024 * 1024 } });
  } finally {
    await fixture.close();
  }
}, 5000);

test('raw stdout above the configured limit is refused instead of truncated', async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ rawReplyBase64: 'AP8KgA==' });
    await expect(invokeBytes(fixture.hcBinary, ['fixture-bytes'], fixture.localEnv, { timeoutMs: 1000, maxBytes: 3 }))
      .rejects.toMatchObject({ code: 'reply-too-large', details: { limit: 3, source: 'reply' } });
  } finally {
    await fixture.close();
  }
}, 5000);

test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid byte limit %s before starting hc', async maxBytes => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ rawReplyBase64: 'AA==' });
    await expect(invokeBytes(fixture.hcBinary, ['fixture-bytes'], fixture.localEnv, { timeoutMs: 1000, maxBytes }))
      .rejects.toMatchObject({ code: 'invalid-byte-limit' });
    expect(await fixture.calls()).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 5000);
