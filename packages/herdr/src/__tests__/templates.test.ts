import { acceptanceRoles } from './acceptance/h.js';
import { runAcceptance } from './scenarios.js';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { registerHerdrTemplates, regenerateGlobalHerdrTemplates, readGlobalHerdrTemplateFiles } from '../templates/register.js';
import { afterEach, expect, test, vi } from 'vitest';
import { modelDefaultLayers } from '../../../host/src/control.js';
import { paths } from '@spider/db-core';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateRoleTemplates, resolveTemplateRolePolicy, type RoleTemplateOptions, type ModelRegistryPort } from '../templates/generate.js';

const models = ['local-worker', 'global-reviewer', 'light-watcher'].map(id => ({ provider: 'test-provider', id, reasoning: true, input: ['text'] }));
const registry: ModelRegistryPort = { getAll: () => models, getAvailable: () => models, find: (p, id) => models.find(m => m.provider === p && m.id === id) };
const tierOverrides = { 'test-provider/light-watcher': 'light', 'test-provider/global-reviewer': 'heavy' } as const;
const roots: string[] = [];
const originalGlobalRoot = paths.globalRoot;
afterEach(async () => { paths.globalRoot = originalGlobalRoot; vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const scratch = resolve('.spider/scratch'); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'roles-')); roots.push(root);
  const options: RoleTemplateOptions = { piExecutable: 'pi', instructionPaths: { worker: join(root, 'worker.md'), reviewer: join(root, 'reviewer.md'), watcher: join(root, 'watcher.md') } };
  return { root, options };
}
// hc keeps command frontmatter verbatim; let the shell decode its argv independently.
function command(template: string): string[] {
  const line = template.split('\n').find(l => l.startsWith('command: '));
  if (!line) return [];
  const cmd = line.slice(9);
  return JSON.parse(execFileSync('/bin/sh', ['-c', `set -- ${cmd}; ${JSON.stringify(process.execPath)} -e 'console.log(JSON.stringify(process.argv.slice(1)))' "$@"`], { encoding: 'utf8' }));
}
function body(template: string) { return template.split(/^---\s*$/m).slice(2).join('---').trim(); }
function policy(global: Record<string, string> = {}, local: Record<string, string> = {}, r = registry) {
  return resolveTemplateRolePolicy({ global, local, tierOverrides }, r);
}

test('shared role launches use global defaults and ignore project-local pins', async () => {
  const { options } = await fixture();
  const roles = policy({ worker: 'test-provider/global-reviewer', reviewer: 'test-provider/global-reviewer' }, { worker: 'test-provider/local-worker' });
  const templates = generateRoleTemplates(roles, registry, options);
  expect(command(templates.worker).slice(0, 5)).toEqual(['pi', '--model', 'test-provider/global-reviewer', '--thinking', 'high']);
  expect(command(templates.worker).slice(5)).toEqual(['--append-system-prompt', options.instructionPaths.worker]);
  expect(body(templates.worker)).toBe('');
  expect(command(templates.reviewer).slice(0, 5)).toEqual(['pi', '--model', 'test-provider/global-reviewer', '--thinking', 'high']);
  const realShape = { models: { defaults: { worker: 'test-provider/local-worker', reviewer: 'test-provider/global-reviewer' } } };
  const defaults = generateRoleTemplates(policy(realShape.models.defaults, { worker: 'test-provider/missing' }), registry, options);
  expect([defaults.worker, defaults.reviewer, defaults.watcher].map(t => [command(t)[2], command(t)[4]])).toEqual([
    ['test-provider/local-worker', 'high'], ['test-provider/global-reviewer', 'high'], ['test-provider/light-watcher', 'low'],
  ]);
  await expect(Promise.resolve().then(() => policy({ worker: 'test-provider/missing' }))).rejects.toMatchObject({ code: 'role-unresolved' });
});


test('suffixes and unqualified pins install into a selected agent directory only on activation and retry unchanged', async () => {
  const { root, options } = await fixture();
  options.piExecutable = join(root, "agent's bin", 'pi');
  const layers = { global: { reviewer: 'global-reviewer:medium', worker: 'local-worker:xhigh' }, tierOverrides };
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const pi = { on: (event: string, handler: (e: unknown, c: ExtensionContext) => unknown) => { handlers.set(event, handler); return () => handlers.delete(event); } } as unknown as ExtensionAPI;
  const writes: string[] = [];
  const templateDirectory = join(root, 'nondefault-agent', 'templates');
  const registration = registerHerdrTemplates(pi, { globalModelDefaultLayers: () => layers, reportWarning: () => {}, modelRegistry: registry, templateDirectory, roleTemplateOptions: options,
    writeVerifiedFile: async (path, content) => { writes.push(path); await mkdir(resolve(path, '..'), { recursive: true }); await writeFile(path, content); },
  });
  expect(writes).toEqual([]);
  const ctx = {} as ExtensionContext;
  await handlers.get('session_start')?.({}, ctx);
  expect(writes).toHaveLength(6);
  const worker = await readFile(join(templateDirectory, 'spider-worker.md'), 'utf8');
  expect(command(worker)).toEqual([options.piExecutable, '--model', 'test-provider/local-worker', '--thinking', 'xhigh', '--append-system-prompt', options.instructionPaths.worker]);
  const reviewer = await readFile(join(templateDirectory, 'spider-reviewer.md'), 'utf8');
  expect(command(reviewer)[4]).toBe('medium');
  for (const role of ['worker', 'reviewer', 'watcher'] as const) {
    expect(body(await readFile(join(templateDirectory, `spider-${role}.md`), 'utf8'))).toBe('');
    expect(await readFile(options.instructionPaths[role], 'utf8')).toContain('Do not start nested subagents');
  }
  await handlers.get('session_start')?.({}, ctx);
  expect(writes).toHaveLength(6);
  await rm(options.instructionPaths.worker);
  await handlers.get('session_start')?.({}, ctx);
  expect(await readFile(options.instructionPaths.worker, 'utf8')).toContain('Do not start nested subagents');
  expect(writes).toHaveLength(7);
  await registration.dispose();
  expect(handlers.size).toBe(0);
});


