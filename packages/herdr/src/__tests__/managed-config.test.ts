import { expect, test } from 'vitest';
import { disableRootNotes, rootNotesValue } from '../setup/backup.js';

const input = `description = '''
notes = true
[not_a_table]
'''
choices = [
  [1, 2],
  [3, 4]
]
notes = true # root setting
[other]
notes = true
`;
const expected = `description = '''
notes = true
[not_a_table]
'''
choices = [
  [1, 2],
  [3, 4]
]
notes = false # root setting
[other]
notes = true
`;
test('only the real root notes key is changed, not strings arrays or tables', () => {
  expect(disableRootNotes(Buffer.from(input)).toString()).toBe(expected);
  expect(rootNotesValue(Buffer.from(expected))).toBe(false);
  expect(disableRootNotes(Buffer.from(expected)).toString()).toBe(expected);
});
test('quoted root keys and escaped strings do not expose a false notes key', () => {
  const source = 'description = """escaped \\"quoted\\"\nnotes = true\n[not_a_table]\n"""\n"notes" = true\n';
  expect(disableRootNotes(Buffer.from(source)).toString()).toBe(source.replace('"notes" = true', '"notes" = false'));
});
