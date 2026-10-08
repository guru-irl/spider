type Listener = (event: Event) => void;

/** This fixture implements structure/events only. Layout, HTML parsing and styling throw. */
export class PlainElement {
  readonly children: PlainElement[] = [];
  readonly attributes: Map<string, string> = new Map<string, string>();
  readonly listeners: Map<string, Set<Listener>> = new Map<string, Set<Listener>>();
  parentElement: PlainElement | null = null;
  private ownText = "";
  private isHidden = false;
  get hidden(): boolean { return this.isHidden; }
  set hidden(value: boolean) { this.isHidden = value; if (value && this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body; }
  disabled = false;
  value = "";
  constructor(readonly ownerDocument: PlainDocument, readonly tagName: string, readonly namespaceURI: string | null = null) {}
  get firstElementChild(): PlainElement | null { return this.children[0] ?? null; }
  get lastElementChild(): PlainElement | null { return this.children.at(-1) ?? null; }
  getAttributeNames(): string[] { return [...this.attributes.keys()]; }
  hasAttribute(key: string): boolean { return this.attributes.has(key); }
  replaceWith(node: PlainElement): void { const parent = this.parentElement; if (!parent) return; const index = parent.children.indexOf(this); this.remove(); node.remove(); node.parentElement = parent; parent.children.splice(index, 0, node); }
  querySelector<T extends Element = Element>(selector: string): T | null { const tags = selector.split(",").map(tag => tag.trim().toLowerCase()); return (descendants(this).slice(1).find(node => tags.includes(node.tagName.toLowerCase())) ?? null) as unknown as T | null; }
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.ownText = String(value); this.replaceChildren(); }
  get className(): string { return this.getAttribute("class") ?? ""; }
  set className(value: string) { this.setAttribute("class", value); }
  get id(): string { return this.getAttribute("id") ?? ""; }
  set id(value: string) { this.setAttribute("id", value); }
  get type(): string { return this.getAttribute("type") ?? ""; }
  set type(value: string) { this.setAttribute("type", value); }
  get innerHTML(): never { throw new Error("plain-dom: HTML parsing unsupported"); }
  set innerHTML(_value: string) { throw new Error("plain-dom: HTML parsing unsupported"); }
  get style(): never { throw new Error("plain-dom: inline styling unsupported"); }
  get offsetWidth(): never { throw new Error("plain-dom: layout unsupported"); }
  getBoundingClientRect(): never { throw new Error("plain-dom: layout unsupported"); }
  setAttribute(key: string, value: string): void {
    if (/^on/i.test(key) || key === "style") throw new Error(`plain-dom: unsafe attribute ${key}`);
    this.attributes.set(key, String(value));
  }
  getAttribute(key: string): string | null { return this.attributes.get(key) ?? null; }
  removeAttribute(key: string): void { this.attributes.delete(key); }
  contains(node: PlainElement | null): boolean { return node !== null && (node === this || this.children.some(child => child.contains(node))); }
  append(...children: PlainElement[]): void { for (const child of children) this.appendChild(child); }
  appendChild<T extends PlainElement>(child: T): T { child.remove(); child.parentElement = this; this.children.push(child); return child; }
  replaceChildren(...children: PlainElement[]): void { for (const child of [...this.children]) child.remove(); this.append(...children); }
  remove(): void { if (this.parentElement) { if (this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body; const siblings = this.parentElement.children; siblings.splice(siblings.indexOf(this), 1); this.parentElement = null; } }
  addEventListener(type: string, listener: Listener, options?: unknown): void { const list = this.listeners.get(type) ?? new Set(); list.add(listener); this.listeners.set(type, list); }
  removeEventListener(type: string, listener: Listener): void { this.listeners.get(type)?.delete(listener); }
  dispatchEvent(event: Event): boolean { for (const listener of this.listeners.get(event.type) ?? []) listener(event); return true; }
  click(): void { if (!this.disabled) this.dispatchEvent(new Event("click")); }
  focus(): void { this.ownerDocument.activeElement = this; }
}

export class PlainDocument {
  readonly head: PlainElement = new PlainElement(this, "HEAD");
  readonly body: PlainElement = new PlainElement(this, "BODY");
  activeElement: PlainElement | null = null;
  visibilityState: DocumentVisibilityState = "visible";
  readyState: DocumentReadyState = "complete";
  fonts: { load(font: string): Promise<unknown[]>; check?(font: string): boolean } | undefined;
  readonly listeners: Map<string, Set<Listener>> = new Map<string, Set<Listener>>();
  readonly listenerOptions: Map<string, unknown> = new Map<string, unknown>();
  createElement(tag: string): PlainElement {
    if (!/^(a|button|caption|code|dd|div|dl|dt|h1|h2|h3|header|input|label|link|main|nav|option|p|section|select|small|span|strong|table|tbody|td|th|thead|time|tr)$/i.test(tag)) throw new Error(`plain-dom: unsupported element ${tag}`);
    return new PlainElement(this, tag.toUpperCase());
  }
  createElementNS(ns: string, tag: string): PlainElement {
    if (ns !== "http://www.w3.org/2000/svg" || !/^(svg|title|circle|line|text|g|path)$/.test(tag)) throw new Error("plain-dom: unsupported namespace element");
    return new PlainElement(this, tag, ns);
  }
  getElementById(id: string): PlainElement | null { return descendants(this.body).find(node => node.id === id) ?? null; }
  addEventListener(type: string, listener: Listener, options?: unknown): void { const list = this.listeners.get(type) ?? new Set(); list.add(listener); this.listeners.set(type, list); this.listenerOptions.set(type, options); }
  removeEventListener(type: string, listener: Listener): void { this.listeners.get(type)?.delete(listener); }
  dispatchEvent(event: Event): boolean { for (const listener of this.listeners.get(event.type) ?? []) listener(event); return true; }
  asDocument(): Document { return this as unknown as Document; }
}
export function descendants(element: PlainElement): PlainElement[] { return [element, ...element.children.flatMap(descendants)]; }
export function elements(element: HTMLElement | PlainElement, tag: string): PlainElement[] { return descendants(element as PlainElement).filter(node => node.tagName.toLowerCase() === tag.toLowerCase()); }
export function button(element: HTMLElement | PlainElement, label: string): PlainElement { const found = elements(element, "button").find(node => node.textContent === label); if (!found) throw new Error(`Missing button: ${label}`); return found; }
export async function settle(): Promise<void> { for (let i = 0; i < 12; i++) await Promise.resolve(); }

/** The visible stacked label is silent; accounting assertions use cell values. */
export function cellText(cell: PlainElement): string { return cell.children.find(child => child.className === "cell-value")?.textContent ?? cell.textContent; }
