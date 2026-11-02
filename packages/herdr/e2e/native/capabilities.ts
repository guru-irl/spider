export interface RenderedUi {
  frame: number;
  nodes: readonly { id: string; text: string; enabled: boolean; bounds: readonly [number, number, number, number] }[];
}
export class NativePrerequisite extends Error {
  readonly code: string = 'HERDR_E2E_PREREQUISITE';
  readonly prerequisite: string = 'native-rendered-ui-input-hook';
  constructor(version: string, operation: string) {
    super(`prerequisite: native-rendered-ui-input-hook (${operation}; app ${version} has no verified owned-window rendered/input adapter)`);
    this.name = 'NativePrerequisite';
  }
}
export function nativeInteraction(version: string): {
  uiSnapshot(): Promise<RenderedUi>;
  activate(controlId: string): Promise<void>;
  keyToOwnedWindow(key: string): Promise<void>;
} {
  return {
    async uiSnapshot() { throw new NativePrerequisite(version, 'uiSnapshot'); },
    async activate(_controlId) { throw new NativePrerequisite(version, 'activate'); },
    async keyToOwnedWindow(_key) { throw new NativePrerequisite(version, 'keyToOwnedWindow'); },
  };
}
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid native snapshot object');
  return raw as Record<string, unknown>;
}
export function parseRenderedUi(raw: unknown): RenderedUi {
  const snapshot = object(raw);
  if (!Number.isSafeInteger(snapshot.frame) || Number(snapshot.frame) < 1 || !Array.isArray(snapshot.nodes)) throw new Error('invalid native snapshot frame/nodes');
  const ids = new Set<string>();
  const nodes = snapshot.nodes.map(rawNode => {
    const node = object(rawNode);
    if (typeof node.id !== 'string' || !node.id || typeof node.text !== 'string' || typeof node.enabled !== 'boolean') throw new Error('invalid native snapshot node');
    if (ids.has(node.id)) throw new Error('duplicate native node ID');
    ids.add(node.id);
    if (!Array.isArray(node.bounds) || node.bounds.length !== 4 || !node.bounds.every(v => typeof v === 'number' && Number.isFinite(v)) || node.bounds[2] <= 0 || node.bounds[3] <= 0) throw new Error('invalid native snapshot bounds');
    return { id: node.id, text: node.text, enabled: node.enabled, bounds: node.bounds as [number, number, number, number] };
  });
  return { frame: Number(snapshot.frame), nodes };
}
export function windowPlacement(options: { consent: boolean; displayUuid: string }, display: { uuid: string; builtIn: boolean; bounds: readonly [number, number, number, number] }): { state: 'windowed'; bounds: readonly [number, number, number, number]; display: string } {
  if (!options.consent) throw new Error('prerequisite: explicit native app consent');
  if (!options.displayUuid || options.displayUuid !== display.uuid) throw new Error('prerequisite: chosen display must match observed UUID');
  if (!display.builtIn) throw new Error('prerequisite: chosen display must be built-in');
  const [x, y, width, height] = display.bounds;
  if (!display.bounds.every(Number.isFinite) || width < 1400 || height < 900) throw new Error('native window does not fit chosen display');
  return { state: 'windowed', bounds: [x + (width - 1400) / 2, y + (height - 900) / 2, 1400, 900], display: display.uuid };
}
