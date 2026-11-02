// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
export function panelSessionState(feed, now) {
  return feed.lifecycle === 'closed' ? 'closed' : now - feed.updatedAt > 10000 ? 'disconnected' : 'live';
}
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export function projectSpiderPanel(feeds) {
  const shared = new Map();
  for (const feed of feeds) for (const approval of feed.approvals) {
    if (approval.ownerSessionId === null) shared.set(JSON.stringify([approval.scope, approval.repoKey, approval.uuid]), approval);
  }
  const ordered = [...feeds].sort((a, b) => {
    if (!a.placement !== !b.placement) return a.placement ? -1 : 1;
    return (a.placement?.spaceOrder ?? Infinity) - (b.placement?.spaceOrder ?? Infinity)
      || compare(a.placement?.spaceId ?? '', b.placement?.spaceId ?? '') || compare(a.sessionId, b.sessionId);
  });
  const spaces = new Map();
  for (const feed of ordered) {
    const id = feed.placement?.spaceId ?? null;
    if (!spaces.has(id)) spaces.set(id, { id, name: feed.placement?.spaceName ?? null, sessionIds: [] });
    spaces.get(id).sessionIds.push(feed.sessionId);
  }
  return { sessions: ordered.map(feed => ({ id: feed.sessionId, feed })), spaces: [...spaces.values()], sharedApprovals: [...shared.values()] };
}

const FAILED_RUN_WINDOW = 24 * 3600000;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const nameOf = feed => feed.owner.name || feed.sessionId;

