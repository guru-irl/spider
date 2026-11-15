// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
export function connectCommands(session) {
  if (typeof session !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(session)) return [];
  const posix = `sh -c 'p=$(command -v herdr-core) || p=$HOME/.local/bin/herdr-core; [ -x "$p" ] || { echo "herdr-core is not installed here" >&2; exit 127; }; HC_SESSION=${session} exec "$p" connect'`;
  const windows = `cmd /d /c "if exist .\\AppData\\Local\\Programs\\herdr-core\\herdr-core.exe (.\\AppData\\Local\\Programs\\herdr-core\\herdr-core.exe connect --session ${session}) else (echo herdr-core is not installed here 1>&2 & exit /b 127)"`;
  return [posix, windows];
}
export function acceptsConnectCommand(command, session) {
  return typeof command === 'string' && connectCommands(session).includes(command);
}
export function pairConnectCommand(command, session, entries) {
  if (!Array.isArray(entries)) return null;
  const entry = entries.find(value => value?.envelope === command && acceptsConnectCommand(value.command, session));
  return entry?.command ?? null;
}
