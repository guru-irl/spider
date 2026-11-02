import { describe, expect, it } from 'vitest';
import { nativeInteraction, parseRenderedUi, windowPlacement } from './capabilities.js';

describe('native capability boundary', () => {
  it('blocks every rendered input operation on app 0.1.11 with a named prerequisite', async () => {
    const driver = nativeInteraction('0.1.11');
    for (const action of [() => driver.uiSnapshot(), () => driver.activate('owned-control'), () => driver.keyToOwnedWindow('cmd-shift-a')]) {
      await expect(action()).rejects.toMatchObject({ code: 'HERDR_E2E_PREREQUISITE', prerequisite: 'native-rendered-ui-input-hook' });
    }
    // A newer version string alone is not proof of a verified native hook.
    await expect(nativeInteraction('9.9.9').activate('control')).rejects.toMatchObject({ prerequisite: 'native-rendered-ui-input-hook' });
  });
  it('parses actual snapshot bounds and refuses empty-success or malformed replies', () => {
    const raw = { frame: 3, nodes: [{ id: 'button', text: 'Todos', enabled: true, bounds: [10,20,40,30] }] };
    expect(parseRenderedUi(raw)).toEqual(raw);
    expect(() => parseRenderedUi({})).toThrow(/snapshot/);
    expect(() => parseRenderedUi({ frame: 3, nodes: [{ ...raw.nodes[0], bounds: [0,0,-1,30] }] })).toThrow(/bounds/);
    expect(() => parseRenderedUi({ frame: 3, nodes: [raw.nodes[0], raw.nodes[0]] })).toThrow(/duplicate/);
    expect(() => parseRenderedUi({ frame: 3, nodes: [{ ...raw.nodes[0], enabled: 'true' }] })).toThrow(/node/);
  });
  it('places only on the consented built-in display and rejects clipping', () => {
    const display = { uuid: 'fixture-display', builtIn: true, bounds: [0,0,1600,1000] as const };
    expect(windowPlacement({ consent: true, displayUuid: 'fixture-display' }, display)).toEqual({ state: 'windowed', bounds: [100,50,1400,900], display: 'fixture-display' });
    expect(() => windowPlacement({ consent: false, displayUuid: 'fixture-display' }, display)).toThrow(/consent/);
    expect(() => windowPlacement({ consent: true, displayUuid: 'wrong' }, display)).toThrow(/display/);
    expect(() => windowPlacement({ consent: true, displayUuid: 'fixture-display' }, { ...display, builtIn: false })).toThrow(/built-in/);
    expect(() => windowPlacement({ consent: true, displayUuid: 'fixture-display' }, { ...display, bounds: [0,0,1200,800] })).toThrow(/fit/);
  });
});
