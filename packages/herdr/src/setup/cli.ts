// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { isAbsolute } from 'node:path';
import { setupHerdr, rollbackHerdr, assertPlainShell, type SetupParts, type SetupRequest } from './installer.js';
import { readJournal } from './backup.js';
import { doctorHerdr, type DoctorParts, type DoctorFailure } from './doctor.js';
import type { IpcDescriptor, SessionIpcRequest, SessionIpcReply } from '../contracts.js';
import { parsePanelIpcArgv } from '../../assets/shared/feed.js';
import { HerdrError } from '../client/parse.js';
import { ipcFailureReply } from '../feed/ipc-client.js';
import { runAdminCli, ADMIN_USAGE } from '../ssh/admin-cli.js';
export interface MemoryReviewTarget { scope: 'global' | 'repo'; repoKey: string | null; uuid: string }
export type MemoryReviewReply = { ok: true; [key: string]: unknown } | { ok: false; code: string; message: string };
export interface HerdrCliPorts {
  request(configPath?: string): Promise<SetupRequest>;
  assertAgentDirectory?(request: SetupRequest): Promise<void>;
  setupParts(request: SetupRequest): Promise<SetupParts>;
  doctorParts(request: SetupRequest): Promise<DoctorParts>;
  ipc?(descriptor: IpcDescriptor, request: SessionIpcRequest): Promise<SessionIpcReply>;
  /** Memory review with no pi session: the panel's Memories view. */
  memoryReview?: {
    list(repoKeys: readonly string[]): MemoryReviewReply;
    decide(op: 'approve' | 'reject', target: MemoryReviewTarget): MemoryReviewReply;
  };
  resumeOffer?(request: SetupRequest): Promise<string>;
  resume?(request: SetupRequest, selection: { file: string; sessionId: string; cwd: string; cutover?: boolean }): Promise<void>;
  sshShim?(argv: readonly string[]): Promise<number>;
  remoteObserver?(argv: readonly string[]): Promise<number>;
  stdout(text: string): void;
  stderr(text: string): void;
}
const USAGE = 'usage: node <installed-package>/dist/herdr/cli.mjs <command>\nCommands:\n  setup [--config <absolute-user-file>] [--overwrite-unowned-keys] [--allow-staging-app] [--adopt-existing-space <name>]\n  doctor [--config <absolute-user-file>]\n  rollback [--config <absolute-user-file>]\n  resume-offer --config <absolute-user-file>\n  resume --config <absolute-user-file> --file <absolute-session-file> --session-id <id> --cwd <absolute-directory>\n  ipc --descriptor <json> --request <json>\n  memory pending [--repo <absolute-repo-key>]...\n  memory approve|reject --scope global|repo [--repo <absolute-repo-key>] --uuid <uuid>\n  --ssh-shim <ssh-arguments>\n  --remote-observer --observe <address> --hc <absolute-binary> --nonce <nonce> --exit-file <absolute-file>\n  --help, -h' + `\n  ${ADMIN_USAGE}\n    Approve {path, sha256} in admin.wrappers. Reason: nonblank, at most 2048 characters, no controls.\n    Wrapper argv: destination first, then argv after --. Stdio and exit code pass through.\n    Audit: <globalRoot>/herdr/admin/audit.jsonl before launch. Children may use PI_SPIDER_SESSION_ID.\nSetup/doctor/rollback exit codes: 0 success; 1 failure; 2 usage error; 3 incomplete rollback.`;
function verificationFailures(details: unknown): readonly DoctorFailure[] {
  if (!details || typeof details !== 'object' || !('failures' in details) || !Array.isArray(details.failures)) return [];
  return details.failures.filter((issue): issue is DoctorFailure => issue !== null && typeof issue === 'object'
    && ['item', 'code', 'message', 'repair'].every(key => typeof issue[key] === 'string'));
}
const MEMORY_USAGE = 'usage: memory pending [--repo <absolute-repo-key>]... | memory approve|reject --scope global|repo [--repo <absolute-repo-key>] --uuid <uuid>';
/** Parse `memory ...`; every reply, including a usage error, is one JSON line. */
function parseMemoryCommand(argv: readonly string[]): { op: 'pending'; repoKeys: string[] } | { op: 'approve' | 'reject'; target: MemoryReviewTarget } {
  const usage = () => new HerdrError('cli-usage', MEMORY_USAGE);
  const op = argv[1];
  const repoKeys: string[] = []; let scope: string | undefined, uuid: string | undefined;
  for (let i = 2; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (!value || value.startsWith('--')) throw usage();
    if (flag === '--repo' && isAbsolute(value)) repoKeys.push(value);
    else if (flag === '--scope' && scope === undefined && op !== 'pending') scope = value;
    else if (flag === '--uuid' && uuid === undefined && op !== 'pending') uuid = value;
    else throw usage();
  }
  if (op === 'pending') return { op, repoKeys };
  if (op !== 'approve' && op !== 'reject' || !uuid) throw usage();
  if (scope === 'global' && repoKeys.length === 0) return { op, target: { scope, repoKey: null, uuid } };
  if (scope === 'repo' && repoKeys.length === 1) return { op, target: { scope, repoKey: repoKeys[0]!, uuid } };
  throw usage();
}
export async function runHerdrCli(argv: readonly string[], ports?: HerdrCliPorts): Promise<number> {
  const stdout = ports?.stdout ?? (text => process.stdout.write(text));
  const stderr = ports?.stderr ?? (text => process.stderr.write(text));
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) { stdout(USAGE + '\n'); return 0; }
  try {
    if (argv[0] === 'admin') return await runAdminCli(argv.slice(1), process.env, async () => {
      if (!ports) throw new HerdrError('setup-composition-unavailable', 'Administration requires the host-resolved user policy');
      return (await ports.request()).config;
    });
    if (argv[0] === '--ssh-shim') {
      if (!ports?.sshShim) throw new HerdrError('setup-composition-unavailable', 'SSH shim composition is required');
      return await ports.sshShim(argv.slice(1));
    }
    if (argv[0] === '--remote-observer') {
      if (!ports?.remoteObserver) throw new HerdrError('setup-composition-unavailable', 'Observer composition is required');
      return await ports.remoteObserver(argv.slice(1));
    }
    if (argv[0] === 'memory') {
      const command = parseMemoryCommand(argv);
      if (!ports?.memoryReview) throw new HerdrError('setup-composition-unavailable', 'Memory review composition is required');
      const reply = command.op === 'pending' ? ports.memoryReview.list(command.repoKeys) : ports.memoryReview.decide(command.op, command.target);
      stdout(JSON.stringify(reply) + '\n');
      return reply.ok ? 0 : 1;
    }
    if (argv[2] === 'ipc') {
      const parsed = parsePanelIpcArgv(argv);
      if (!parsed)
        throw new HerdrError('cli-usage', 'usage: <node> <cli> ipc --descriptor <json> --request <json>');
      if (!ports?.ipc)
        throw new HerdrError('setup-composition-unavailable', 'The authenticated IPC client port is not assembled');
      const reply = await ports.ipc(parsed.descriptor, parsed.request);
      stdout(JSON.stringify(reply) + '\n');
      return reply.ok ? 0 : 1;
    }
    const command = argv[0];
    let configPath: string | undefined;
    let overwrite = false;
    let allowStaging = false;
    let cutover = false;
    const adoptExistingSpaces: string[] = [];
    let sessionFile: string | undefined, sessionId: string | undefined, cwd: string | undefined;
    if (!['setup', 'doctor', 'rollback', 'resume-offer', 'resume'].includes(command))
      throw new HerdrError('cli-usage', USAGE);
    const seen = new Set<string>();
    for (let i = 1; i < argv.length; i++) {
      const flag = argv[i];
      if (flag === '--adopt-existing-space' && command === 'setup') {
        const name = argv[++i];
        if (!name || name.startsWith('--') || adoptExistingSpaces.includes(name))
          throw new HerdrError('cli-usage', USAGE);
        adoptExistingSpaces.push(name);
        continue;
      }
      if (seen.has(flag))
        throw new HerdrError('cli-usage', USAGE);
      seen.add(flag);
      if (flag === '--config') {
        configPath = argv[++i];
        if (!configPath || !isAbsolute(configPath))
          throw new HerdrError('cli-usage', USAGE);
      }
      else if (command === 'resume' && ['--file', '--session-id', '--cwd'].includes(flag)) {
        const value = argv[++i];
        if (!value || (flag !== '--session-id' && !isAbsolute(value))) throw new HerdrError('cli-usage', USAGE);
        if (flag === '--file') sessionFile = value;
        else if (flag === '--session-id') sessionId = value;
        else cwd = value;
      }
      else if (command === 'resume' && flag === '--cutover')
        cutover = true;
      else if (command === 'setup' && flag === '--overwrite-unowned-keys')
        overwrite = true;
      else if (command === 'setup' && flag === '--allow-staging-app')
        allowStaging = true;
      else
        throw new HerdrError('cli-usage', USAGE);
    }
    if (command !== 'doctor')
      assertPlainShell();
    if (command === 'resume' && (!sessionFile || !sessionId || !cwd)) throw new HerdrError('cli-usage', USAGE);
    // Require explicit runtime composition rather than implicit live configuration defaults.
    if (!ports)
      throw new HerdrError('setup-composition-unavailable', 'Installer composition is required; refusing implicit live configuration defaults');
    const request = { ...await ports.request(configPath), overwriteUnownedKeys: overwrite, allowStagingApp: allowStaging, adoptExistingSpaces };
    if (command === 'setup' || command === 'rollback') await ports.assertAgentDirectory?.(request);
    if (command === 'resume-offer') {
      if (!ports.resumeOffer) throw new HerdrError('setup-composition-unavailable', 'Resume offer composition is required');
      stdout(await ports.resumeOffer(request)); return 0;
    }
    if (command === 'resume') {
      if (!ports.resume) throw new HerdrError('setup-composition-unavailable', 'Leased resume composition is required');
      await ports.resume(request, { file: sessionFile!, sessionId: sessionId!, cwd: cwd!, ...(cutover ? { cutover: true } : {}) }); return 0;
    }
    if (command === 'doctor') {
      const report = await doctorHerdr(request, await ports.doctorParts(request));
      for (const note of report.information ?? []) stdout(`${note.code}: ${note.message}\n`);
      for (const issue of [...report.failures, ...report.warnings])
        stdout(`${issue.code}: ${issue.message}\nRepair: ${issue.repair}\n`);
      if (report.warnings.length) {
        const unavailable = new Set(report.warnings.filter(issue => issue.code.includes('unavailable')).map(issue => issue.item)).size;
        stdout(`${report.passed ?? 0} passed, ${unavailable} unavailable, ${report.failures.length} failed\n`);
      } else if (!report.failures.length) stdout('Doctor checks passed\n');
      return report.failures.length ? 1 : 0;
    }
    const parts = await ports.setupParts(request);
    if (command === 'rollback') {
      const restored = await rollbackHerdr(request, parts);
      stdout(`Rollback restored ${restored.length} matching files\n`);
      // Only owned parts that could not be restored remain in the journal.
      return (await readJournal(request.journalRoot)).entries.length ? 3 : 0;
    }
    const result = await setupHerdr(request, parts);
    stdout(`Setup verified: ${result.writes.length} file writes, ${result.probes.length} visible probes\n`);
    return 0;
  }
  catch (e) {
    if (argv[2] === 'ipc') { stdout(JSON.stringify(ipcFailureReply(e)) + '\n'); return e instanceof HerdrError && e.code === 'cli-usage' ? 2 : 1; }
    if (argv[0] === 'memory') {
      const code = e instanceof HerdrError ? e.code : 'unavailable';
      stdout(JSON.stringify({ ok: false, code, message: e instanceof Error ? e.message : String(e) }) + '\n');
      return code === 'cli-usage' || code === 'setup-composition-unavailable' ? 2 : 1;
    }
    const error = e instanceof HerdrError ? e : new HerdrError('setup-failed', e instanceof Error ? e.message : String(e));
    stderr(`${error.code}: ${error.message}\n`);
    for (const issue of verificationFailures(error.details))
      stderr(`[${issue.item}] ${issue.code}: ${issue.message}\nRepair: ${issue.repair}\n`);
    return error.code === 'cli-usage' || error.code === 'setup-composition-unavailable' ? 2 : 1;
  }
}
