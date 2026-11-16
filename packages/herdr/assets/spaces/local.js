// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan

export function localSpaces(spaces) {
  return spaces.filter(space => space.machine === null);
}

export function localSpaceRows(spaces) {
  return localSpaces(spaces).map(space => ({ space, index: space.index, tree: null }));
}

export function localSpaceCreateArgs() {
  return { machine: '' };
}
