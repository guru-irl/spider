// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { RunId } from '../contracts.js';
import type { SteerReply, SessionIpcReply } from '../contracts.js';
/** The narrow action port implemented by B's SessionIpcClient. */
export interface ViewerSteerClient { steerRun(runId: RunId, text: string): Promise<SessionIpcReply> }
export async function submitViewerSteer(client: ViewerSteerClient, runId: RunId, text: string): Promise<SteerReply> {
  if (!text.trim() || text.trimStart().startsWith('/') || Buffer.byteLength(text, 'utf8') > 16 * 1024) {
    return { accepted: false, delivered: false, queued: false, delivery: 'refused', error: 'Use nonblank text of at most 16 KiB that does not start with /.' };
  }
  try {
    const reply = await client.steerRun(runId, text);
    if (!reply.ok) return { accepted: false, delivered: false, queued: false, delivery: 'refused', error: reply.message };
    if (reply.op !== 'steerRun') throw new Error('Unexpected IPC action acknowledgement');
    return reply.acknowledgement;
  }
  catch { return { accepted: false, delivered: false, queued: false, delivery: 'no reply yet, delivery unknown', error: 'The connection closed without an acknowledgement. Do not resend this steer.' }; }
}
