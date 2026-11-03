// SPDX-License-Identifier: MIT
export const SINGLE_REPLY_BYTES: number = 1024 * 1024;
export const TERMINAL_LIST_BYTES: number = 16 * 1024 * 1024;
const LIST_COMMANDS: readonly (readonly string[])[] = [['ls'], ['machine', 'ls']];

export function cliReplyByteLimit(argv: readonly string[]): number {
  return LIST_COMMANDS.some(command => command.every((word, index) => argv[index] === word)) ? TERMINAL_LIST_BYTES : SINGLE_REPLY_BYTES;
}
