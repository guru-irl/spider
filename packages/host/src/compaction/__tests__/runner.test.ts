import { test, expect, vi } from 'vitest';
import { setup, pi, summaryCalls } from './harness.js';
import spiderExtension from '../../extension.js';
import { controlConfig } from '../../control.js';
import { registerOrganism } from '@spider/organism';

function extension(handlers = new Map<string, any[]>()) {
  return { path: 'fixture', resolvedPath: 'fixture', sourceInfo: { source: 'fixture', scope: 'temporary', origin: 'top-level' }, handlers,
    tools: new Map(), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map() } as any;
}
function runner(extensions: any[], f: ReturnType<typeof setup>) {
  const runtime = pi.createExtensionRuntime();
  const sm = pi.SessionManager.inMemory(f.ctx.cwd);
  const r = new pi.ExtensionRunner(extensions, runtime, f.ctx.cwd, sm, f.registry);
  r.bindCore({ getThinkingLevel: () => 'low' } as any, {
    getModel: () => f.ctx.model, getScopedModels: () => [], isIdle: () => true,
    isProjectTrusted: () => true, getSignal: () => undefined, getContextUsage: f.ctx.getContextUsage,
  } as any);
  return r;
}
// Break: host registers only a parent or only a child path, or it ignores configured summaries.
for (const child of [false, true]) test(`host mounts compaction in ${child ? 'child' : 'parent'} mode`, async () => {
  const f = setup(child); const ext = extension();
  const api: any = { on: (name: string, fn: any) => ext.handlers.set(name, [...(ext.handlers.get(name) ?? []), fn]),
    registerTool: () => {}, registerCommand: () => {}, getThinkingLevel: () => 'low' };
  spiderExtension(api);
  if (child) { expect(ext.handlers.get('turn_end') ?? []).toHaveLength(1); expect(summaryCalls).toHaveLength(0); }
  else {
    const handlers = ext.handlers.get('session_before_compact'); expect(handlers).toHaveLength(3);
    // Configure the isolated project, not the user's real config.
    vi.stubEnv('GIT_CEILING_DIRECTORIES', `${f.ctx.cwd}/..`);
    controlConfig('set', f.ctx.cwd, 'compaction.summaryModel', 'fixture-provider/summary-model');
    const r = await handlers.at(-1)(f.event, f.ctx);
    expect(r?.compaction.details.summaryModel).toBe('fixture-provider/summary-model');
    expect(summaryCalls).toHaveLength(1);
  }
});
// Break: organism overwrites the returned summary, independent of extension/handler order.
for (const across of [false, true]) for (const organismFirst of [false, true]) {
  test(`real runner preserves managed result with organism ${organismFirst ? 'before' : 'after'}, ${across ? 'across extensions' : 'within extension'}`, async () => {
    const f = setup(); const managed = extension(new Map([['session_before_compact', [f.handlers.get('session_before_compact')]]]));
    const organism = across ? extension() : managed;
    const onError = vi.fn();
    // Real organism registration with a failing resolver, exercising its actual no-result contract.
    const organismApi = { on: (name: string, fn: any) => {
      const list = organism.handlers.get(name) ?? [];
      organism.handlers.set(name, organismFirst ? [fn, ...list] : [...list, fn]);
    } };
    registerOrganism(null, organismApi, () => { throw new Error('fixture drain failure'); }, onError);
    const extensions = across ? (organismFirst ? [organism, managed] : [managed, organism]) : [managed];
    const r: any = await runner(extensions, f).emit(f.event);
    expect(r?.compaction?.details).toMatchObject({ source: 'spider-compaction', summaryModel: 'fixture-provider/summary-model' });
    expect(onError).toHaveBeenCalledTimes(1); expect(summaryCalls).toHaveLength(1);
  });
}
// Characterization: pi uses last truthy result and short-circuits cancellation, not a field merge.
test('real runner last truthy result wins and cancellation stops later handlers', async () => {
  const f = setup(); const managed = extension(new Map([['session_before_compact', [f.handlers.get('session_before_compact')]]]));
  const later = extension(new Map([['session_before_compact', [() => ({ compaction: { summary: 'foreign' } })]]]));
  expect((await runner([managed, later], f).emit(f.event) as any)?.compaction?.summary).toBe('foreign');
  summaryCalls.length = 0;
  const cancelled = extension(new Map([['session_before_compact', [() => ({ cancel: true })]]]));
  expect(await runner([cancelled, managed], f).emit(f.event)).toEqual({ cancel: true });
  expect(summaryCalls).toHaveLength(0);
});
