// SPDX-License-Identifier: MIT
export const SINGLE_REPLY_BYTES: number = 1024 * 1024;
export const TERMINAL_LIST_BYTES: number = 64 * 1024 * 1024;

export function cliReplyByteLimit(argv: readonly string[]): number {
  return argv[0] === 'ls' || argv[1] === 'ls' ? TERMINAL_LIST_BYTES : SINGLE_REPLY_BYTES;
}
