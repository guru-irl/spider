import { join } from 'node:path';

/** Kept free of template asset imports so setup code can share it without bundling the templates. */
export const TEMPLATE_ROLES = ['worker', 'reviewer', 'watcher'] as const;
export type TemplateRole = typeof TEMPLATE_ROLES[number];

/** All files activation may rewrite, including roles currently disabled by policy. */
export function globalHerdrTemplatePaths(ports: { templateDirectory: string; roleTemplateOptions: { instructionPaths: Readonly<Record<TemplateRole, string>> } }): string[] {
  return TEMPLATE_ROLES.flatMap(role => [ports.roleTemplateOptions.instructionPaths[role], join(ports.templateDirectory, `spider-${role}.md`)]);
}
