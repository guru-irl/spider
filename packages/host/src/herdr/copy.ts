// SPDX-License-Identifier: MIT
import { constants as fileFlags } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import type { HcClient, HerdrConfig, RemoteCopyRequest, RemoteCopyResult, RemoteExecutionPort } from '@spider/herdr';
import { HerdrError } from '@spider/herdr/client/parse';
import { resolveMachine } from './machine.js';

// hc file read is text-only and bounded. Base64 chunks fit under its reply limit.
const CHUNK_BYTES = 384 * 1024;
const MAX_BYTES = 64 * 1024 * 1024;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const literal = (value: unknown) => JSON.stringify(value);
const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw new HerdrError('aborted', 'File copy was aborted'); };

type Metadata = { bytes: number; mode: number; sha256: string; parts: number };
function metadata(value: unknown): Metadata {
  const item = value as Partial<Metadata> | null;
  if (!item || !Number.isSafeInteger(item.bytes) || item.bytes! < 0 || item.bytes! > MAX_BYTES || !Number.isInteger(item.mode) || item.mode! < 0 || item.mode! > 0o7777 || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) || item.parts !== Math.ceil(item.bytes! / CHUNK_BYTES)) throw new HerdrError('copy-metadata-invalid', 'Remote file metadata is invalid');
  return item as Metadata;
}

async function localSource(path: string): Promise<{ bytes: Buffer; mode: number }> {
  const file = await open(path, fileFlags.O_RDONLY | (fileFlags.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_BYTES) throw new HerdrError('copy-source-invalid', 'The source must be a regular file no larger than 64 MiB');
    const bytes = Buffer.alloc(info.size); let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new HerdrError('copy-source-changed', 'The source changed while it was read');
      offset += read.bytesRead;
    }
    return { bytes, mode: info.mode & 0o7777 };
  } finally { await file.close(); }
}

/** One caller-visible copy. Intermediate chunks stay in a private remote runtime directory. */
export function withRemoteCopy(remote: RemoteExecutionPort, hc: HcClient, configured: () => HerdrConfig['machines']): RemoteExecutionPort {
  return { ...remote, async copy(request: RemoteCopyRequest): Promise<RemoteCopyResult> {
    cancelled(request.signal);
    const selected = await resolveMachine(hc, configured(), request.on);
    const stage = posix.join(selected.machine.runtime.directory, `.copy-${randomBytes(16).toString('hex')}`);
    let cleanupSafe = true;
    const run = async (code: string, signal?: AbortSignal): Promise<string> => {
      const result = await remote.execute({ on: selected.on, owner: request.owner, source: { kind: 'code', language: 'javascript', code }, signal });
      if (result.outcome === 'aborted' && result.remoteAbortInfo?.includes('state unknown')) cleanupSafe = false;
      if (result.outcome !== 'exited' || result.exitCode !== 0) throw new HerdrError('remote-copy-failed', `Remote copy step failed: ${(result.remoteAbortInfo || result.stderr || result.outcome).slice(0, 1000)}${cleanupSafe ? '' : ` Staging retained at ${stage}.`}`);
      return result.stdout.trim();
    };
    let staged = false, succeeded = false;
    try {
      await run(`require('node:fs').mkdirSync(${literal(stage)}, { mode: 0o700 });`, request.signal);
      staged = true;
      if (request.direction === 'to') {
        const source = await localSource(request.local), sha256 = digest(source.bytes), parts = Math.ceil(source.bytes.length / CHUNK_BYTES);
        for (let i = 0; i < parts; i++) {
          cancelled(request.signal);
          const bytes = source.bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
          await hc.fileWrite(selected.on, posix.join(stage, `chunk-${i}`), Buffer.from(bytes.toString('base64')));
        }
        cancelled(request.signal);
        const script = `const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');const stage=${literal(stage)},dest=${literal(request.remote)},parts=${parts},size=${source.bytes.length},mode=${source.mode},want=${literal(sha256)};let fd,created=false;try{fd=fs.openSync(dest,'wx',mode);created=true;const hash=crypto.createHash('sha256');let total=0;for(let i=0;i<parts;i++){const text=fs.readFileSync(path.join(stage,'chunk-'+i),'utf8'),b=Buffer.from(text,'base64');if(b.toString('base64')!==text)throw Error('Invalid copy chunk');fs.writeFileSync(fd,b);hash.update(b);total+=b.length}if(total!==size||hash.digest('hex')!==want)throw Error('Copy digest mismatch');fs.fchmodSync(fd,mode);fs.closeSync(fd);fd=undefined;console.log(JSON.stringify({bytes:size,mode,sha256:want,parts}));}catch(e){if(fd!==undefined)fs.closeSync(fd);if(created)fs.unlinkSync(dest);throw e}`;
        const copied = metadata(JSON.parse(await run(script, request.signal)));
        succeeded = true;
        return { direction: 'to', machine: selected.on, source: request.local, destination: request.remote, bytes: copied.bytes, mode: copied.mode, sha256: copied.sha256 };
      }
      const script = `const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');const stage=${literal(stage)},source=${literal(request.remote)};const stat=fs.statSync(source);if(!stat.isFile()||stat.size>${MAX_BYTES})throw Error('Source must be a regular file no larger than 64 MiB');const data=fs.readFileSync(source);if(data.length>${MAX_BYTES})throw Error('Source is too large');const parts=Math.ceil(data.length/${CHUNK_BYTES});for(let i=0;i<parts;i++)fs.writeFileSync(path.join(stage,'chunk-'+i),data.subarray(i*${CHUNK_BYTES},(i+1)*${CHUNK_BYTES}).toString('base64'),{mode:0o600});console.log(JSON.stringify({bytes:data.length,mode:stat.mode&0o7777,sha256:crypto.createHash('sha256').update(data).digest('hex'),parts}));`;
      const info = metadata(JSON.parse(await run(script, request.signal)));
      const file = await open(request.local, 'wx', 0o600); let complete = false;
      try {
        const hash = createHash('sha256'); let total = 0;
        for (let i = 0; i < info.parts; i++) {
          cancelled(request.signal);
          const text = (await hc.fileRead(selected.on, posix.join(stage, `chunk-${i}`))).toString();
          const bytes = Buffer.from(text, 'base64');
          if (bytes.toString('base64') !== text || bytes.length > CHUNK_BYTES || total + bytes.length > info.bytes) throw new HerdrError('copy-chunk-invalid', 'Remote copy chunk is invalid');
          await file.writeFile(bytes); hash.update(bytes); total += bytes.length;
        }
        if (total !== info.bytes || hash.digest('hex') !== info.sha256) throw new HerdrError('copy-digest-mismatch', 'File copy digest does not match');
        await file.chmod(info.mode); complete = true;
      } finally { await file.close(); if (!complete) await unlink(request.local).catch(() => {}); }
      succeeded = true;
      return { direction: 'from', machine: selected.on, source: request.remote, destination: request.local, bytes: info.bytes, mode: info.mode, sha256: info.sha256 };
    } finally {
      if (staged && cleanupSafe) {
        try { await run(`require('node:fs').rmSync(${literal(stage)}, { recursive: true, force: true });`); }
        catch (error) {
          // Cleanup is another remote launch, not part of the verified transfer.
          if (!succeeded) throw new HerdrError('copy-cleanup-failed', `File copy failed and staging cleanup failed at ${stage}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  } };
}
