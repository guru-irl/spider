// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { ApprovalSummary, SessionFeed, SessionId, SpaceId, TodoSummary } from '../../../src/contracts.js';
export interface SpiderPanelModel {
  sessions: { id: SessionId; feed: SessionFeed }[];
  spaces: { id: SpaceId | null; name: string | null; sessionIds: SessionId[] }[];
  sharedApprovals: ApprovalSummary[];
}
export interface PanelSpace { id: string; name: string | null }
export interface PaceLabelSet { month: string | null; usedCompact: string; used: string; projected: string; budget: string; remaining: string; updatedAt: string | null }
export type PanelPace =
  | { state: 'unavailable'; reason: string }
  | { state: 'unscaled'; used: number; labels: PaceLabelSet; updated: string | null }
  | { state: 'ok'; used: number; projected: number | null; budget: number; usedFraction: number; projectedFraction: number | null;
      todayFraction: number | null; over: boolean; updated: string | null; labels: PaceLabelSet };
export type NotificationPart =
  | { type: 'agent'; icon: 'session' | 'subagent'; text: string }
  | { type: 'machine' | 'command' | 'text' | 'detail'; text: string };
export interface NotificationItem {
  kind: 'waiting' | 'failed' | 'memory' | 'budget' | 'machine'; key: string; parts: NotificationPart[]; action: 'Focus' | 'Output' | 'Review' | 'Usage' | null;
  sessionId?: SessionId; runId?: string; jobId?: string; address?: string; finishedAt?: number; machine?: string; approvals?: ApprovalSummary[];
}
export interface SessionFact { kind: 'live' | 'todos'; count: number; label: string }
export interface SessionFacts {
  id: SessionId; name: string; state: string; live: number; openTodos: number; facts: SessionFact[]; cost: string | null;
  todos: TodoSummary[]; moreTodos: number; triggers: { name: string; next: string }[];
}
export interface PanelExtras { machines?: NotificationItem[] }
export function panelSessionState(feed: SessionFeed, now: number): 'live' | 'closed' | 'disconnected';
export function projectSpiderPanel(feeds: readonly SessionFeed[]): SpiderPanelModel;
export function formatCredits(value: number): string;
export function relativeAge(ms: number): string;
export function selectedSpace(spaces: readonly { id: string; name?: string | null; active?: boolean }[] | null | undefined): PanelSpace | null;
export function projectPace(feeds: readonly SessionFeed[], now: number): PanelPace;
export function notificationText(item: NotificationItem): string;
export function projectFailedCommands(feeds: readonly SessionFeed[], now: number): NotificationItem[];
export function projectMachineProblems(configured: readonly { name?: unknown }[] | unknown, inventory: readonly { name?: unknown; state?: unknown; temporary?: unknown }[] | unknown): NotificationItem[];
export function projectNotifications(feeds: readonly SessionFeed[], pace: PanelPace, now: number, extra?: PanelExtras): NotificationItem[];
export function projectSessionFacts(feed: SessionFeed, now: number): SessionFacts;
export function projectSpacePanel(feeds: readonly SessionFeed[], space: PanelSpace | null, now: number, extra?: PanelExtras): { space: PanelSpace | null; pace: PanelPace; notifications: NotificationItem[]; sessions: (SessionFacts & { feed: SessionFeed })[] };
export interface PanelConfigProblem { title: string; text: string; fix: NotificationPart[]; then: string; detail: string }
export function panelConfigProblem(props: unknown): PanelConfigProblem | null;
export function doctorCommand(config: { nodePath: string; cliPath: string; configPath: string }): string;
export interface PanelError { source: string; message: string; scope?: 'feed' | 'sessions'; command?: string | null }
export interface PanelProblem { key: string; text: string; tip: string; command: string | null }
export function describePanelProblems(errors: readonly PanelError[], options?: { limit?: number }): { rows: PanelProblem[]; all: PanelProblem[]; more: number; sessions: { detail: string } | null };
export function describeFeedError(error: { source: string; message: string }): string;
