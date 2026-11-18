import { join } from "node:path";
import type { IntercomEnrollmentPair } from "../provision-contracts";

/** The previously installed, immutable pair command used as an upgrade input. */
export function legacyPairCommand(pair: IntercomEnrollmentPair): string {
  const registry = join(pair.target.globalRoot, "roam", "intercom", "enrollments", `${pair.pairId}.json`);
  return `import { constants, openSync, fstatSync, readFileSync, closeSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
const fail = () => { process.exitCode = 126; };
try {
  const prefix = ${JSON.stringify(`spider-intercom:${pair.pairId}:${pair.edgeEpoch}:`)}, original = process.env.SSH_ORIGINAL_COMMAND ?? '';
  if (!original.startsWith(prefix) || original.length > 1500000) throw new Error();
  const encoded = original.slice(prefix.length), command = Buffer.from(encoded, 'base64');
  if (!command.length || command.length > 1048576 || command.toString('base64') !== encoded || command.includes(0)) throw new Error();
  const file = ${JSON.stringify(registry)};
  if (realpathSync(file) !== file) throw new Error();
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let record;
  try { const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1048576 || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600) throw new Error();
    record = JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
  if (!['pending','active'].includes(record.state) || record.fenceId !== null || record.pair?.pairId !== ${JSON.stringify(pair.pairId)} || record.pair?.edgeEpoch !== ${JSON.stringify(pair.edgeEpoch)} ||
      record.pair?.source?.machineId !== ${JSON.stringify(pair.source.machineId)} || record.pair?.target?.machineId !== ${JSON.stringify(pair.target.machineId)}) throw new Error();
  const child = spawn('/bin/sh', ['-c', command.toString('utf8')], { stdio: 'inherit' });
  for (const signal of ['SIGINT','SIGTERM','SIGHUP']) process.on(signal, () => child.kill(signal));
  child.on('error', fail); child.on('exit', code => { process.exitCode = code ?? 1; });
} catch { fail(); }
`;
}
