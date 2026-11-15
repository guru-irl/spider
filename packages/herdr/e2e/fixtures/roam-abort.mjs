// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// Request Pi's normal context abort; queue behavior is owned by the active Pi mode.
export default function (pi) {
  pi.registerCommand('fixture-abort', { description: 'Abort the current scripted turn', handler(_args, ctx) { ctx.abort(); } });
  pi.registerCommand('fixture-reload', { description: 'Reload the real extension runtime', async handler(_args, ctx) { await ctx.reload(); } });
}
