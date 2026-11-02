import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Disposable } from '../contracts.js';
import { generateRoleTemplates, resolveTemplateRolePolicy, TEMPLATE_ROLES, type ModelRegistryPort, type GlobalRolePolicyLayers, type RoleTemplateOptions } from './generate.js';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
export interface TemplatePorts {
  /** Supply modelDefaultLayers(cwd).global from the host's normal config parser. */
  globalModelDefaultLayers(): GlobalRolePolicyLayers | Promise<GlobalRolePolicyLayers>;
  modelRegistry: ModelRegistryPort;
  templateDirectory: string;
  roleTemplateOptions: RoleTemplateOptions;
  writeVerifiedFile(path: string, content: string): Promise<void>;
  reportWarning(message: string): void;
}
export type TemplateReadPorts = Omit<TemplatePorts, 'writeVerifiedFile'>;
export interface GlobalTemplateFile { path: string; content: string }
const warningSets = new WeakMap<TemplateReadPorts, Set<string>>();
/** Setup and activation consume the same normal-parser global policy and rendering path. */
export async function readGlobalHerdrTemplateFiles(ports: TemplateReadPorts, options: { strict?: boolean } = {}): Promise<GlobalTemplateFile[]> {
  let warnings = warningSets.get(ports);
  if (!warnings) { warnings = new Set(); warningSets.set(ports, warnings); }
  const currentWarnings = new Set<string>();
  const layers = await ports.globalModelDefaultLayers();
  const policy = options.strict ? resolveTemplateRolePolicy(layers, ports.modelRegistry) : resolveTemplateRolePolicy(layers, ports.modelRegistry, message => {
    currentWarnings.add(message);
    if (!warnings.has(message)) { warnings.add(message); ports.reportWarning(message); }
  });
  const templates = generateRoleTemplates(policy, ports.modelRegistry, ports.roleTemplateOptions);
  const files: GlobalTemplateFile[] = TEMPLATE_ROLES.flatMap(role => {
    const template = templates[role]; const instructions = templates.instructions[role];
    return template && instructions ? [
      { path: ports.roleTemplateOptions.instructionPaths[role], content: instructions },
      { path: join(ports.templateDirectory, `spider-${role}.md`), content: template },
    ] : [];
  });
  if (!options.strict) for (const message of warnings) if (!currentWarnings.has(message)) warnings.delete(message);
  return files;
}
/** One user shares one template directory; project-local model pins never affect it. */
export async function regenerateGlobalHerdrTemplates(ports: TemplatePorts, isDisposed: () => boolean = () => false): Promise<void> {
  const files = await readGlobalHerdrTemplateFiles(ports);
  for (const { path, content } of files) {
    if (isDisposed()) return;
    const existing = await readFile(path, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (existing !== content && !isDisposed()) await ports.writeVerifiedFile(path, content);
  }
}
export function registerHerdrTemplates(pi: ExtensionAPI, ports: TemplatePorts): Disposable {
  let disposed = false;
  const off = pi.on('session_start', () => disposed ? undefined : regenerateGlobalHerdrTemplates(ports, () => disposed));
  return { dispose() { if (disposed) return; disposed = true; off(); } };
}
