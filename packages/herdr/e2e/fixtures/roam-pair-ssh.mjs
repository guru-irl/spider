// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// This is an owned process-start boundary, not an SSH implementation or security claim.
import { connect } from 'node:net';
import { isAbsolute, relative, resolve } from 'node:path';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { acceptsConnectCommand } from './roam-pair-command.mjs';

const descriptor = process.argv[2], d = JSON.parse(readFileSync(descriptor, 'utf8'));
const inside = path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path && relative(d.root, path) && !relative(d.root, path).startsWith('..');
if (!isAbsolute(d.root) || resolve(d.root) !== d.root || realpathSync(d.root) !== d.root || !inside(descriptor) || !inside(d.viaDescriptor)) throw new Error('unsafe fixture ssh descriptor');
const session = JSON.parse(readFileSync(d.viaDescriptor, 'utf8')).env?.HC_SESSION;
const ownedFile = path => { try { const stat = lstatSync(path); return inside(path) && !stat.isSymbolicLink() && stat.isFile() && realpathSync(path) === path && (!process.getuid || stat.uid === process.getuid()); } catch { return false; } };
const args = process.argv.slice(3), portAt = args.indexOf('-p'), keyAt = args.indexOf('-i');
const port = Number(args[portAt + 1]), command = args.at(-1), destination = args.at(-2);
const known = args.find(arg => arg.startsWith('UserKnownHostsFile='))?.slice('UserKnownHostsFile='.length);
if (portAt < 0 || keyAt < 0 || !Number.isSafeInteger(port) || port !== d.localPort || !destination?.endsWith('@127.0.0.1') ||
    !acceptsConnectCommand(command, session) || !args.includes('StrictHostKeyChecking=yes') || !args.includes('IdentitiesOnly=yes') ||
    !ownedFile(known) || !ownedFile(args[keyAt + 1])) throw new Error('unsafe fixture ssh invocation');
const socket = connect(port, '127.0.0.1');
socket.once('connect', () => { socket.write(`${JSON.stringify({ line: command })}\n`); process.stdin.pipe(socket); socket.pipe(process.stdout); });
socket.on('error', () => { process.exitCode = 1; });
socket.on('end', () => { process.exitCode = 0; });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => socket.destroy());
