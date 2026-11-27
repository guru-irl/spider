// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';

export const groupCount = 4;
export const rootTest = /^packages\/[^/]+\/src\/.+\.test\.ts$/;
export const sorted = values => [...new Set(values)].sort();
const sha256 = /^[\da-f]{64}$/;
export const safePath = file => typeof file === 'string' && /^[a-zA-Z0-9_./-]+$/.test(file)
  && !file.split('/').some(part => part === '' || part === '.' || part === '..');

export function selectionHash(selection) {
  const { selectionHash: _hash, ...payload } = selection;
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function validateSelection(selection, head) {
  if (selection?.version !== 1 || selection.head !== head) throw new Error('Selection belongs to a different checkout');
  if (!sha256.test(selection.selectionHash) || selectionHash(selection) !== selection.selectionHash) {
    throw new Error('Selection hash does not match the manifest');
  }
  if (!selection.selected || typeof selection.selected !== 'object' || Array.isArray(selection.selected)
      || !Array.isArray(selection.groups) || selection.groups.length !== groupCount || !selection.groups.every(Array.isArray)) {
    throw new Error('Invalid selection groups');
  }
  const files = selection.groups.flat();
  const selected = Object.keys(selection.selected).sort();
  if (files.some(file => !safePath(file) || !rootTest.test(file)) || files.length !== selected.length
      || sorted(files).some((file, i) => file !== selected[i]) || new Set(files).size !== files.length) {
    throw new Error('Selection groups must cover every selected test once');
  }
  return selection;
}

export function requireAgreement({ needs, hashes, selection, head }) {
  if (needs?.compile?.result !== 'success' || needs?.tests?.result !== 'success') {
    throw new Error('Compile and every test runner must succeed');
  }
  const { selectionHash: expected } = validateSelection(selection, head);
  if (!Array.isArray(hashes) || hashes.length !== groupCount || hashes.some((row, i) =>
    row?.group !== i + 1 || row.selectionHash !== expected)) {
    throw new Error('Test runners used different selections or a runner did not report its hash');
  }
  return expected;
}