/** Thousands-separated whole credits; the mod runtime may lack Intl. */
export function formatCredits(value) {
  const whole = Math.round(value), sign = whole < 0 ? '-' : '';
  return sign + String(Math.abs(whole)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
export function relativeAge(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}
const pad = n => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function nextLabel(at, now) {
  if (at === null) return 'not scheduled';
  const date = new Date(at), time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return at - now < 86400000 ? `next ${time}` : `next ${MONTHS[date.getMonth()]} ${date.getDate()} ${time}`;
}

/** The shown Herdr space, from the app's spaces() list. */
export function selectedSpace(spaces) {
  const active = Array.isArray(spaces) ? spaces.find(space => space && space.active) : null;
  return active ? { id: active.id, name: active.name ?? null } : null;
}

/** One account-wide pace model from the newest reading; no bar without data. */
export function projectPace(feeds, now) {
  const readings = feeds.map(feed => feed.pace).filter(pace => pace.used !== null);
  if (!readings.length) {
    const reason = feeds.map(feed => feed.pace.unavailableReason).find(Boolean);
    return { state: 'unavailable', reason: reason ?? 'No usage data' };
  }
  const pace = readings.reduce((best, next) => (next.updatedAt ?? -1) > (best.updatedAt ?? -1) ? next : best);
  const clamp = value => Math.min(1, Math.max(0, value));
  // The dashboard's own strings when the feed has them; whole credits otherwise.
  const exact = value => value === null ? 'unavailable' : formatCredits(value);
  const labels = pace.labels ?? { month: null, usedCompact: exact(pace.used), used: exact(pace.used), projected: exact(pace.projected), budget: exact(pace.budget), remaining: exact(pace.remaining), updatedAt: null };
  const updated = pace.updatedAt === null ? null : relativeAge(now - pace.updatedAt);
  // Without a budget there is no scale: the bar draws no proportional fill.
  if (pace.budget === null || !(pace.budget > 0)) return { state: 'unscaled', used: pace.used, labels, updated };
  const span = pace.periodStart !== null && pace.periodEnd !== null && pace.periodEnd > pace.periodStart ? pace.periodEnd - pace.periodStart : null;
  return {
    state: 'ok', used: pace.used, projected: pace.projected, budget: pace.budget, labels, updated,
    usedFraction: clamp(pace.used / pace.budget),
    projectedFraction: pace.projected === null ? null : clamp(pace.projected / pace.budget),
    todayFraction: span === null ? null : clamp((now - pace.periodStart) / span),
    over: (pace.projected ?? pace.used) > pace.budget,
  };
}

const agent = (text, icon = 'session') => ({ type: 'agent', icon, text });
const words = text => ({ type: 'text', text });
const detail = text => ({ type: 'detail', text });
/** Plain text of an item's parts, for tooltips and accessibility labels. */
export function notificationText(item) { return item.parts.map(part => part.text).join(' '); }

/** Finished commands come from the feed, because Herdr only publishes live terminals to mods. */
export function projectFailedCommands(feeds, now) {
  const items = new Map();
  for (const feed of feeds) for (const notice of feed.notifications) {
    const job = notice.kind === 'job-result' && notice.sessionId === feed.sessionId ? notice.job : null;
    if (!job || ((job.exitCode === null || job.exitCode === 0) && job.signal === null) || now - job.finishedAt > FAILED_RUN_WINDOW) continue;
    const run = feed.runs.rows.find(r => r.id === job.runId);
    // "[agent] `command` failed on [machine]"; the output view shows the exit code.
    const parts = [run ? agent(run.name || run.id, 'subagent') : agent(nameOf(feed)), { type: 'command', text: job.commandPreview }, words('failed'), words('on'), { type: 'machine', text: job.machine }];
    items.set(job.id, { kind: 'failed', key: `job:${job.id}`, jobId: job.id, runId: job.runId ?? undefined, sessionId: feed.sessionId, address: job.address, finishedAt: job.finishedAt, parts, action: 'Output' });
  }
  return [...items.values()].sort((a, b) => b.finishedAt - a.finishedAt);
}

/**
 * Machine problems from the configured machines and Herdr's connection list:
 * a machine Herdr has never connected is unreachable; a known one that dropped
 * is disconnected.
 */
export function projectMachineProblems(configured, inventory) {
  if (!Array.isArray(configured) || !Array.isArray(inventory)) return [];
  return configured.flatMap(machine => {
    const name = machine?.name; if (typeof name !== 'string' || !name) return [];
    const native = inventory.find(row => row?.name === name);
    if (native?.temporary) return [];
    // Herdr's own state word ("stopped", "needs auth"); never connected to Herdr at all is unreachable.
    const state = !native ? 'unreachable' : native.state !== 'connected' ? String(native.state ?? 'disconnected').replace(/_/g, ' ') : null;
    return state ? [{ kind: 'machine', key: `machine:${name}`, machine: name, parts: [{ type: 'machine', text: name }, words(state)], action: null }] : [];
  });
}

/** What the user can act on, for the given sessions, in a fixed order of urgency. */
export function projectNotifications(feeds, pace, now, extra = {}) {
  const live = feeds.filter(feed => panelSessionState(feed, now) === 'live');
  const items = [];
  for (const feed of live) if (feed.status.effective === 'blocked')
    items.push({ kind: 'waiting', key: `waiting:${feed.sessionId}`, sessionId: feed.sessionId, parts: [agent(nameOf(feed)), words('is waiting')], action: 'Focus' });
  for (const feed of live) if (feed.status.effective === 'error')
    items.push({ kind: 'failed', key: `error:${feed.sessionId}`, sessionId: feed.sessionId, parts: [agent(nameOf(feed)), words('failed')], action: 'Focus' });
  items.push(...projectFailedCommands(feeds, now));
  for (const feed of feeds) for (const run of feed.runs.rows) {
    if (run.status !== 'failed' || run.finishedAt === null || now - run.finishedAt > FAILED_RUN_WINDOW) continue;
    items.push({ kind: 'failed', key: `run:${run.id}`, sessionId: feed.sessionId, runId: run.id, parts: [agent(run.name || run.id, 'subagent'), words('failed')], action: 'Output' });
  }
  items.push(...(extra.machines ?? []));
  const ids = new Set(feeds.map(feed => feed.sessionId)), owners = new Map(), shared = new Map();
  for (const feed of feeds) for (const approval of feed.approvals) {
    const key = JSON.stringify([approval.scope, approval.repoKey, approval.uuid]);
    if (approval.ownerSessionId === null) shared.set(key, approval);
    else if (ids.has(approval.ownerSessionId)) owners.set(key, approval);
  }
  const memories = owners.size + shared.size;
  if (memories)
    items.push({ kind: 'memory', key: 'memory', approvals: [...owners.values(), ...shared.values()], parts: [words(`${plural(memories, 'memory', 'memories')} to review`)], action: 'Review' });
  if (pace.state === 'ok' && pace.over)
    items.push({ kind: 'budget', key: 'budget', parts: [words('Over budget pace'), detail(`projected ${pace.labels.projected} of ${pace.labels.budget}`)], action: 'Usage' });
  return items;
}

/** One session row: its state glyph, compact facts and the expanded detail. */
export function projectSessionFacts(feed, now) {
  const lifecycle = panelSessionState(feed, now);
  const state = lifecycle === 'live' ? feed.status.effective ?? 'idle' : lifecycle;
  const live = feed.runs.rows.filter(run => ['running', 'queued', 'paused'].includes(run.status)).length;
  const open = feed.todos.rows.filter(todo => !todo.done);
  // Icon and count pairs in the row; the label is the tooltip.
  const facts = [live ? { kind: 'live', count: live, label: `${plural(live, 'live subagent')}` } : null,
    open.length ? { kind: 'todos', count: open.length, label: plural(open.length, 'open todo') } : null].filter(Boolean);
  return {
    id: feed.sessionId, name: nameOf(feed), state, live, openTodos: open.length, facts,
    // The dashboard's label for this session's credits this month; absent in older feeds.
    cost: feed.monthCost ? feed.monthCost.label : null,
    todos: open.slice(0, 5), moreTodos: Math.max(0, open.length - 5),
    triggers: feed.triggers.map(trigger => ({ name: trigger.name, next: nextLabel(trigger.nextAt, now) })),
  };
}

const PANEL_PATHS = ['feedRoot', 'cliPath', 'nodePath', 'configPath'];
const absolutePath = value => typeof value === 'string' && /^(\/|[A-Za-z]:[\\/])/.test(value) && !/[\u0000-\u001f]/.test(value) && !value.split(/[\\/]/).includes('..');

/**
 * Why the panel cannot start, or null when its layout props are usable. Setup
 * writes these props and doctor checks them, so the fix is the same each time.
 */
export function panelConfigProblem(props) {
  const given = props && typeof props === 'object' ? props : {};
  const missing = PANEL_PATHS.filter(key => given[key] === undefined || given[key] === null || given[key] === '');
  const invalid = PANEL_PATHS.filter(key => !missing.includes(key) && !absolutePath(given[key]));
  if (!missing.length && !invalid.length) return null;
  return {
    title: "Spider panel can't start",
    text: missing.length === PANEL_PATHS.length ? "The panel's layout entry has no spider settings." : "The panel's layout entry has paths spider can't use.",
    fix: [words('In pi, run'), { type: 'command', text: '/herdr-setup' }], then: 'Then run the doctor command it prints.',
    detail: [missing.length ? `Missing layout props: ${missing.join(', ')}.` : '', invalid.length ? `Not absolute paths in the layout props: ${invalid.join(', ')}.` : ''].filter(Boolean).join(' '),
  };
}

const shellWord = value => /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${String(value).replace(/'/g, `'\\''`)}'`;
/** The doctor command for this installation, quoted for a POSIX shell. */
export function doctorCommand(config) {
  return [config.nodePath, config.cliPath, 'doctor', '--config', config.configPath].map(shellWord).join(' ');
}

// What a failed action was, and why, in words.
const ACTIONS = {
  'Run view': "The run's output didn't open.", 'Job output': "The command's output didn't open.", 'View action': "The view didn't open in pi.",
  'Shared approvals': "Memory review didn't open.", 'Notification action': "The notice's action didn't run.",
};
const CAUSES = {
  'Owner endpoint unavailable': "Its pi session isn't reachable.", 'Owner unavailable': "Its pi session isn't reachable.",
  'No live approval endpoint': 'No live pi session can open it.', 'No live usage endpoint': 'No live pi session can open usage.',
  'Unknown notification': 'Spider no longer has that notice.', 'Action unavailable': 'The notice has no action.',
};
const RUNTIME = {
  'Feed watch': "Spider can't watch for session changes. It rereads the feeds every 8 seconds instead.",
  Notifications: "Spider couldn't post a Herdr notice.", 'Notification setup': "Spider can't post Herdr notices.",
  'Notification commands': 'Spider stopped listening for clicks on its notices.',
  Doctor: "Doctor didn't finish within 30 seconds. Run it in a shell for the full report.",
};
const feedCount = n => n === 1 ? 'a session feed' : `${n} session feeds`;
const FEED_CODES = {
  'unsafe-feed-path': n => `Spider skipped ${feedCount(n)} that ${n === 1 ? 'is a link or a special file' : 'are links or special files'}.`,
  'feed-too-large': n => `Spider skipped ${feedCount(n)} larger than 1 MB.`,
  'Unavailable: invalid feed': n => `Spider skipped ${feedCount(n)} it couldn't parse.`,
};
const TRUNCATED = /^Snapshot truncated/;

/**
 * The panel's runtime problems as one deduplicated list, in order of first
 * appearance. Failing to list the sessions at all is not a row; the Sessions
 * section reports it from `sessions`, with the technical reason.
 */
export function describePanelProblems(errors, options = {}) {
  const limit = options.limit ?? 3, groups = new Map();
  let sessions = null;
  for (const error of errors) {
    const message = String(error.message ?? '');
    if (error.scope === 'sessions' && !TRUNCATED.test(message)) { sessions ??= { detail: message }; continue; }
    if (error.scope === 'feed' || TRUNCATED.test(message)) {
      const kind = TRUNCATED.test(message) ? 'truncated' : FEED_CODES[message] ? message : 'unreadable', key = `feed:${kind}`;
      // One snapshot reports each feed once, so every entry is a feed.
      const group = groups.get(key) ?? { key, count: 0, tips: [] };
      group.count++; group.tips.push(`${error.source} (${message})`);
      const n = group.count;
      group.text = kind === 'truncated' ? 'Some older sessions are hidden because their feeds exceed what the panel reads at once.'
        : kind === 'unreadable' ? `Spider couldn't read ${feedCount(n)}.` : FEED_CODES[kind](n);
      groups.set(key, group); continue;
    }
    const text = ACTIONS[error.source] ? [ACTIONS[error.source], CAUSES[message]].filter(Boolean).join(' ') : RUNTIME[error.source] ?? `${error.source} failed.`;
    const key = `run:${text}`;
    if (!groups.has(key)) groups.set(key, { key, text, tips: [message], command: error.command ?? null });
  }
  const all = [...groups.values()].map(group => ({ key: group.key, text: group.text, tip: [...new Set(group.tips)].join('\n'), command: group.command ?? null }));
  return { rows: all.slice(0, limit), all, more: Math.max(0, all.length - limit), sessions };
}

const FEED_SOURCES = { jobs: "Spider can't read this session's commands.", placement: "Spider can't tell which space this session is in." };
/** A session feed's own error, as a sentence. */
export function describeFeedError(error) {
  return FEED_SOURCES[error.source] ?? (/[.!?]$/.test(error.message) ? error.message : `${error.message}.`);
}

/** The panel for the shown space; with no known space, every session. */
export function projectSpacePanel(feeds, space, now, extra = {}) {
  const ordered = projectSpiderPanel(feeds).sessions.map(row => row.feed);
  const mine = space ? ordered.filter(feed => !feed.placement || feed.placement.spaceId === space.id) : ordered;
  const pace = projectPace(feeds, now);
  return { space, pace, notifications: projectNotifications(mine, pace, now, extra), sessions: mine.map(feed => ({ ...projectSessionFacts(feed, now), feed })) };
}
