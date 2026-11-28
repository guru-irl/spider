import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";

/** Opt in custom messages with a distinct expanded view. Pi still owns tool clicks. */
export function withClickExpansion(render: MessageRenderer): MessageRenderer {
  const { Container, MouseRegion } = tui;
  if (typeof MouseRegion !== "function") return render;

  // Store the global flag at the time of a local override. A change to that
  // flag (Ctrl+O) discards the override; an invalidate with the same flag doesn't.
  const overrides = new WeakMap<object, boolean>();
  return (message, options, theme) => {
    const globalExpanded = options.expanded === true;
    const hasOverride = overrides.get(message) === globalExpanded;
    if (!hasOverride) overrides.delete(message);
    let expanded = hasOverride ? !globalExpanded : globalExpanded;
    const build = (expanded: boolean) => render(message, { ...options, expanded }, theme);
    const initial = build(expanded);
    if (!initial) return undefined;

    const body = new Container();
    body.addChild(initial);
    return new MouseRegion(body, event => {
      if (event.type !== "click" || event.button !== "left" || event.x < 0 || event.x >= event.width
        || event.y < 0 || event.y >= event.height) return undefined;
      const next = build(!expanded);
      if (!next) return undefined;
      expanded = !expanded;
      if (expanded === globalExpanded) overrides.delete(message);
      else overrides.set(message, globalExpanded);
      body.clear();
      body.addChild(next);
      return { handled: true };
    });
  };
}
