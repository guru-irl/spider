// SPDX-License-Identifier: MIT
import type { SessionFeed } from '../contracts.js';
export interface PanelCheckOptions { appBinary: string; appHome: string; feed: SessionFeed; }
export function checkSpiderPanel(options: PanelCheckOptions): Promise<{ stdout: string; stderr: string }>;
