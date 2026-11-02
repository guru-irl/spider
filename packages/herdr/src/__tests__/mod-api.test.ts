// SPDX-License-Identifier: MIT
import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { generateModApi, assertApiMatches } from '../../scripts/generate-mod-api.mjs';
import { createUiModules, createHostModule, modApi, initView, strictInit } from './strict-mod-api.mjs';

// Authored test input, not a copy of app declarations.
const host = 'export function ask(): void; export interface Reply { value: string; }';
const ui = `declare module "gpui-kit" {
  export class View {}
  export interface NativeElement { child(value: string): NativeElement; }
  export function div(): NativeElement;
}
declare module "gpui-base" {
  import type { NativeElement } from "gpui-kit";
  export interface FancyElement extends NativeElement { sparkle(): FancyElement; }
  export const Fancy: { new(id: string): FancyElement };
}
declare module "gpui" { export * from "gpui-kit"; }`;

test('fake modules and elements expose exactly the committed names', () => {
  const modules = { ...createUiModules(), herdr: createHostModule({}) };
  for (const [name, values] of Object.entries(modules)) expect(Object.keys(values).sort()).toEqual(modApi.modules[name]);
  const element = createUiModules()['gpui-base'].Button.new('button');
  expect(Object.keys(Object.getPrototypeOf(element)).sort()).toEqual(modApi.elements['gpui-kit.NativeElement']);
  expect(element.label).toBeUndefined();
});

test('init gets an empty object and layout props come only from props(), as in Herdr 0.1.11', () => {
  const layoutProps = { feedRoot: '/fixture/feeds' }, seen: unknown[] = [];
  const herdr = createHostModule({ props: () => layoutProps });
  const view = strictInit({ init(first: unknown, _cx: unknown) { seen.push(first, herdr.props()); } });
  initView(view, {});
  expect(seen).toEqual([{}, layoutProps]);
  expect(() => view.init(layoutProps, {})).toThrow('props()');
});

test('extracts runtime exports rather than types and follows export aliases', () => {
  expect(generateModApi(host, ui).modules).toEqual({
    herdr: ['ask'], gpui: ['View', 'div'], 'gpui-base': ['Fancy'], 'gpui-kit': ['View', 'div'],
  });
});
test('extracts exact element methods including inherited methods', () => {
  expect(generateModApi(host, ui).elements).toEqual({
    'gpui-base.FancyElement': ['child', 'sparkle'], 'gpui-kit.NativeElement': ['child'], 'gpui.NativeElement': ['child'],
  });
});
test('the committed fixture rejects changed exports and changed methods independently', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/mod-api.json', import.meta.url), 'utf8'));
  expect(() => assertApiMatches(fixture, structuredClone(fixture))).not.toThrow();
  const exportDrift = structuredClone(fixture); exportDrift.modules['gpui-kit'][0] = 'InvalidExport';
  expect(() => assertApiMatches(exportDrift, fixture)).toThrow('drift');
  const methodDrift = structuredClone(fixture); methodDrift.elements['gpui-kit.NativeElement'][0] = 'invalid_method';
  expect(() => assertApiMatches(methodDrift, fixture)).toThrow('drift');
});
test('a given declaration set drifts when a factory moves modules or a method disappears', () => {
  const expected = generateModApi(host, ui);
  const changedModule = ui.replace('export function div(): NativeElement;', '').replace('export const Fancy:', 'export function div(): NativeElement; export const Fancy:');
  expect(() => assertApiMatches(generateModApi(host, changedModule), expected)).toThrow('drift');
  const changedMethod = ui.replace('sparkle(): FancyElement;', '');
  expect(() => assertApiMatches(generateModApi(host, changedMethod), expected)).toThrow('drift');
});
