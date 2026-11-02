import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { HerdrViews } from '@spider/herdr';
import { HerdrError } from '@spider/herdr/client/parse';
export interface SharedViewCommand { handler(args: string, ctx: ExtensionContext): void | Promise<void> }
export interface HostViewOptions {
  agents: { open(): void | Promise<void> };
  todos: SharedViewCommand;
  usage: SharedViewCommand;
  memory(ctx: ExtensionContext): void | Promise<void>;
  loop: SharedViewCommand;
}
export function createHerdrViews(options: HostViewOptions): HerdrViews {
  const owned = (open: (ctx: ExtensionContext) => void | Promise<void>) => async (ctx: ExtensionContext) => {
    if (ctx.mode !== 'tui' || !ctx.hasUI || !ctx.sessionManager.getSessionId()) {
      throw new HerdrError('session-unavailable', 'An owning interactive spider session is required');
    }
    await open(ctx);
  };
  return {
    agents: owned(() => options.agents.open()),
    todos: owned(ctx => options.todos.handler('', ctx)),
    usage: owned(ctx => options.usage.handler('', ctx)),
    memory: owned(options.memory),
    triggers: owned(ctx => options.loop.handler('', ctx)),
  };
}
