export function element<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
export function action(document: Document, label: string, run: () => void): HTMLButtonElement {
  const node = element(document, "button", label, "action");
  node.type = "button";
  node.addEventListener("click", run);
  return node;
}
export function liveMessage(document: Document): HTMLElement {
  const node = element(document, "p", "", "notice");
  node.setAttribute("role", "status"); node.setAttribute("aria-live", "polite");
  return node;
}