test('setup and activation render byte-identical templates from the normal parsed global policy', async () => {
  const { root, options } = await fixture(); const global = join(root, 'global'); const project = join(root, 'project');
  await mkdir(global); await mkdir(project);
  paths.globalRoot = global; vi.spyOn(paths, 'projectRoot').mockReturnValue(project);
  await writeFile(join(global, 'config.json'), JSON.stringify({ 'models.defaults': { worker: 'global-reviewer:medium', reviewer: 42, watcher: 'light-watcher' } }));
  await writeFile(join(project, 'config.json'), JSON.stringify({ 'models.defaults': { worker: 'local-worker:xhigh' } }));
  const ports = { globalModelDefaultLayers: () => ({ global: modelDefaultLayers(project).global, tierOverrides }), modelRegistry: registry,
    templateDirectory: root, roleTemplateOptions: options, reportWarning: () => {}, writeVerifiedFile: writeFile };
  const setupFiles = await readGlobalHerdrTemplateFiles(ports);
  await writeFile(join(project, 'config.json'), JSON.stringify({ 'models.defaults': { worker: 'missing' } }));
  await regenerateGlobalHerdrTemplates(ports);
  for (const file of setupFiles) expect(await readFile(file.path, 'utf8')).toBe(file.content);
  expect(command(await readFile(join(root, 'spider-worker.md'), 'utf8')).slice(2, 5)).toEqual(['test-provider/global-reviewer', '--thinking', 'medium']);
  expect(setupFiles).toHaveLength(6);
});
test('hostile executable paths retain their exact argv and cannot create shell side effects', async () => {
  const { root, options } = await fixture();
  const marker = join(root, 'injected');
  options.piExecutable = join(root, "pi fixture's $(touch " + marker + ') `touch ' + marker + '` # \\ "q" ;x');
  const generated = generateRoleTemplates(policy(), registry, options);
  expect(command(generated.worker)[0]).toBe(options.piExecutable);
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
});
test('global activation skips only an unavailable role and preserves other templates on unchanged retries', async () => {
  const { root, options } = await fixture(); const warnings: string[] = []; const writes: string[] = [];
  const ports = { globalModelDefaultLayers: () => ({ global: { worker: 'missing', reviewer: 'global-reviewer', watcher: 'light-watcher' }, tierOverrides }),
    modelRegistry: registry, templateDirectory: root, roleTemplateOptions: options, reportWarning: (message: string) => warnings.push(message),
    writeVerifiedFile: async (path: string, content: string) => { writes.push(path); await writeFile(path, content); } };
  await regenerateGlobalHerdrTemplates(ports); await regenerateGlobalHerdrTemplates(ports);
  expect(writes).toHaveLength(4); expect(warnings).toHaveLength(1);
  expect(command(await readFile(join(root, 'spider-reviewer.md'), 'utf8'))[2]).toBe('test-provider/global-reviewer');
  await expect(readFile(join(root, 'spider-worker.md'))).rejects.toMatchObject({ code: 'ENOENT' });
});
test('refuses relative instruction paths before generating any launch', async () => {
  const { options } = await fixture();
  options.instructionPaths = { ...options.instructionPaths, watcher: 'relative.md' };
  expect(() => generateRoleTemplates(policy(), registry, options)).toThrowError(/absolute/);
});

test('an empty eligible catalog is catalog-unavailable while a revoked pin is role-unresolved before writes', async () => {
  const unavailable: ModelRegistryPort = { ...registry, getAvailable: () => [] };
  expect(() => policy({}, {}, unavailable)).toThrowError(expect.objectContaining({ code: 'catalog-unavailable' }));
  expect(() => policy({ worker: 'local-worker' }, {}, unavailable)).toThrowError(expect.objectContaining({ code: 'role-unresolved' }));
  const { root, options } = await fixture();
  let start: ((e: unknown, c: ExtensionContext) => unknown) | undefined;
  const pi = { on: (_e: string, handler: typeof start) => { start = handler; return () => {}; } } as unknown as ExtensionAPI;
  const writes: string[] = [];
  const warnings: string[] = [];
  registerHerdrTemplates(pi, { globalModelDefaultLayers: () => ({ global: { worker: 'local-worker' }, tierOverrides }), reportWarning: message => warnings.push(message), modelRegistry: unavailable, templateDirectory: root, roleTemplateOptions: options,
    writeVerifiedFile: async path => { writes.push(path); },
  });
  await expect(start!({}, {} as ExtensionContext)).resolves.toBeUndefined();
  await expect(start!({}, {} as ExtensionContext)).resolves.toBeUndefined();
  expect(writes).toEqual([]);
  expect(warnings.filter(message => message.includes('worker'))).toHaveLength(1);
  expect(warnings).toHaveLength(3);
});


test('shared role acceptance launches without a native task message', async () => {
  await runAcceptance('role launch', async h => {
    await acceptanceRoles(h);
    expect(JSON.parse(await readFile(join(h.root, `role-proof-${h.mode}.json`), 'utf8'))).toMatchObject({ mode: h.mode, providerRequests: 0 });
  });
});


test('line breaks cannot turn an executable path into extra template frontmatter', async () => {
  const { options } = await fixture();
  options.piExecutable = 'pi\ncommand: bad';
  expect(() => generateRoleTemplates(policy(), registry, options)).toThrowError(/single-line/);
});
