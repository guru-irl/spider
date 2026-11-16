// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
const messages = {
  'wrong-generation': 'Owning session unavailable',
  'not-found': 'Owning session unavailable',
  'unknown-op': 'Run /reload to enable session reopening',
  'pane-timeout': 'Timed out opening the pane',
  'The session pane was not acknowledged': 'Timed out opening the pane',
  'view-on-mac': 'This needs the Herdr app on this Mac',
  'This view is available on the Mac.': 'This needs the Herdr app on this Mac',
  'focus-changed': 'Focus changed before the session could open',
  'geometry-too-small': 'The pane is too small to open the session',
  'no-local-space': 'No local space is available to reopen the session',
  'core-mismatch': 'Owning session unavailable',
  'machine-unreachable': 'The owning machine is unreachable',
  'no-space-on-machine': 'No space on the owning machine to reopen it in',
  'open-aborted': 'Opening the session was cancelled',
};

export function describeOpenFailure(reply) {
  if (!reply || reply.ok !== false) return "Couldn't open the session";
  if (typeof messages[reply.code] === 'string') return messages[reply.code];
  if (typeof messages[reply.message] === 'string') return messages[reply.message];
  if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252} is unreachable$/.test(reply.message)
    || /^No space on [a-zA-Z0-9][a-zA-Z0-9._-]{0,252} to reopen it in$/.test(reply.message)) return reply.message;
  return "Couldn't open the session";
}
