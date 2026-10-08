const actions = new WeakMap<Element, () => void>();
export function element<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
export function action(document: Document, label: string, run: () => void): HTMLButtonElement {
  const node = element(document, "button", label, "action");
  node.type = "button";
  actions.set(node, run);
  node.addEventListener("click", () => actions.get(node)?.());
  return node;
}

/** Patch evidence without detaching retained controls or scroll regions. Chart
 * representation is user state, not server data. Other actions adopt new rows. */
export function updateEvidence(parent: HTMLElement, ...incoming: HTMLElement[]): void {
  function patch(old: Element, next: Element, chart = false, toggles = false): void {
    chart ||= (old.getAttribute("class") ?? "").split(" ").includes("chart-panel");
    toggles ||= chart && old.getAttribute("aria-label") === "Chart representation";
    const preserve = (name: string) => chart && (name === "hidden" || name === "aria-pressed");
    for (const name of old.getAttributeNames()) if (!preserve(name) && !next.hasAttribute(name)) old.removeAttribute(name);
    for (const name of next.getAttributeNames()) if (!preserve(name)) old.setAttribute(name, next.getAttribute(name)!);
    if (!chart) (old as HTMLElement).hidden = (next as HTMLElement).hidden;
    const run = actions.get(next); if (run && !toggles) actions.set(old, run);
    const children = Array.from(next.children);
    if (!children.length) { if (old.textContent !== next.textContent) old.textContent = next.textContent; return; }
    if (!old.children.length && old.textContent) old.textContent = "";
    reconcile(old, children, chart, toggles);
  }
  function reconcile(parent: Element, children: Element[], chart = false, toggles = false): void {
    children.forEach((next, index) => {
      const old = parent.children[index];
      if (!old) parent.append(next);
      else if (old.tagName === next.tagName && old.getAttribute("class") === next.getAttribute("class")) patch(old, next, chart, toggles);
      else old.replaceWith(next);
    });
    while (parent.children.length > children.length) parent.lastElementChild!.remove();
  }
  reconcile(parent, incoming);
}

export function sectionState(root: HTMLElement, state: "loading" | "empty" | "error", message: string, retry?: () => void): void {
  const document = root.ownerDocument;
  root.setAttribute("aria-busy", String(state === "loading"));
  const notice = element(document, "p", message, "notice"); notice.setAttribute("role", "status"); notice.setAttribute("aria-live", "polite"); notice.setAttribute("data-state", state);
  root.replaceChildren(notice);
  if (state === "error" && retry) root.append(action(document, "Retry", retry));
}

/** Shared fact grammar: a text label and a machine-value chip. */
export function chip(document: Document, label: string, value: string): HTMLElement {
  const node = element(document, "span", undefined, "stat-chip");
  node.append(element(document, "span", label), element(document, "strong", value, "mono"));
  return node;
}
