// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan

// The wire envelope is checked by requestPaneService. Validate the fields used
// by the shared presentation projection before accepting a new authority.
function validateSnapshot(snapshot) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const target = value => object(value) && typeof value.address === 'string' && typeof value.coreId === 'string'
    && typeof value.terminalId === 'string' && object(value.identityLabels);
  if (!object(snapshot) || !Array.isArray(snapshot.rows) || !Array.isArray(snapshot.presentations)
    || !snapshot.rows.every(row => object(row) && typeof row.sessionId === 'string'
      && Array.isArray(row.children) && row.children.every(child => object(child) && typeof child.runId === 'string')
      && Array.isArray(row.consoles) && row.consoles.every(console => object(console) && typeof console.consoleId === 'string' && (console.target === null || target(console.target)))
      && (row.unavailableReason ? row.target === null : target(row.target) && object(row.owner?.terminal) && typeof row.owner.terminal.address === 'string'))
    || !snapshot.presentations.every(presentation => object(presentation) && typeof presentation.id === 'string'
      && typeof presentation.revision === 'number' && target(presentation.target))) throw new Error('Invalid pane snapshot');
}

/** Keep the last validated snapshot; a failed request never selects native mode. */
export function createPaneServiceState(config, { exec, timer, request, index, refreshMs, staleMs, changed }) {
  const configured = config?.paneServiceConfigured === true;
  const emptyIndex = { snapshot: null, sources: new Map(), hidden: new Map(), key: '' };
  let current = null, lastSuccess = null, retryAt = 0, failures = 0, pending = null, closed = false;
  const unavailable = () => configured && (lastSuccess === null || Date.now() - lastSuccess > staleMs);
  const state = () => ({ configured, index: configured ? current?.index ?? emptyIndex : null,
    snapshot: current?.snapshot ?? null, unavailable: unavailable() });
  const refresh = () => {
    if (!configured || closed) return Promise.resolve();
    if (pending) return pending;
    if (Date.now() < retryAt) return Promise.resolve();
    retryAt = Date.now() + refreshMs;
    pending = (async () => {
      let timeout;
      try {
        const snapshot = await Promise.race([
          request(config, (program, args, options) => exec(program, args, { ...options, timeout: refreshMs }), { op: 'snapshot' }),
          new Promise((_, reject) => { timeout = timer.every(refreshMs, () => reject(new Error('Pane service timed out'))); }),
        ]);
        validateSnapshot(snapshot);
        const parsed = index(snapshot);
        if (closed) return;
        current = { snapshot, index: parsed }; lastSuccess = Date.now(); failures = 0; retryAt = lastSuccess + refreshMs;
      } catch {
        if (closed) return;
        retryAt = Date.now() + Math.min(60000, refreshMs * 2 ** Math.min(failures++, 4));
      } finally {
        timeout?.cancel(); pending = null;
        if (!closed) changed();
      }
    })();
    return pending;
  };
  return { state, refresh, close() { closed = true; } };
}

/** Leave rows visible but prohibit native actions for unavailable remote owners. */
export function disableUnavailableRemoteActions(targets, unavailable, localCoreId) {
  if (!unavailable) return targets;
  const disabled = new Set();
  return targets.map(target => {
    const qualifiedRemote = target.terminal?.includes('/') && (!localCoreId || !target.terminal.startsWith(`${localCoreId}/`));
    const remote = Boolean(target.machine || qualifiedRemote || target.ownerId && disabled.has(target.ownerId));
    if (!remote) return target;
    disabled.add(target.id);
    return { ...target, action: null, disabledReason: 'Pane service unavailable; run doctor' };
  });
}
