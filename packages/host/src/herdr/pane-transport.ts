// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { PANE_ENDPOINT_BOOTSTRAP, PANE_INSTALLATION_REFUSALS } from './pane-installation.js';
import type { CoreId, HcArgvClient } from '../../../herdr/src/contracts.js';
import { HerdrError, parseJson } from '../../../herdr/src/client/parse.js';
import { encodeRemotePaneRequest, panePath, parseRemotePaneReply, PANE_REPLY_LIMIT } from '../../../herdr/src/panes/codec.js';
import type { RemotePaneRequest, RemotePaneReply } from '../../../herdr/src/panes/types.js';
import type { PaneFolderMachine } from './pane-folders.js';
export interface PaneEndpointRoute { on: string; coreId: CoreId; nodePath: string }
export function createPaneRemoteRequest(ports: {
  buildDigest: string; exec: HcArgvClient['exec']; resolveMachine(machine: PaneFolderMachine): Promise<PaneEndpointRoute>;
}): (machine: PaneFolderMachine, request: RemotePaneRequest) => Promise<RemotePaneReply> {
  return async (machine, request) => {
    const deadline = performance.now() + 5000;
    const route = await ports.resolveMachine(machine);
    if (route.coreId !== machine.coreId || !route.on) throw new HerdrError('machine-changed', 'Selected machine changed');
    panePath(route.nodePath);
    const verify = async () => {
      const current = await ports.resolveMachine(machine);
      if (current.coreId !== route.coreId || current.on !== route.on || current.nodePath !== route.nodePath) throw new HerdrError('machine-changed', 'Selected machine changed');
    };
    const call = async (value: RemotePaneRequest) => {
      const timeoutMs = Math.floor(deadline - performance.now());
      if (timeoutMs <= 0) throw new HerdrError('pane-timeout', 'Pane endpoint deadline exceeded');
      let bytes: Buffer;
      try { bytes = await ports.exec(route.on, [route.nodePath, '-e', PANE_ENDPOINT_BOOTSTRAP, ports.buildDigest, '1', encodeRemotePaneRequest(value)], { timeoutMs, maxBytes: PANE_REPLY_LIMIT }); }
      catch (error) {
        const details = error instanceof HerdrError ? error.details as { stderr?: unknown } | undefined : undefined;
        let code: unknown; try { code = JSON.parse(typeof details?.stderr === 'string' ? details.stderr.trim() : '').code; } catch { /* Preserve unrecognized transport failures. */ }
        if (PANE_INSTALLATION_REFUSALS.includes(code as never)) throw new HerdrError(String(code), 'Redeploy the source installation');
        throw error;
      }
      if (bytes.length > PANE_REPLY_LIMIT) throw new HerdrError('pane-reply-limit', 'Pane endpoint reply exceeded its bound');
      return parseRemotePaneReply(parseJson(bytes));
    };
    const handshake = await call({ version: 1, op: 'handshake', protocol: 1, buildDigest: ports.buildDigest });
    if (handshake.op !== 'handshake' || handshake.protocol !== 1 || handshake.buildDigest !== ports.buildDigest) throw new HerdrError('pane-build-mismatch', 'Pane endpoint protocol or digest differs');
    await verify();
    const reply = await call(request);
    if (reply.op !== request.op) throw new HerdrError('pane-reply-mismatch', 'Pane endpoint replied to another operation');
    await verify(); return reply;
  };
}
