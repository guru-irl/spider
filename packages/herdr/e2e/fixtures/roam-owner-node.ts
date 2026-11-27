// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Preserve argv and process identity while loading the observer in one packed entry. */
export function ownerNodeScript(node: string, register: string, entry: string, directory: string): string {
  return `#!/bin/sh\nSPIDER_HERDR_E2E_OWNER_ENTRY=${quote(entry)} SPIDER_HERDR_E2E_OWNER_DIR=${quote(directory)} exec ${quote(node)} --import ${quote(register)} "$@"\n`;
}
