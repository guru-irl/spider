import { catalog, resolveRoleDefaults, ROLE_POLICY, type ThinkingLevel, type Tier } from '@spider/models';
import { thinkingFromModel, stripThinkingSuffix } from '@spider/db-core';
import { HerdrError } from '../client/parse.js';
import { isAbsolute } from 'node:path';
import roleTemplate from '../../assets/templates/role.md?raw';
import roleInstructions from '../../assets/templates/role-instructions.md?raw';
export const TEMPLATE_ROLES = ['worker', 'reviewer', 'watcher'] as const;
export type TemplateRole = typeof TEMPLATE_ROLES[number];
export interface RegistryModel { provider: string; id: string; reasoning?: boolean; input?: readonly string[]; contextWindow?: number }
export interface ModelRegistryPort { getAll(): readonly RegistryModel[]; getAvailable(): readonly RegistryModel[]; find(provider: string, id: string): RegistryModel | undefined }
export type RolePolicy = Readonly<Record<TemplateRole, { model: string; thinking: ThinkingLevel }>>;
export interface RoleTemplateOptions { piExecutable: string; instructionPaths: Readonly<Record<TemplateRole, string>> }
export interface RoleTemplates { worker: string; reviewer: string; watcher: string; instructions: Readonly<Record<TemplateRole, string>> }
export interface RolePolicyLayers { global: Readonly<Record<string, string>>; local?: Readonly<Record<string, string>>; tierOverrides?: Record<string, Tier> }
export type GlobalRolePolicyLayers = Pick<RolePolicyLayers, 'global' | 'tierOverrides'>;
export type AvailableRoleTemplates = Partial<Record<TemplateRole, string>> & { instructions: Partial<Record<TemplateRole, string>> };
function ref(model: RegistryModel): string { return `${model.provider}/${model.id}`; }
function availableModel(registry: ModelRegistryPort, reference: string): RegistryModel | undefined {
  return registry.getAvailable().find(m => ref(m) === reference || m.id === reference);
}
/** Shared templates use only the parsed global layer, never the last activated project. */
export function resolveTemplateRolePolicy(layers: RolePolicyLayers, registry: ModelRegistryPort): RolePolicy;
export function resolveTemplateRolePolicy(layers: GlobalRolePolicyLayers, registry: ModelRegistryPort, warn: (message: string) => void): Partial<RolePolicy>;
export function resolveTemplateRolePolicy(layers: RolePolicyLayers, registry: ModelRegistryPort, warn?: (message: string) => void): Partial<RolePolicy> {
  const configured = { ...layers.global };
  const skipped = new Set<TemplateRole>();
  for (const role of TEMPLATE_ROLES) {
    if (configured[role] !== undefined && !availableModel(registry, stripThinkingSuffix(configured[role])!)) {
      const message = `Configured ${role} model is unavailable`;
      if (!warn) throw new HerdrError('role-unresolved', message);
      warn(message); skipped.add(role); delete configured[role];
    }
  }
  const available = new Set(registry.getAvailable().map(ref));
  const overrides = Object.fromEntries(Object.entries(layers.tierOverrides ?? {}).map(([id, tier]) => [id, { tier }]));
  const entries = catalog(() => registry.getAll().map(m => ({ provider: m.provider, id: m.id, available: available.has(ref(m)), reasoning: m.reasoning, vision: m.input?.includes('image'), ctx: m.contextWindow })), overrides);
  const defaults = resolveRoleDefaults(entries, configured);
  const roles: Partial<Record<TemplateRole, RolePolicy[TemplateRole]>> = {};
  for (const role of TEMPLATE_ROLES) {
    if (skipped.has(role)) continue;
    const selected = defaults[role];
    const model = selected ? availableModel(registry, stripThinkingSuffix(selected)!) : undefined;
    if (!model) {
      const message = `No available catalog model for ${role}`;
      if (!warn) throw new HerdrError('catalog-unavailable', message);
      warn(message); continue;
    }
    roles[role] = { model: ref(model), thinking: thinkingFromModel(selected) ?? ROLE_POLICY[role].thinking };
  }
  return roles;
}
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
export function generateRoleTemplates(policy: RolePolicy, registry: ModelRegistryPort, options: RoleTemplateOptions): RoleTemplates;
export function generateRoleTemplates(policy: Partial<RolePolicy>, registry: ModelRegistryPort, options: RoleTemplateOptions): AvailableRoleTemplates;
export function generateRoleTemplates(policy: Partial<RolePolicy>, registry: ModelRegistryPort, options: RoleTemplateOptions): AvailableRoleTemplates {
  for (const role of TEMPLATE_ROLES) {
    if (!isAbsolute(options.instructionPaths[role])) throw new HerdrError('invalid-template-options', 'Role instruction paths must be absolute');
  }
  const output: Partial<Record<TemplateRole, string>> = {};
  const instructions: Partial<Record<TemplateRole, string>> = {};
  for (const role of TEMPLATE_ROLES) {
    const resolved = policy[role];
    if (!resolved) continue;
    if (!availableModel(registry, resolved.model)) throw new HerdrError('role-unresolved', `Configured ${role} model is unavailable`);
    const argv = [options.piExecutable, '--model', resolved.model, '--thinking', resolved.thinking, '--append-system-prompt', options.instructionPaths[role]];
    if (argv.some(value => /[\r\n\0]/.test(value))) throw new HerdrError('invalid-template-options', 'Template command arguments must be single-line and contain no NUL');
    output[role] = roleTemplate.replaceAll('{{role}}', role).replaceAll('{{quoted-command}}', () => argv.map(quote).join(' '));
    instructions[role] = roleInstructions.replaceAll('{{role}}', role);
  }
  return { ...output, instructions };
}
