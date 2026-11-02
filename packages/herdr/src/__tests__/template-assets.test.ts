import { expect, test, vi } from 'vitest';
import { generateRoleTemplates, type ModelRegistryPort, type RolePolicy } from '../templates/generate.js';
vi.mock('../../assets/templates/role.md?raw', () => ({ default: '---\nname: fixture-{{role}}\ncommand: {{quoted-command}}\n---\nasset body\n' }));
vi.mock('../../assets/templates/role-instructions.md?raw', () => ({ default: 'Asset instructions for {{role}}.\n' }));
const model = { provider: 'fixture', id: 'model' };
const registry: ModelRegistryPort = { getAll: () => [model], getAvailable: () => [model], find: () => model };
const policy: RolePolicy = { worker: { model: 'fixture/model', thinking: 'high' }, reviewer: { model: 'fixture/model', thinking: 'high' }, watcher: { model: 'fixture/model', thinking: 'low' } };
test('renders command and role substitutions from the shipped template asset', () => {
  const result = generateRoleTemplates(policy, registry, { piExecutable: 'pi', instructionPaths: { worker: '/fixture/worker.md', reviewer: '/fixture/reviewer.md', watcher: '/fixture/watcher.md' } });
  expect(result.worker).toBe("---\nname: fixture-worker\ncommand: 'pi' '--model' 'fixture/model' '--thinking' 'high' '--append-system-prompt' '/fixture/worker.md'\n---\nasset body\n");
  expect(result.watcher).toContain("name: fixture-watcher\ncommand: 'pi' '--model' 'fixture/model' '--thinking' 'low'");
});
test('renders each role instruction from the shipped instruction asset', () => {
  const result = generateRoleTemplates(policy, registry, { piExecutable: 'pi', instructionPaths: { worker: '/fixture/worker.md', reviewer: '/fixture/reviewer.md', watcher: '/fixture/watcher.md' } });
  expect(result.instructions).toEqual({ worker: 'Asset instructions for worker.\n', reviewer: 'Asset instructions for reviewer.\n', watcher: 'Asset instructions for watcher.\n' });
});
