import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import type { Owner, JobId, TerminalAddress, RemoteExecutionPort, RemoteExecuteRequest, RuntimeTarget, MachineName } from '../../../herdr/src/contracts.js';
import { runExec, runExecFile, runBatch } from '../actions/exec.js';
import { detectRuntimes, getAvailableLanguages, buildCommand, type Language } from '../runtime.js';
import { PolyglotExecutor } from '../executor.js';
import { prepareRemoteProgram } from '../remote-plan.js';
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const owner = { sessionId: 'session', generation: 'generation', terminal: { coreId: 'core', terminalId: 't1', address: 't1', socket: '/fixture.sock', sessionNamespace: 'fixture' }, cwd: '/', sessionFile: null, name: null } as Owner;
async function fixture() {
  const base = resolve('.spider/scratch/h'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'plan-')); roots.push(root);
  const local = join(root, 'local'), destination = join(root, 'destination');
  await mkdir(local); await mkdir(destination);
  await exec("git", ["init", "--quiet", local], { env: { ...process.env, TMPDIR: root } });
  const requests: RemoteExecuteRequest[] = [], uploads: string[] = [];
  const target: RuntimeTarget = { on: 'remote.invalid' as MachineName, cwd: destination, directory: destination, commands: { python: ['/usr/bin/python3'], javascript: [process.execPath], shell: ['/bin/sh'] }, environment: {}, nodePath: process.execPath, runtimePath: join(destination, 'runtime.mjs'), runtimeSha256: '0'.repeat(64) };
  const remote: RemoteExecutionPort = { execute: async request => {
    requests.push(request);
    if (request.on !== 'remote.invalid') throw Object.assign(new Error('Missing destination'), { code: 'machine-not-found' });
    const program = await prepareRemoteProgram(request.source, target);
    await mkdir(program.directory, { recursive: true });
    for (const file of program.files) { uploads.push(file.bytes.toString()); await writeFile(file.path, file.bytes); }
    const result = await exec(program.argv[0], [...program.argv.slice(1)], { cwd: program.cwd ?? destination, env: { ...process.env, TMPDIR: root } });
    return { ...result, exitCode: 0, outcome: 'exited', timedOut: false, remote: { jobId: 'job' as JobId, machine: request.on, address: 'remote.invalid/t1' as TerminalAddress } };
  } };
  return { root, local, destination, requests, uploads, target, ctx: { cwd: local, remote, owner } };
}
describe('remote preparation', () => {
  it('shows a quiet cleanup note after a successful copy', async () => {
    const h = await fixture();
    h.ctx.remote.copy = async request => ({ direction: request.direction, machine: request.on, source: request.local, destination: request.remote, bytes: 1, mode: 0o600, sha256: 'a'.repeat(64), note: 'Staging cleanup deferred.' });
    const result = await runExec({ on: 'remote.invalid', copy: { direction: 'to', local: join(h.local, 'source'), remote: join(h.destination, 'dest') } }, h.ctx);
    expect(result.isError).toBe(false);
    expect(result.text).toBe(`Copied to ${join(h.destination, 'dest')}\nStaging cleanup deferred.`);
  });
  it('reads exec_file only on its destination and never falls back locally', async () => {
    const h = await fixture();
    await writeFile(join(h.destination, 'input.txt'), 'destination-only value');
    const result = await runExecFile({ path: 'input.txt', language: 'python', code: 'print(FILE_CONTENT.upper())', on: 'remote.invalid' }, h.ctx);
    expect(result.text).toContain('DESTINATION-ONLY VALUE');
    expect(result.details.stdout).toBe('DESTINATION-ONLY VALUE\n');
    expect(result.details.remote.machine).toBe('remote.invalid');
    expect(h.requests[0].source).toEqual({ kind: 'file', path: 'input.txt', language: 'python', code: 'print(FILE_CONTENT.upper())' });
    expect(JSON.stringify(h.requests) + h.uploads.join('')).not.toContain('destination-only value');
    await expect(runExec({ language: 'shell', code: 'echo wrong', on: 'missing.invalid' }, h.ctx)).rejects.toMatchObject({ code: 'machine-not-found' });
    const launches: string[] = [];
    const ex = new PolyglotExecutor({ projectRoot: h.local, remote: h.ctx.remote, owner, spawn: ((...args: Parameters<typeof spawn>) => { launches.push(String(args[0])); return spawn(...args); }) as typeof spawn });
    await ex.execute({ on: 'remote.invalid', language: 'python', code: 'print("remote-only")' });
    expect(launches).toEqual([]);
    expect(await readFile(join(h.local, 'input.txt')).catch(() => null)).toBeNull();
  });
  it('local and remote exec_file analysis print the same derived value', async () => {
    const h = await fixture();
    for (const dir of [h.local, h.destination]) await writeFile(join(dir, 'input.txt'), 'same value');
    for (const [language, code] of [['python', 'print(FILE_CONTENT.upper()); print(file_path.split("/")[-1])'], ['javascript', 'console.log(FILE_CONTENT.toUpperCase()); console.log(file_path.split("/").pop())'], ['shell', 'printf "%s\\n" "$FILE_CONTENT" | tr "[:lower:]" "[:upper:]"; basename "$file_path"']] as const) {
      const local = await runExecFile({ path: 'input.txt', language, code }, h.ctx);
      const remote = await runExecFile({ path: 'input.txt', language, code, on: 'remote.invalid' }, h.ctx);
      expect(local.details.stdout).toBe('SAME VALUE\ninput.txt\n'); expect(remote.details.stdout).toBe('SAME VALUE\ninput.txt\n');
    }
  });
  it('preserves destination home and rejects a relative file without configured cwd', async () => {
    const h = await fixture(); const target = { ...h.target, cwd: null };
    expect((await prepareRemoteProgram({ kind: 'code', language: 'shell', code: 'pwd' }, target)).cwd).toBeNull();
    expect((await prepareRemoteProgram({ kind: 'file', language: 'python', path: '/absolute/input.txt', code: 'print(FILE_CONTENT)' }, target)).cwd).toBeNull();
    await expect(prepareRemoteProgram({ kind: 'file', language: 'python', path: 'input.txt', code: '' }, target)).rejects.toMatchObject({ code: 'remote-cwd-required' });
  });
  it('passes top-level on to every batch entry and rejects per-entry on before any launch', async () => {
    const h = await fixture(); await writeFile(join(h.destination, 'input.txt'), 'x');
    const result = await runBatch({ on: 'remote.invalid', commands: [{ language: 'python', code: 'print("one")' }, { language: 'python', code: 'print("two")' }] }, h.ctx);
    expect(result.details.map(r => r.remote.machine)).toEqual(['remote.invalid', 'remote.invalid']);
    const before = h.requests.length;
    await expect(runBatch({ on: 'remote.invalid', commands: [{ language: 'shell', code: 'echo wrong' }, { language: 'shell', code: 'echo wrong', on: 'other.invalid' }] }, h.ctx)).rejects.toMatchObject({ code: 'batch-entry-on' });
    expect(h.requests).toHaveLength(before);
  });
  it('children execute code, destination files and batches directly through their remote port', async () => {
    const h = await fixture(); vi.stubEnv('PI_SUBAGENT_CHILD', '1');
    await writeFile(join(h.destination, 'input.txt'), 'child value');
    expect((await runExec({ on: 'remote.invalid', language: 'shell', code: 'printf child' }, h.ctx)).details.stdout).toBe('child');
    expect((await runExecFile({ on: 'remote.invalid', path: 'input.txt', language: 'javascript', code: 'console.log(FILE_CONTENT)' }, h.ctx)).details.stdout).toBe('child value\n');
    expect((await runBatch({ on: 'remote.invalid', commands: [{ language: 'shell', code: 'printf one' }, { language: 'shell', code: 'printf two' }] }, h.ctx)).details.map(r => r.stdout)).toEqual(['one', 'two']);
    expect(h.requests).toHaveLength(4);
    expect(h.requests.map(request => request.kind)).toEqual(['exec', 'exec-file', 'batch', 'batch']);
  });
  it('a child without Herdr rejects on without a local fallback and can still execute locally', async () => {
    const h = await fixture(); vi.stubEnv('PI_SUBAGENT_CHILD', '1');
    await expect(runExec({ on: 'remote.invalid', language: 'shell', code: 'touch must-not-exist' }, { cwd: h.local })).rejects.toMatchObject({ code: 'herdr-unavailable' });
    expect(await readFile(join(h.local, 'must-not-exist')).catch(() => null)).toBeNull();
    expect((await runExec({ language: 'shell', code: 'printf local' }, { cwd: h.local })).details.stdout).toBe('local');
  });
  it('applies the final immutable environment to shell, other languages and durable capture', async () => {
    const h = await fixture(); const original = process.env.PATH;
    const environmentPolicy = (env: Readonly<NodeJS.ProcessEnv>) => { expect(Object.isFrozen(env)).toBe(true); return { ...env, PATH: `/policy/bin:${env.PATH}`, POLICY_MARK: 'applied' }; };
    for (const background of [false, true]) {
      const shell = await runExec({ language: 'shell', code: 'printf "%s\\n" "$PATH"', background }, { ...h.ctx, environmentPolicy });
      expect(shell.details.stdout).toMatch(/^\/policy\/bin:/);
      const js = await runExec({ language: 'javascript', code: 'console.log(process.env.POLICY_MARK)', background }, { ...h.ctx, environmentPolicy });
      expect(js.details.stdout).toBe('applied\n');
    }
    expect(process.env.PATH).toBe(original);
  });
  it('exposes remote preparation through the public context entrypoint', async () => {
    const publicApi = await import('../index.js');
    expect(Reflect.get(publicApi, 'prepareRemoteProgram')).toBeTypeOf('function');
  });
  it('uses configured destination Node even when node is unavailable on destination PATH', async () => {
    const h = await fixture(); const program = await prepareRemoteProgram({ kind: 'code', language: 'javascript', code: 'console.log("configured Node")' }, { ...h.target, commands: {} });
    await mkdir(program.directory); for (const file of program.files) await writeFile(file.path, file.bytes);
    const output = await exec(program.argv[0], [...program.argv.slice(1)], { env: { ...process.env, PATH: '/nonexistent-spider-fixture-path', TMPDIR: h.root } });
    expect(output.stdout).toBe('configured Node\n');
  });
  it('two concurrent preparations never share or overwrite a destination file', async () => {
    const h = await fixture();
    const [one, two] = await Promise.all([prepareRemoteProgram({ kind: 'code', language: 'javascript', code: 'console.log("one")' }, h.target), prepareRemoteProgram({ kind: 'code', language: 'javascript', code: 'console.log("two")' }, h.target)]);
    expect(one.directory).not.toBe(two.directory);
    for (const program of [one, two]) {
      expect(program.directory).toMatch(/\/[a-f0-9]{32}$/); expect(program.files[0].path).toBe(join(program.directory, '.spider-program'));
      expect(program.files[0].bytes.toString()).toMatch(/^[a-f0-9]{32}$/);
      await mkdir(program.directory); for (const file of program.files) await writeFile(file.path, file.bytes);
    }
    const a = await exec(one.argv[0], [...one.argv.slice(1)]), b = await exec(two.argv[0], [...two.argv.slice(1)]);
    expect(a.stdout).toBe('one\n'); expect(b.stdout).toBe('two\n');
    expect(new Set([...one.files, ...two.files].map(f => f.path)).size).toBe(one.files.length + two.files.length);
  });
  it('without on preserves local exec_file foreground timeout cancellation', async () => {
    const h = await fixture(); await writeFile(join(h.local, 'input.txt'), 'value');
    const result = await runExecFile({ path: 'input.txt', language: 'javascript', code: 'setInterval(()=>{},1000)', timeout: 80, background: true }, h.ctx);
    try {
      expect(result.details).toMatchObject({ outcome: 'signal', signal: 'SIGKILL', timedOut: true });
      expect(result.details.backgrounded).not.toBe(true); expect(result.isError).toBe(true);
    } finally { if (result.details.backgrounded && typeof result.details.pid === 'number') { try { process.kill(-result.details.pid, 'SIGKILL'); } catch {} } }
  });
  const runtimes = detectRuntimes(); const available = new Set(getAvailableLanguages(runtimes));
  if (runtimes.rust) { try { execFileSync(runtimes.rust, ['--version'], { stdio: 'ignore' }); } catch { available.delete('rust'); } }
  const bindings: readonly { language: Language; code: string }[] = [
    { language: 'javascript', code: 'console.log(FILE_CONTENT);console.log(file_path.split("/").pop())' },
    { language: 'typescript', code: 'console.log(FILE_CONTENT);console.log(file_path.split("/").pop())' },
    { language: 'python', code: 'print(FILE_CONTENT);print(file_path.split("/")[-1])' },
    { language: 'shell', code: 'printf "%s\\n" "$FILE_CONTENT";basename "$file_path"' },
    { language: 'ruby', code: 'puts FILE_CONTENT;puts File.basename(file_path)' },
    { language: 'go', code: 'fmt.Println(FILE_CONTENT);fmt.Println(file_path[len(file_path)-9:])' },
    { language: 'rust', code: `println!("{}",file_content);println!("{}",file_path.rsplit('/').next().unwrap());` },
    { language: 'php', code: 'echo $FILE_CONTENT,PHP_EOL;echo basename($file_path),PHP_EOL;' },
    { language: 'perl', code: 'use File::Basename;print $FILE_CONTENT,"\\n";print basename($file_path),"\\n";' },
    { language: 'r', code: 'cat(FILE_CONTENT,"\\n",sep="");cat(basename(file_path),"\\n",sep="")' },
    { language: 'elixir', code: 'IO.puts(file_content);IO.puts(Path.basename(file_path))' },
    { language: 'csharp', code: 'System.Console.WriteLine(FILE_CONTENT);System.Console.WriteLine(System.IO.Path.GetFileName(file_path));' },
  ];
  for (const { language, code } of bindings) {
    it.skipIf(!available.has(language))(`preserves ${language} content and file_path bindings through real local and destination analysis (requires installed runtime/toolchain)`, async () => {
      const h = await fixture();
      vi.stubEnv('GOCACHE', join(h.root, 'go-cache'));
      for (const directory of [h.local, h.destination]) await writeFile(join(directory, 'input.txt'), 'same value');
      const command = language === 'rust' ? [runtimes.rust!] : buildCommand(runtimes, language, '__source__').slice(0, -1);
      h.target.commands = { ...h.target.commands, [language]: command };
      const local = await runExecFile({ path: 'input.txt', language, code }, h.ctx);
      const remote = await runExecFile({ path: 'input.txt', language, code, on: 'remote.invalid' }, h.ctx);
      expect(local.details.stdout, local.details.stderr).toBe('same value\ninput.txt\n');
      expect(remote.details.stdout, remote.details.stderr).toBe('same value\ninput.txt\n');
    }, 30000);
  }
});
